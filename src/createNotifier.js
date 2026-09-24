/**
 * A notification wherever a job's Lock Screen indicator goes away and cannot come back. First
 * written for one job and then generalised; a job wraps it with its own words and any
 * notifications of its own.
 *
 * The product requirement: a notification wherever the indicator goes away, and tapping it
 * should do what is needed.
 *
 * ── When ───────────────────────────────────────────────────────────────
 * Exactly the case the Live Activity publisher cannot cover: the continued task's banner was
 * the indicator, the task ended or expired with the app away, and ActivityKit refuses to
 * start the app's own Live Activity from the background (`onBackgroundHandoffRefused`). Then, and only then:
 *
 *   - once per run and reason. The run and what it has already sent live in the store's kv
 *     (`namespace.dedupeKey`), so an iOS relaunch mid-run cannot send the same one twice; a new
 *     run (the continued banner taking over again) replaces them
 *   - never with the app in front — the job's own UI says it there
 *   - never asking for permission from the background; only sent if already granted. The ask
 *     happens in front, at the user's tap, the first time (`askInFront`)
 *   - passive: no sound, no lighting the screen with urgency. It is a status, not an alarm.
 *
 * ── Tap = do the needful ───────────────────────────────────────────────
 * Every tap lands on the job's screen (`open`), then by `action`:
 *
 *   resume  expired / stalled / parked: the user-started continue path — a foreground tap, so
 *           it may submit a new continued task (Apple's rule)
 *   paused  a guard (heat, Low Power Mode, charge) stopped it: continue only if the guard has
 *           since cleared; otherwise the job's UI says why
 *   review  done: the job's screen, at the top
 *   …       any other action the job registers (`onTap`)
 *
 * Cold start (`getLastNotificationResponseAsync`) and warm (`addNotificationResponseReceived-
 * Listener`) go through one handler, keyed on `data[namespace.dataKey]` so another feature's
 * listener never sees one of these, and a response is handled once whichever path reports it
 * first.
 *
 * ── Injected ──────────────────────────────────────────────────────────────────────────────
 *   Notifications   expo-notifications (the package imports no native module)
 *   appState()      the app's state now ('active' in front)
 *   copyFor(state)  the job's words for a state: {title, body, action, reason} | null
 *   stalledCopy()   the dead-man's words (a pause with no reason)
 *   describe(state) the state's fields for the `notif/send` log line
 *   debug, mark     the debug log and the memory trace
 */

/**
 * The namespace a job's notifications live in. `dataKey` marks a notification as the job's;
 * `deadmanId` is its dead-man's request id; `dedupeKey` is the kv row of its run dedupe:
 * `{run, sent: ['<reason>', ...], deadmanAt}` for the current run only. A new run overwrites
 * it, which is the whole of the clean-up. Pass your own; these neutral ones are the fallback.
 */
export const DEFAULT_NAMESPACE = Object.freeze({
  dataKey: 'expoContinuedTask',
  deadmanId: 'expo-continued-task-deadman',
  dedupeKey: 'expoContinuedTask.notify.dedupe',
});

/**
 * The dead-man's switch (added after a run on a real iPhone).
 *
 * The notifications above are sent by JS, and JS is exactly what iOS has frozen by the time a
 * continued task expires: the expiry reached JS only when the user opened the app, where
 * "never in front" suppressed it — and neither indicator was on screen. So while work runs
 * away from the screen (a continued task, or the grace grant), ONE notification is kept
 * scheduled `DEADMAN_SECONDS` in the future and pushed back on every sign of life. If the
 * signs stop — iOS froze us, expired the task, killed the process — the OS delivers it on its
 * own. A normal ending cancels it; so does coming back to the app.
 */
export const DEADMAN_SECONDS = 45;
/** Pushing it back costs a native call; once every few seconds is plenty against 45. */
export const DEADMAN_THROTTLE_MS = 5000;
/** The reason key the dead-man's notification occupies in the run's dedupe. */
export const STALLED = 'stalled';

/** The actions every job's taps understand; a job adds its own with `onTap`. */
export const NOTIFY_ACTIONS = Object.freeze({
  RESUME: 'resume',
  PAUSED: 'paused',
  REVIEW: 'review',
});

/**
 * @param {Object} deps
 * @param {Object} [deps.Notifications] expo-notifications; a fake in tests
 * @param {() => string} deps.appState
 * @param {(label: string, extra?: Object) => void} [deps.mark]
 */
export function createNotifier({
  Notifications = null,
  appState,
  mark = () => {},
  /**
   * `{kvGet, kvSet}` — the app's key-value store. Where the dedupe survives a relaunch. Without
   * one (or with a store that is not open yet) the dedupe is this process's memory, as before.
   */
  store = null,
  now = Date.now,
  namespace = DEFAULT_NAMESPACE,
  copyFor,
  stalledCopy,
  describe = () => ({}),
  debug = () => {},
  /** Extra tap actions: `{[action]: (data, {id, actions}) => Promise|void}`. */
  onTap = {},
}) {
  const { dataKey, deadmanId, dedupeKey } = namespace;
  /** The current run, and the reasons already sent in it. Loaded from `store` once. */
  let run = 0;
  let sent = new Set();
  /**
   * When the dead-man's notification was last (re)scheduled, or null when none is pending.
   * Persisted: if it is still set and its time has passed, the OS delivered it.
   */
  let deadmanAt = null;
  let lastFedMarkAt = -Infinity;
  let loaded = null;
  /** Serialises run changes and sends, so a begin and a refusal cannot interleave. */
  let queue = Promise.resolve();
  /** Notification request ids already acted on, cold and warm alike. */
  const handled = new Set();

  function note(label, extra) {
    try { mark(label, extra); } catch (e) { /* a trace is never worth a failure */ }
  }

  function serially(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  async function load() {
    if (!loaded) {
      loaded = (async () => {
        try {
          const raw = await store?.kvGet?.(dedupeKey);
          const saved = raw ? JSON.parse(raw) : null;
          if (saved && Number.isFinite(saved.run)) {
            run = saved.run;
            sent = new Set(Array.isArray(saved.sent) ? saved.sent : []);
            deadmanAt = Number.isFinite(saved.deadmanAt) ? saved.deadmanAt : null;
          }
        } catch (e) {
          // A store that is not open yet: this process's memory is the dedupe.
        }
      })();
    }
    return loaded;
  }

  async function save() {
    try {
      await store?.kvSet?.(dedupeKey, JSON.stringify({ run, sent: Array.from(sent), deadmanAt }));
    } catch (e) {
      // Memory still holds it for this process.
    }
  }

  /**
   * A new run: the continued banner took over again (the publisher's `onHandoverBegan`). The
   * last run's sent reasons are dropped with it.
   */
  function beginRun() {
    return serially(async () => {
      await load();
      await settleDeadman();
      run += 1;
      sent = new Set();
      await save();
      return run;
    });
  }

  /**
   * Is a dead-man's notification pending, or did the OS already deliver it? Delivered counts as
   * this run's `stalled` notification; pending is cancelled. Either way none is left behind.
   * Runs inside `serially`.
   */
  async function settleDeadman() {
    if (deadmanAt == null) return 'none';
    const fired = now() >= deadmanAt + DEADMAN_SECONDS * 1000;
    deadmanAt = null;
    if (fired) {
      sent.add(STALLED);
      note('notify.deadman_fired', null);
      debug('notif', 'deadman.delivered', { id: deadmanId, run });
    } else {
      try { await Notifications?.cancelScheduledNotificationAsync?.(deadmanId); } catch (e) { /* gone already */ }
      debug('notif', 'cancel', { id: deadmanId, run, why: 'deadman_settled' });
    }
    await save();
    return fired ? 'fired' : 'cancelled';
  }

  /**
   * A sign of life while work runs away from the screen: (re)schedule the dead-man's
   * notification `DEADMAN_SECONDS` out. Throttled; never in front; never without permission;
   * never once this run's `stalled` notification has gone.
   */
  function feedDeadman() {
    if (appState() === 'active') return Promise.resolve('foreground');
    if (deadmanAt != null && now() - deadmanAt < DEADMAN_THROTTLE_MS) {
      return Promise.resolve('throttled');
    }
    return serially(() => armDeadman()).then((result) => {
      if (result !== 'armed') debug('notif', 'deadman', { result, run });
      return result;
    });
  }

  function armDeadman() {
    return (async () => {
      await load();
      if (deadmanAt != null && now() >= deadmanAt + DEADMAN_SECONDS * 1000) {
        // It fired while we were frozen; we are only now hearing about it.
        await settleDeadman();
      }
      if (sent.has(STALLED)) return 'dedupe';
      if (!(await granted())) return 'no_permission';
      const body = stalledCopy();
      const trigger = { type: 'timeInterval', seconds: DEADMAN_SECONDS, repeats: false };
      try {
        // The same identifier replaces the pending one: rescheduling is one native call.
        await Notifications.scheduleNotificationAsync({
          identifier: deadmanId,
          content: {
            title: body.title,
            body: body.body,
            data: {
              [dataKey]: true, action: NOTIFY_ACTIONS.RESUME, runId: run, reason: STALLED,
            },
            sound: false,
            interruptionLevel: 'passive',
          },
          trigger,
        });
      } catch (e) {
        debug('notif', 'schedule', {
          id: deadmanId, result: 'failed', error: e?.message || String(e), title: body.title, body: body.body, trigger, run,
        });
        return 'failed';
      }
      const first = deadmanAt == null;
      debug('notif', 'schedule', {
        id: deadmanId, result: first ? 'armed' : 'fed', title: body.title, body: body.body, trigger, run,
      });
      deadmanAt = now();
      await save();
      if (first) note('notify.deadman_armed', null);
      // A feed a minute in the trace: in one run in testing the switch fired at 45 s with no
      // way to say whether it was being fed at all.
      else if (now() - lastFedMarkAt >= 60000) {
        lastFedMarkAt = now();
        note('notify.deadman_fed', null);
      }
      return 'armed';
    })();
  }

  /** Work ended normally, or the app is back in front: no dead-man's notification is owed. */
  function disarmDeadman() {
    return serially(async () => {
      await load();
      return settleDeadman();
    });
  }

  async function granted() {
    try {
      const perms = await Notifications?.getPermissionsAsync?.();
      return perms?.status === 'granted' || perms?.granted === true;
    } catch (e) {
      return false;
    }
  }

  /**
   * The publisher's `onBackgroundHandoffRefused`. Resolves with what happened, for the trace
   * and the tests: 'sent' | 'foreground' | 'nothing' | 'dedupe' | 'no_permission' | 'failed'.
   */
  function notify(state = {}) {
    return send(state).then((out) => {
      debug('notif', 'send', {
        ...describe(state), run, ...out,
      });
      return out.result;
    });
  }

  /** `notify`, with what it decided and said: `{result, id, title, body, action, reason, trigger}`. */
  function send(state) {
    const { pauseReason = null } = state;
    if (appState() === 'active') return Promise.resolve({ result: 'foreground', reason: pauseReason });
    const next = copyFor(state);
    if (!next) return Promise.resolve({ result: 'nothing', reason: pauseReason });
    const said = {
      title: next.title, body: next.body, action: next.action, reason: next.reason, trigger: null,
    };
    // One at a time, so two refusals in one tick cannot both send.
    return serially(async () => {
      await load();
      // The reason notification replaces the dead-man's — unless the OS already delivered
      // that one, in which case it WAS this run's pause notice and a second would double it.
      await settleDeadman();
      if (sent.has(next.reason)) return { result: 'dedupe', ...said };
      if (sent.has(STALLED) && next.action !== NOTIFY_ACTIONS.REVIEW) return { result: 'dedupe', why: 'stalled_sent', ...said };
      if (!(await granted())) return { result: 'no_permission', ...said };
      // Claimed, and written down, BEFORE the send: a relaunch between the two must not send
      // again, and a lost notification is the smaller harm than a doubled one.
      sent.add(next.reason);
      await save();
      let id = null;
      try {
        id = await Notifications.scheduleNotificationAsync({
          content: {
            title: next.title,
            body: next.body,
            data: { [dataKey]: true, action: next.action, runId: run, reason: next.reason },
            sound: false,
            interruptionLevel: 'passive',
          },
          trigger: null,
        });
      } catch (e) {
        sent.delete(next.reason);
        await save();
        return { result: 'failed', error: e?.message || String(e), ...said };
      }
      note('notify.sent', { action: next.action, reason: next.reason });
      return { result: 'sent', id: id ?? null, ...said };
    });
  }

  /**
   * Ask for permission, in front, at a user's tap — the first time only. The OS remembers the
   * answer, so "not asked yet" is `undetermined` and nothing of our own is stored.
   */
  async function askInFront() {
    if (appState() !== 'active') return false;
    try {
      const perms = await Notifications?.getPermissionsAsync?.();
      if (perms?.status !== 'undetermined' || perms?.canAskAgain === false) return perms?.status === 'granted';
      const answer = await Notifications.requestPermissionsAsync();
      return answer?.status === 'granted';
    } catch (e) {
      return false;
    }
  }

  /**
   * Act on a tap. Returns true when it was ours.
   *
   * @param {Object} response  an expo-notifications NotificationResponse
   * @param {Object} actions
   * @param {() => void|Promise} actions.open       navigate to the job's screen
   * @param {() => void} actions.top               scroll it to the top
   * @param {() => void|Promise} actions.resume     the user-started continue path
   * @param {() => boolean} actions.canResume       may work start right now? (the guards)
   * @param {() => Promise<boolean>} [actions.ready] the app has finished launching; nothing
   *   starts before it, and nothing starts if it says false
   *   (and whatever a job's own `onTap` actions read)
   */
  async function handleResponse(response, actions) {
    const {
      open, top, resume, canResume, ready,
    } = actions;
    const request = response?.notification?.request;
    const data = request?.content?.data;
    if (!data?.[dataKey]) return false;
    const id = request?.identifier || `${data.runId}:${data.reason}`;
    if (handled.has(id)) return true;
    handled.add(id);
    note('notify.tap', { action: data.action || null });
    debug('notif', 'tap', {
      id, action: data.action || null, reason: data.reason || null, runId: data.runId ?? null, appState: appState(),
    });
    try { await open?.(); } catch (e) { /* the tap still lands somewhere */ }
    const own = Object.prototype.hasOwnProperty.call(onTap, data.action) ? onTap[data.action] : null;
    if (own) {
      await own(data, { id, actions });
      return true;
    }
    if (data.action === NOTIFY_ACTIONS.REVIEW) {
      try { top?.(); } catch (e) { /* cosmetic */ }
      return true;
    }
    if (data.action === NOTIFY_ACTIONS.RESUME || data.action === NOTIFY_ACTIONS.PAUSED) {
      // A cold-start tap is handled before the app has finished launching. Wait
      // for it; the guards and "is it already running" only mean anything after.
      let settled = true;
      try { settled = ready ? (await ready()) !== false : true; } catch (e) { settled = false; }
      if (!settled) {
        debug('notif', 'tap.result', { id, settled: false, may: false, resumed: false });
        return true;
      }
      let may = false;
      try { may = canResume?.() !== false; } catch (e) { may = false; }
      let resumed = false;
      let error = null;
      if (may) {
        try {
          await resume?.();
          resumed = true;
        } catch (e) {
          // The job's screen shows why.
          error = e?.message || String(e);
        }
      }
      debug('notif', 'tap.result', { id, settled: true, may, resumed, error });
    } else {
      debug('notif', 'tap.result', { id, opened: true });
    }
    return true;
  }

  /**
   * Listen for taps: the one that launched the app, and every one after. Returns the
   * unsubscribe.
   */
  function listen(actions) {
    let alive = true;
    let sub = null;
    try {
      sub = Notifications?.addNotificationResponseReceivedListener?.((response) => {
        if (alive) handleResponse(response, actions);
      }) || null;
    } catch (e) {
      sub = null;
    }
    Promise.resolve()
      .then(() => Notifications?.getLastNotificationResponseAsync?.())
      .then((response) => {
        if (alive && response) handleResponse(response, actions);
      })
      .catch(() => {});
    return () => {
      alive = false;
      try { sub?.remove?.(); } catch (e) { /* already gone */ }
    };
  }

  return {
    notify,
    beginRun,
    feedDeadman,
    disarmDeadman,
    askInFront,
    handleResponse,
    listen,
    /** For a job's own notifications: the same queue, the same permission check, the same trace. */
    serially,
    granted,
    note,
  };
}

export default createNotifier;
