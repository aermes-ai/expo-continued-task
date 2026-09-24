/**
 * The ONE place a job's Live Activity is told anything (first written for an app's own Live
 * Activity, then generalised: the job supplies its vocabulary and wires its state in through
 * connectIndicator).
 *
 *   const live = connectIndicator({ publisher, sources, subscribeAppState });
 *   ...
 *   live.disconnect();
 *
 * ── Why it is not driven by React ──────────────────────────────────────
 * The hook used to compute the bar from props, so every change reached
 * ActivityKit only after a render. In the foreground that is invisible. On the
 * way into the background it is the whole bug: a window ends, the job says
 * "done", and the render that would have ended the bar is exactly what a
 * process iOS is suspending never gets to — the bar outlived its work, showing
 * "Working" over nothing. A job whose state setter notifies its listeners
 * synchronously lets a publisher subscribed to it hear every
 * transition on the path that caused it: a window's ending is on the Lock
 * Screen before the window hands the CPU back.
 *
 * Three things trigger a publish — a job transition, an AppState change,
 * a window settling — and all of them go through `publish()`, which computes
 * the model, compares it with what ActivityKit already holds, and makes at most
 * one call. Nothing else in the app calls start/update/end.
 *
 * ── Starting ───────────────────────────────────────────────────────────
 * ActivityKit rejects `Activity.request` from the background, so a bar is
 * started in the foreground the moment a read or work pass is running; iOS then
 * keeps it on the Lock Screen and in the Dynamic Island after the user leaves.
 * Live Activities have no system permission sheet: if the user has turned them
 * off for the app we ask once and send them to Settings. A missing native module
 * is a no-op (OTA onto an older binary).
 *
 * ── An activity outlives the session that started it ──────────────────
 * iOS keeps a Live Activity after the app is swipe-killed or jetsammed, and
 * no cleanup runs for either, so the next session cannot answer "is that one
 * mine?" from `last`. The first idle publish of a session ends whatever is up
 * there, the app's own or inherited (`swept`). After that `last` is accurate.
 *
 * Except when a window is about to decide: a background launch into
 * a processing window connects before the window is claimed, and the first publish
 * sees a resting job. Sweeping then would end the one bar ActivityKit still
 * lets a window update. So while `processingWindow.pending()` the sweep waits; a
 * window that works adopts the bar (native `start` updates
 * `activities.first`), and one that does nothing settles, and the sweep runs
 * then — before the window is handed back.
 *
 * ── Parking ────────────────────────────────────────────────────────────
 * On the way into the background, whatever the FOREGROUND owns is about to park
 * at its next boundary: a read or a work pass. The job
 * says who owns each run (its `parking` answer), so a read a window or
 * a continued-processing task is carrying on stays live, and only foreground
 * work is shown as paused — before the job has had the chance to say so.
 *
 * ── One indicator on the Lock Screen ───────────────────────────────────
 * A user-started job runs under Apple's continued-processing task, and that
 * task has a progress banner of its own. An early build put the app's own Live
 * Activity directly above it — two bars for one piece of work. So while that
 * banner is up (the task pending or running), it IS the indicator: the app's is
 * ended, or never started. When the task ends, the app's takes over in the same
 * publish, and only for what Apple's cannot say — paused with a reason, a
 * window working, and done, briefly. The adapter says when its banner comes
 * and goes (`continuedShowing` / `subscribeContinued`), keyed on the task's
 * state and never on the success flag it ended with.
 *
 * A pause still only continues a bar — except as that take-over: Apple's
 * banner was the bar a moment ago, and the pause is its continuation.
 *
 * ── A way back, always ─────────────────────────────────────────────────
 * "The activity goes away sometimes and there's no way to get it back." The
 * continued task ended in the BACKGROUND, where ActivityKit refuses a request;
 * the app's take-over never reached the Lock Screen, but `last` said it had, and
 * every publish after that was deduped against a bar that did not exist. So:
 *
 *   - From the background we never ask for a NEW activity. We `update`, which
 *     feeds a surviving one (a window adopting its bar) and is a
 *     no-op otherwise. A bar owed there that cannot be started is handed to
 *     `onBackgroundHandoffRefused` — the hook for a notification the app
 *     may choose to send — and nothing else.
 *   - In the foreground, a bar we do not believe in is written with `start`,
 *     which natively updates the live activity or requests one if there is
 *     none. And on the way back in (`resync`, also at mount) `last` is
 *     forgotten: what we believed while away is not evidence. So whenever the
 *     app is in front and work is owed — reading, working, or paused with a
 *     reason — there IS a bar, whatever happened to the last one.
 *   - "A pause never starts a bar" now holds in the background only. In front,
 *     a paused pass with a reason is work the user is owed a sight of.
 *
 * Every decision leaves a memoryTrace mark (`la.request`, `la.update`,
 * `la.end`, `la.suppressed`, `la.request_failed`), so the next report is
 * provable from the device instead of argued about.
 */
/** `false` is off. Anything else (on, or an older binary) is not an ask. */
export function liveActivitiesOff(Live) {
  try {
    if (typeof Live?.isEnabled !== 'function') return false;
    return Live.isEnabled() === false;
  } catch (e) {
    return false;
  }
}

/** How long the done line ("151 found") stays up after the continued task hands over. */
export const DONE_BEAT_MS = 4000;

/** A window the scheduler has not finished with. Anything unreadable is not one. */
export function windowPending(processingWindow) {
  try {
    return typeof processingWindow?.pending === 'function' && processingWindow.pending() === true;
  } catch (e) {
    return false;
  }
}

/**
 * @param {Object} deps
 * @param {() => Object} deps.read  the model's inputs: the job's state, e.g. {progress, power, pauseReason}
 * @param {() => ({pending: Function, subscribe: Function}|null)} [deps.processingWindow]
 *   the background processing window the scheduler has not finished with, if any
 * @param {Object} [deps.Live]  the Live Activity module surface (the app's Live Activity module)
 * @param {() => string} deps.appState
 */
export function createIndicatorPublisher({
  read,
  processingWindow = () => null,
  Live = null,
  appState,
  prompt = () => {},
  /** Is the continued task's own banner on screen? Then it is the one indicator. */
  systemShowing = () => false,
  /** The App Group file name of the item in hand's thumbnail, or null. */
  thumb = () => null,
  /** memoryTrace, injectable for tests. */
  mark = () => {},
  /**
   * A bar is owed after the continued task handed over, but the app is in the background
   * and ActivityKit will not start one there. A no-op by default: an app may send a
   * one-time quiet local notification for exactly this case.
   */
  onBackgroundHandoffRefused = () => {},
  /** The continued banner took over: a new job run begins (the notifier's dedupe). */
  onHandoverBegan = () => {},
  /** Every publish while the continued banner shows is a sign of life (the dead-man's switch). */
  onSystemProgress = () => {},
  /** The continued banner went away: whatever it was guarding has an ending now. */
  onSystemGone = () => {},
  /**
   * Is work still owed — read unfinished, or items left to process? The done beat is
   * only for a job that is done; absent, every hand-over may end in one, as before.
   */
  owed = () => false,
  /** Is a read or a work pass running (or committed to) right now? */
  running = () => false,
  /**
   * The job's vocabulary, supplied by the app:
   *   model(input)            the bar for the pipeline's state, or null
   *   payload(next, extras)   the content state ActivityKit is handed
   *   donePayload(input)      the take-over's "N found"
   *   samePayload(a, b)       would ActivityKit be told anything new?
   *   payloadFields(payload)  the content state, flat, for the debug log
   *   passing(input)          the pipeline says a pass is running or committed to
   *   isFound(input)          the pipeline says it is done
   *   parking(input, current, window)  the app is leaving work behind that is about to park
   *   describe(input)         the input's fields for the `la/publish` log line
   *   handoffState(input)     the state the refused-hand-off hook is told
   */
  model,
  payload: payloadOf,
  donePayload,
  samePayload,
  payloadFields,
  passing,
  isFound,
  parking: parkingNow,
  describe,
  handoffState,
  debug: debugLog = () => {},
  isDebugLogEnabled = () => false,
}) {
  /** The payload ActivityKit holds, if this session put it there. */
  let last = null;
  let asked = false;
  let swept = false;
  /** Unsubscribe from the window's settle while a sweep is waiting on it. */
  let holding = null;
  /**
   * The system banner stood the app's bar down and has not been taken over from yet. While it holds,
   * the next thing worth saying may START a bar, pause and done included.
   */
  let handover = false;
  /** The done beat's timer, while "N found" is up. */
  let doneTimer = null;
  /** The last suppression noted, so a stream of identical ones is one mark. */
  let lastSuppressed = null;
  /** The debug gate the widget was last told, or null before the first. */
  let gatePushed = null;

  /**
   * The widget extension cannot read the JS log's gate; it reads an App Group flag (a test
   * build wrote no widget debug log without it). Written from here, where the Live Activity is
   * fed, with the gate the JS log is actually running with — any stored override included — and
   * again whenever it changes.
   */
  function pushDebugGate() {
    if (typeof Live?.setDebugLogGate !== 'function') return;
    const on = isDebugLogEnabled();
    if (on === gatePushed) return;
    try {
      Live.setDebugLogGate(on);
      gatePushed = on;
      debugLog('la', 'gate.push', { on });
    } catch (e) {
      debugLog('la', 'gate.push_failed', { on, error: e?.message || String(e) });
    }
  }

  function note(label, extra = null) {
    try { mark(label, extra); } catch (e) { /* a trace is never worth a failure */ }
  }

  function suppressed(why) {
    // Every one, in a test build: the trace keeps one mark per run of them.
    debugLog('la', 'suppressed', { why, repeat: lastSuppressed === why });
    if (lastSuppressed === why) return;
    lastSuppressed = why;
    note('la.suppressed', { why });
  }

  /** Which continued-task run this is: one per time the system banner takes over. */
  let runSeq = 0;
  /** `onSystemGone` has been said for the banner that last went away. */
  let systemGoneTold = true;

  function refusedHandover(input) {
    suppressed('background_cannot_start');
    try {
      onBackgroundHandoffRefused({
        runId: runSeq,
        ...handoffState(input),
        // So the notifier never says "review" over a job that is not done.
        owed: isOwed(),
      });
    } catch (e) { /* hook only */ }
  }

  function clearDone() {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = null;
  }

  function thumbName() {
    try {
      return thumb() || null;
    } catch (e) {
      return null;
    }
  }

  /** "151 found", briefly, then gone. The hand-over's ending, and the dev stage's. */
  function showDone(input, current = appState()) {
    if (liveActivitiesOff(Live)) return;
    if (current === 'background' && !last) {
      refusedHandover(input);
      return;
    }
    const payload = payloadOf(donePayload(input), { thumb: thumbName(), kind: 'done' });
    if (show(payload, current, 'done')) {
      clearDone();
      doneTimer = setTimeout(() => {
        doneTimer = null;
        end('done_beat');
      }, DONE_BEAT_MS);
    }
  }

  /**
   * Work is owed and a pass is live: the one state in which the app's bar must not be ended.
   *
   * A model may have no bar for a work pass that has not counted an item yet — deliberately: a
   * Live Activity earns the space with a number. But "do not start one" is not
   * "end the one that is up". A read handing to a work pass, or a work pass starting under a
   * read, is exactly that moment, and on one test build it ended the bar twice in one launch
   * while a tester watched; the first chunk's counter would have been along in a second or two.
   * `passing(input)` counts as live because a job should only report a running phase for a pass
   * it has running or has committed to.
   */
  function holdWhileOwed(input) {
    if (!last || !isOwed()) return false;
    let live = false;
    try {
      live = running() === true;
    } catch (e) {
      live = false;
    }
    return live || passing(input);
  }

  function isOwed() {
    try {
      return owed() === true;
    } catch (e) {
      return false;
    }
  }

  function isSystemShowing() {
    try {
      return systemShowing() === true;
    } catch (e) {
      return false;
    }
  }

  function end(why = 'nothing_running') {
    clearDone();
    note('la.end', { why });
    debugLog('la', 'end', { why, live: !!last });
    try { Live?.end?.(); } catch (e) {
      // The native side ends it on its own staleDate.
      debugLog('la', 'end_failed', { why, error: e?.message || String(e) });
    }
    last = null;
  }

  /**
   * Write the bar. In front with no bar we believe in: `start`, which natively updates the
   * live activity or requests one. Otherwise `update`, which feeds a live bar and never asks
   * ActivityKit for one — the only thing that can be asked from the background. False if the
   * call threw.
   *
   * There is no native "is one live?" query in older binaries (JS can ship over the air), so
   * the belief in `last` is re-checked the one way ActivityKit allows: `resync` forgets it on
   * every return to the app, and the `start` that follows adopts or requests.
   */
  function show(payload, current = appState(), kind = 'running') {
    const away = current === 'background';
    const requesting = !away && !last;
    try {
      if (requesting) Live?.start?.(payload);
      else Live?.update?.(payload);
    } catch (e) {
      note(requesting ? 'la.request_failed' : 'la.update_failed', { error: e?.message || String(e) });
      debugLog('la', requesting ? 'request_failed' : 'update_failed', {
        kind, background: away, error: e?.message || String(e), ...payloadFields(payload),
      });
      return false;
    }
    // The whole content-state, as ActivityKit was handed it.
    debugLog('la', requesting ? 'request' : 'update', { kind, background: away, ...payloadFields(payload) });
    lastSuppressed = null;
    if (requesting) note('la.request', { state: kind });
    else note('la.update', away ? { background: true } : null);
    last = payload;
    return true;
  }

  /**
   * Back in front: forget what we believed while away. The next write is a
   * `start`, which requests a bar if the last one is gone.
   */
  function resync() {
    last = null;
    lastSuppressed = null;
  }

  /**
   * Bring the Lock Screen into line with the pipeline. Synchronous; at most one native call.
   *
   * @param {string} [current] the AppState this publish is for, when a change event knows it
   */
  function publish(current = appState()) {
    pushDebugGate();
    const window = processingWindow();
    let input;
    try {
      input = read() || {};
    } catch (e) {
      debugLog('la', 'read_failed', { error: e?.message || String(e) });
      return;
    }
    debugLog('la', 'publish', {
      appState: current,
      ...describe(input),
      away: current === 'background',
      live: !!last,
      handover,
      window: window ? { active: !!window.active, expired: !!window.expired } : null,
    });
    // The continued task's banner is up: it is the indicator, and the app's stands down on this
    // very transition (see the header).
    if (isSystemShowing()) {
      if (last) end('continued_showing');
      clearDone();
      systemGoneTold = false;
      if (!handover) {
        runSeq += 1;
        // A new job run: whoever counts runs across relaunches is told.
        try { onHandoverBegan(); } catch (e) { /* hook only */ }
      }
      try { onSystemProgress(current); } catch (e) { /* hook only */ }
      handover = true;
      swept = true;
      suppressed('continued_showing');
      return;
    }
    if (handover && !systemGoneTold) {
      systemGoneTold = true;
      try { onSystemGone(); } catch (e) { /* hook only */ }
    }
    const away = current === 'background';
    const parking = parkingNow(input, current, window);
    let next = model({ ...input, parking });
    // A pause continues a bar; in the BACKGROUND it never starts one (see the header).
    // In front it may: a pass paused with a reason is work the user is owed a sight of — and
    // it cannot be a request from the background, which is the case the rule protects.
    if (next?.paused && !last && away) {
      if (handover) {
        handover = false;
        refusedHandover(input);
      } else {
        suppressed('pause_never_starts');
      }
      // Nothing of the app's to pause — but a leftover this session has not swept is still swept
      // below, exactly as before.
      next = null;
    }
    if (!next && doneTimer) return;
    // "N found" only when nothing is owed. An expired task hands over exactly like a
    // finished one, and one device run said done at 23 % processed.
    if (!next && handover && isFound(input) && away && isOwed()) {
      // The task ended with work owed, away, and there is no bar of the app's to say so: the
      // notifier says it instead — as a parked pass, never as "found".
      handover = false;
      refusedHandover(input);
    }
    if (!next && handover && isFound(input) && !isOwed()) {
      handover = false;
      showDone(input, current);
      return;
    }
    if (!next) {
      handover = false;
      if (!last && !swept && windowPending(window)) {
        // A leftover, and a window about to decide whether it is still wanted — see the
        // header. Wait for the window rather than end the bar it may be about to feed.
        if (!holding && typeof window?.subscribe === 'function') {
          holding = window.subscribe(() => {
            holding?.();
            holding = null;
            publish();
          });
        }
        return;
      }
      // A live pass with work owed keeps the bar it has until it has a number to put in it.
      if (holdWhileOwed(input)) {
        swept = true;
        suppressed('held_while_owed');
        return;
      }
      // The app's own, or a leftover this session has not swept yet — see the header.
      if (last || !swept) end(last ? 'nothing_running' : 'leftover');
      swept = true;
      return;
    }
    if (liveActivitiesOff(Live)) {
      debugLog('la', 'off', { asked, appState: current });
      if (!asked && current === 'active') {
        asked = true;
        prompt();
      }
      return;
    }
    if (away && !last && handover) {
      // The task handed over while we were away and there is no bar of the app's to feed.
      handover = false;
      refusedHandover(input);
      return;
    }
    handover = false;
    clearDone();
    const kind = next.paused ? 'paused' : 'running';
    const payload = payloadOf(next, { thumb: thumbName(), kind });
    // Most triggers change nothing the Lock Screen shows.
    if (samePayload(payload, last)) {
      suppressed('dedupe');
      return;
    }
    show(payload, current, kind);
  }

  /** Stop listening, and take down a bar this session put up. */
  function dispose() {
    holding?.();
    holding = null;
    clearDone();
    if (last) end('dispose');
  }

  return {
    publish,
    dispose,
    resync,
    showDone: () => {
      try { showDone(read() || {}); } catch (e) { /* dev staging only */ }
    },
    __last: () => last,
  };
}

export default createIndicatorPublisher;
