/**
 * A job's BGContinuedProcessingTask (iOS 26+), as the job sees it. It was first written for one
 * long job and then generalised so any job can wrap it.
 *
 * Without it, a minimise spends only the ~30 s grace grant on the work: a few pages, not a
 * whole library. iOS 26 has a task built for exactly this case: work the user started in the
 * foreground keeps running after they leave, with a system progress UI they can watch or
 * cancel. This is a job's handle on it:
 *
 *   begin        a USER-started job submits the task (Apple's rule: from a user action, with
 *                the app in front). Never awaited by the work — it must not wait on the main
 *                queue for a system UI.
 *   report       done / total per committed unit, onto the system UI (the job's wrapper maps its
 *                phases onto one bar, `createBar`).
 *   isRunning    the work's boundary question while minimised: true only while iOS is actually
 *                running the task. Expiry, a user cancel from the system UI, a refused
 *                submission or a missing native function all make it false, and the work falls
 *                through to the grace-grant check — which is what parks it at a boundary.
 *   end          the work finished or parked. Always called, and always reaches native even if
 *                the submission has not answered yet, so no task is ever left running.
 *
 * With no native support (iOS < 26, or an older binary running this bundle over OTA) every
 * call is a no-op and `isRunning()` is false: the behaviour is the grace grant's, exactly.
 *
 * ── One task, many phases ──────────────────────────────────────────────────────────────────
 *
 * The same task carries every phase of a job, so the user sees ONE banner. Its title names the
 * phase, because iOS cuts the subtitle at ~32 characters: `say` retitles the banner when the
 * phase moves on, on a binary that can retitle; one that cannot keeps its first title
 * and the subtitle names the phase. One `Progress` spans all phases: see costBar.js for why it
 * is weighed by cost and never banded. The fraction is still clamped to never go backwards,
 * whatever the counts do.
 *
 * ── A lifecycle in the memory trace ────────────────────────────────────────────────────────
 *
 * A build in testing showed Apple's banner saying the task failed, and nothing in the app could say
 * when or why. So each step leaves a `continued.<event>` mark: submitted / refused, launched and
 * expired (the first time the job SEES iOS report them — it cannot be told), progress_first,
 * ended. The native side writes the same lifecycle to its JSONL log file as it happens.
 *
 * ── Success means "nothing went wrong", not "all done" ──────────────────────────────────────
 *
 * A stop on purpose — a guard, a park, background processing windows taking over — ends the
 * task as a success, titled "Paused" (or the guard's "Paused · iPhone is warm") over "Tap Resume in the app", and a
 * finished one says what it did. A real error ends it exactly like a park (the product
 * requirement: the user must never see "Failed"): the job has already parked on it for Resume,
 * and the cause goes to the debug log and the trace, not the system UI. An expiry is iOS's, and native
 * presents that one as paused itself. No path here ever tells native `false`.
 *
 * ── Injected ──────────────────────────────────────────────────────────────────────────────
 *
 *   bg        the native bridge's surface, native.js (required: this file imports no native code)
 *   copy      { title(phase), line({phase, done, total, ...context, titled}),
 *               pausedTitle(reason), pausedLine(reason, {titled}), pausedGeneric({titled}),
 *               doneLine(context) } — the banner's words
 *   context() fields the job's lines lead with (e.g. `{items}`), spread into every line
 *             and into the `copy/banner` log line
 *   createBar({phase, follows, now}) → a bar with fraction/remainingMs/costs (costBar.js)
 *   debug(cat, ev, fields)   the debug log
 *   mark(label, extra)       the memory trace
 *   completeTask()           the native completion — `bg.endContinuedTask(true)`, never false
 *   phases    {main, followUp}: the job's phase names (default DEFAULT_PHASES, 'main'/'followUp')
 */

import { DEFAULT_PHASES } from './rules';

/** The one bar's resolution: a 24k-unit phase moves it every ~24 units, a 151-unit one every unit. */
export const BAR_UNITS = 100000;

/**
 * How often a moving bar also tells the listeners. The dead-man's switch is fed by the
 * publisher, and the publisher runs on the job's own publishes and on these; a phase whose
 * per-unit progress publishes nothing had a 46 s chunk gap under the task in testing, which
 * looked like death, and the notification fired while iOS was still running the work. The
 * switch throttles itself to 5 s.
 */
export const HEARTBEAT_MS = 5000;

/**
 * The first reports of each phase go into the memory trace: in one run in testing the native
 * log said the task expired at 50,005 and nothing on the JS side could say what the second
 * phase had reported before that, or whether it reported at all.
 */
export const REPORT_MARKS = 12;

/**
 * How long an end waits on its `beforeEnd` hooks. The task still holds the process
 * while they run; completing it can be the last thing a backgrounded process does, so what must
 * reach the user — the hand-off notification — is sent first. Capped, so a hook that hangs cannot
 * hold the task until iOS expires it.
 */
export const BEFORE_END_MS = 2000;

/**
 * @param {Object} deps
 * @param {Object} deps.bg the native bridge's surface (native.js); a fake in tests
 * @param {(line: string, data?: Object) => void} [deps.log]
 * @param {{main: string, followUp: string}} [deps.phases]  the job's phase names, for the
 *   defaults below (DEFAULT_PHASES): the first bar and `begin` start in the main phase, the
 *   resign net rests on the follow-up
 */
export function createContinuedTask({
  bg,
  log = () => {},
  now = Date.now,
  copy,
  context = () => ({}),
  createBar,
  debug = () => {},
  mark: markTrace = () => {},
  /**
   * How the task is completed natively: ALWAYS a success (never "Failed"). A port so the
   * consumer can own the call site its own source sweep guards (e.g. a test that sweeps the
   * app's source for every `endContinuedTask` and requires a literal `true`).
   */
  completeTask = () => bg.endContinuedTask?.(true),
  /**
   * A job's own `{prefix, logDir}` for the submission: its identifier under the
   * `com.example.app.work.*` wildcard and its lifecycle log's folder. Absent: the config's default.
   */
  taskOptions = null,
  phases = DEFAULT_PHASES,
}) {
  const { main: MAIN, followUp: FOLLOW_UP } = { ...DEFAULT_PHASES, ...phases };
  /** The submission in flight or answered. Null when no task is live. */
  let submission = null;
  /**
   * Where the system bar stands, from the work done and the work still owed: see costBar.js.
   * It replaced fixed per-phase bands, under which 61 units finished in the last minute of the
   * first phase moved the bar 0.21 points and iOS asked the tester to stop the task.
   */
  let bar = createBar({ phase: MAIN, follows: false, now });
  /** The last report, for the never-backwards clamp and for the final pause line. */
  let last = { completed: 0, total: 0 };
  /** What iOS last said about the task, so a change is marked once. */
  let seenPhase = null;
  /**
   * The phase the banner's TITLE names. The phase is the title — iOS cuts the subtitle at ~32
   * characters — so a task moving from one phase to the next retitles itself, on a binary that
   * can. One that cannot keeps its first title, and the subtitle names the phase.
   */
  let titledPhase = null;
  /** The job's own state to start over with each new task (e.g. a phase's last report). */
  const resets = new Set();

  function canRetitle() {
    try {
      return typeof bg.canRetitleContinued === 'function'
        ? bg.canRetitleContinued() === true
        : typeof bg.retitleContinued === 'function';
    } catch (e) {
      return false;
    }
  }

  /** The subtitle for `phase`, retitling the banner first when the phase has moved on. */
  function say(phase, args, { retitle = true } = {}) {
    let retitled = false;
    if (retitle && phase !== titledPhase && canRetitle()) {
      try {
        bg.retitleContinued(copy.title(phase), copy.line({ phase, ...args, ...context(), titled: true }));
        titledPhase = phase;
        retitled = true;
      } catch (e) {
        // The UI is a courtesy: the subtitle below still names the phase.
      }
    }
    const titled = phase === titledPhase;
    const subtitle = copy.line({ phase, ...args, ...context(), titled });
    bannerSaid({ phase, titled, retitled, subtitle, ...args });
    return subtitle;
  }

  /** Which builder made the system banner's words, from what. */
  function bannerSaid({ phase, titled, retitled = false, subtitle, done = null, total = null, title = null }) {
    debug('copy', 'banner', {
      phase,
      titled,
      retitled,
      title: title ?? (titledPhase ? copy.title(titledPhase) : null),
      subtitle,
      done,
      total,
      ...context(),
    });
  }
  let reported = false;

  function mark(event, extra) {
    markTrace(`continued.${event}`, extra || null);
  }

  /** Has iOS answered this submission, and did it refuse? See `showing`. */
  let answered = false;
  let refused = false;
  /** `end` has been called and native has not been told yet: the banner is still up. */
  let ending = false;
  /** Who wants to know when the system banner comes or goes (e.g. the app's own Live Activity). */
  const listeners = new Set();
  /** Who must act before native hears an end (BEFORE_END_MS). */
  const beforeEndHooks = new Set();

  /** @param {(args: {complete: boolean, reason: string|null, failed: boolean}) => any} hook */
  function beforeEnd(hook) {
    if (typeof hook !== 'function') return () => {};
    beforeEndHooks.add(hook);
    return () => beforeEndHooks.delete(hook);
  }

  /** Every hook, settled or out of time; nothing when there are none. Never rejects. */
  function runBeforeEnd(args) {
    if (!beforeEndHooks.size) return null;
    const all = Promise.all(Array.from(beforeEndHooks).map((hook) => Promise.resolve()
      .then(() => hook(args))
      .catch(() => { /* a hook's failure is not the task's */ })));
    let timer = null;
    const cap = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), BEFORE_END_MS); });
    return Promise.race([all.then(() => 'done'), cap]).then((result) => {
      clearTimeout(timer);
      debug('continued', 'beforeEnd', { result, hooks: beforeEndHooks.size, ...args });
    });
  }
  /** When a moving bar last told them (HEARTBEAT_MS). */
  let lastBeat = -Infinity;
  /** Reports marked so far this submission, per phase (REPORT_MARKS). */
  let marked = {};

  function notify() {
    Array.from(listeners).forEach((listener) => {
      try { listener(); } catch (e) { /* a listener's failure is not the task's */ }
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function supported() {
    try {
      return bg.continuedSupported?.() === true;
    } catch (e) {
      return false;
    }
  }

  /** A new task, or a new job on the live one: the bar and the job's state start over. */
  function startOver(phase, follows) {
    bar = createBar({ phase, follows, now });
    resets.forEach((reset) => reset());
    last = { completed: 0, total: 0 };
    reported = false;
    marked = {};
  }

  /**
   * Submit the task. Call only from a user action, with the app in front.
   * @param {{phase?: string, done?: number, total?: number, read?: number,
   *          followUpPending?: boolean}} [args]
   *   `read` is accepted as an older alias of `done`. `followUpPending` says a later phase is
   *   owed after this one (the bar counts it): false when nothing follows.
   */
  function begin({ phase = MAIN, done, total = 0, read, followUpPending: follows = false } = {}) {
    if (!submission && !supported()) return null;
    startOver(phase, follows);
    const counted = { done: done ?? read ?? 0, total };
    // Already live — the user restarted the job while a later phase held the task: the same
    // task, a new job. The bar starts over (honestly: the work did) and the line says what is running now.
    if (submission) {
      const live = submission;
      live.then(() => {
        try { bg.reportContinuedProgress?.(0, 0, say(phase, counted)); } catch (e) { /* courtesy */ }
      });
      return live;
    }
    titledPhase = phase;
    const subtitle = copy.line({ phase, ...counted, ...context(), titled: true });
    bannerSaid({ phase, titled: true, subtitle, title: copy.title(phase), ...counted });
    answered = false;
    refused = false;
    const mine = Promise.resolve()
      .then(() => bg.beginContinuedTask({ title: copy.title(phase), subtitle, ...(taskOptions || null) }))
      .then((result) => {
        if (!result?.ok) {
          log('continued task refused', result || {});
          mark('refused', { reason: result?.reason || null });
        } else {
          mark('submitted', { phase });
        }
        return result || { ok: false };
      })
      .catch((error) => {
        log('continued task threw', { error: error?.message });
        mark('refused', { reason: 'threw' });
        return { ok: false, reason: 'threw' };
      })
      .then((result) => {
        if (submission === mine) {
          answered = true;
          refused = result?.ok !== true;
          notify();
        }
        return result;
      });
    seenPhase = null;
    submission = mine;
    return submission;
  }

  function report(completed, total, subtitle, phase = null) {
    // Look at the task on every report, not only when the work asks whether to keep going:
    // that is what puts `launched` and `expired` in the trace when they happened, near enough.
    isRunning();
    let done = Math.max(0, Math.min(completed, total));
    // Never backwards: iOS offers to cancel a task whose progress looks stuck, and a bar that
    // slid back would look worse than stuck.
    if (last.total > 0 && total > 0) {
      const floor = Math.ceil((last.completed / last.total) * total);
      if (done < floor) done = Math.min(total, floor);
    }
    last = { completed: done, total };
    if (phase && (marked[phase] || 0) < REPORT_MARKS) {
      marked[phase] = (marked[phase] || 0) + 1;
      mark('report', { phase, completed: done, n: marked[phase] });
    }
    if (!reported && total > 0) {
      reported = true;
      mark('progress_first', { completed: done, total });
    }
    try {
      bg.reportContinuedProgress?.(done, total, subtitle);
    } catch (e) {
      // The UI is a courtesy; the work does not depend on it.
    }
    // A sign of life for whoever watches the banner: the dead-man's switch (HEARTBEAT_MS).
    if (listeners.size > 0 && now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = now();
      notify();
    }
  }

  /** The bar's fraction as units of the one bar, with what it stood on in the debug log. */
  function units(fraction, kind) {
    debug('continued', 'bar', {
      kind, fraction: Math.round(fraction * 1e5) / 1e5, remainingMs: bar.remainingMs(), costs: bar.costs(),
    });
    return Math.round(fraction * BAR_UNITS);
  }

  /**
   * One unit of progress: `credit(bar)` moves the bar and returns its fraction, then `subtitle()`
   * says it — in that order, as the original per-phase reports did (a phase may say its line
   * first and passes it in) — and the system UI gets it in BAR_UNITS. Nothing without a live
   * submission.
   */
  function progress(kind, credit, subtitle, phase = kind) {
    if (!submission) return;
    report(units(credit(bar), kind), BAR_UNITS, subtitle(), phase);
  }

  /**
   * The ETA experiment's switch: a stored flag 'on' / 'off' goes to native; anything
   * else leaves native on the build's default, so the A/B is one kv write away.
   */
  function applyEtaFlag(raw) {
    if (raw !== 'on' && raw !== 'off') return;
    try {
      bg.setContinuedEta?.(raw === 'on');
    } catch (e) {
      // A binary without it has no experiment to switch.
    }
    debug('continued', 'eta.flag', { raw });
  }

  /** Is iOS running the task right now? False for every other phase, and without support. */
  function isRunning() {
    if (!submission) return false;
    let phase = 'none';
    try {
      phase = bg.continuedTaskState?.() ?? 'none';
    } catch (e) {
      phase = 'none';
    }
    if (phase !== seenPhase) {
      seenPhase = phase;
      if (phase === 'running') mark('launched');
      else if (phase === 'expired') mark('expired', { ...last });
    }
    return phase === 'running';
  }

  /** A task has been submitted and not yet ended, whatever iOS has done with it since. */
  function isLive() {
    return submission != null;
  }

  /**
   * Submitted and never ended, but iOS is no longer running it: refused, expired, or ended from
   * the system UI. Still `isLive`, so nothing would ask for a new one — in testing, a phase
   * the app came back to after an expiry went on with no task under it. Not stale while iOS has
   * not answered, or while the task is pending or running.
   */
  function stale() {
    if (!submission || !answered || ending) return false;
    if (refused) return true;
    let phase = 'none';
    try {
      phase = bg.continuedTaskState?.() || 'none';
    } catch (e) {
      phase = 'none';
    }
    return phase !== 'pending' && phase !== 'running';
  }

  /**
   * Is the system's progress banner for this task on screen?
   *
   * Keyed on the task's STATE, never on the success flag its end carries: pending or running
   * is a banner; expired, ended or refused is not. Until iOS has answered the submission there
   * is no banner yet, and whatever is on the Lock Screen stays until one appears — the answer
   * notifies, so the hand-over is one publish. Between `end` and native hearing it the banner
   * is still up, so it still counts. Without support there is never a banner.
   */
  function showing() {
    if (ending) return true;
    if (!submission || refused || !answered) return false;
    let state = 'none';
    try {
      state = bg.continuedTaskState?.() || 'none';
    } catch (e) {
      state = 'none';
    }
    return state === 'pending' || state === 'running';
  }

  /**
   * @param {{complete?: boolean, reason?: string|null, failed?: boolean}} args
   *   Anything that is not `complete` is a stop: the paused line goes onto the system UI and the
   *   task completes as a success. `failed` marks a real error — a paused stop like any other on
   *   screen (never "Failed"), with the cause in the debug log and the trace. `reason`
   *   travels to both.
   * @returns {Promise<void>} once native has been told
   */
  function end({ complete = false, reason = null, failed = false } = {}) {
    const pending = submission;
    submission = null;
    if (!pending) return Promise.resolve();
    ending = true;
    // After the submission answers, not before: an end that overtook it would find nothing to
    // end, and the task would launch afterwards with no one left to complete it. Native `end`
    // also covers a task that launches later still.
    const errored = failed === true;
    return pending.then(() => runBeforeEnd({ complete: complete === true, reason, failed: errored })).then(() => {
      // Done says what was done; a stop says why and that it continues. A guard's stop is a
      // pause even after a first phase that completed: the phase it would have handed to is
      // what is waiting. An error is a pause too — the job parked on it for Resume.
      const guarded = copy.pausedTitle(reason) !== copy.pausedTitle(null);
      const planned = errored || !complete || guarded;
      // "Paused · iPhone is warm" over "Tap Resume in the app" where the title can change; the
      // cause in the subtitle where it cannot.
      const retitled = planned && canRetitle();
      const line = planned
        ? copy.pausedLine(reason, { titled: retitled }) || copy.pausedGeneric({ titled: retitled })
        : copy.doneLine(context());
      /**
       * No ending may read as "Failed" (on device, a run ended by a thermal stop with
       * success:true at 588 of 100,000, and the system UI said "Failed"). Apple documents only the flag
       * (`setTaskCompleted(success:)`); what else differs from a finished task is a bar left
       * short of its total. So every ending fills the bar, a stop retitles the task "Paused ·
       * iPhone is warm" (on a binary that can) and says in the subtitle what picks it back up —
       * "Tap Resume in the app", short enough for the ~30-character banner — and the flag is
       * always true. Only the system UI's bar is filled: the app's own UI and Live Activity count
       * from the job's own units, so they still say the real "588 of 10,200".
       */
      debug('copy', 'banner.end', {
        reason, complete, failed: errored, success: true, planned, retitled,
        title: retitled ? copy.pausedTitle(reason) : null, subtitle: line,
      });
      // The real cause, where the system UI no longer shows it.
      if (errored) debug('continued', 'end.error', { reason, ...last });
      if (retitled) {
        try {
          bg.retitleContinued(copy.pausedTitle(reason), line);
        } catch (e) {
          // A binary without it keeps the phase's title; the subtitle still says paused.
        }
      }
      const total = last.total > 0 ? last.total : BAR_UNITS;
      try {
        bg.reportContinuedProgress?.(total, total, line);
      } catch (e) {
        // The UI is a courtesy.
      }
      try {
        completeTask();
      } catch (e) {
        // Native completes it on expiry regardless.
      }
      mark('ended', { success: true, failed: errored, complete: complete === true, reason, ...last });
      seenPhase = null;
      // The banner is going now; whatever takes over does so in the same breath.
      ending = false;
      if (!submission) notify();
    });
  }

  /**
   * The willResignActive safety net. While work is running with no task live, the job keeps
   * native armed with what the task would say; native submits it itself as the app
   * stops being active — the last moment iOS accepts one. `phase` and `followUpPending` are what
   * the adopted task's bar is set up by. Told native only when the arming changes.
   */
  let net = { armed: false, phase: FOLLOW_UP, followUpPending: false, subtitle: '' };
  function armResignNet({
    armed = false, phase = FOLLOW_UP, followUpPending = false, subtitle = '',
  } = {}) {
    const next = { armed: armed === true, phase, followUpPending: followUpPending === true, subtitle };
    const changed = next.armed !== net.armed || next.phase !== net.phase || next.subtitle !== net.subtitle;
    net = next;
    if (!changed) return;
    try {
      bg.armContinuedAtResign?.(net.armed, { title: copy.title(net.phase), subtitle: net.subtitle });
    } catch (e) {
      // A binary without the net: the in-front path is the only one.
    }
  }

  /**
   * On the way out: if native submitted the task at willResignActive, it is this run's now. The
   * bar is set up as the net was armed (a phase with another to follow, or a last phase), and the
   * adoption goes in the trace either way — the next pull says which path started the task.
   *
   * @returns {boolean} a task was adopted
   */
  function adoptResign() {
    let result = null;
    try {
      result = bg.takeResignSubmission?.() || null;
    } catch (e) {
      result = null;
    }
    if (!result) return false;
    const accepted = result.ok === true && !result.reason;
    mark('resign', { ok: accepted, reason: result.reason || null, phase: net.phase });
    // A live task wins; one iOS had already stopped or refused gives way to the net's.
    if (!accepted || (submission && !stale())) return false;
    startOver(net.phase, net.followUpPending);
    titledPhase = net.phase;
    answered = true;
    refused = false;
    seenPhase = null;
    submission = Promise.resolve({ ok: true, source: 'resign' });
    net = { ...net, armed: false };
    mark('adopted', { source: 'resign', phase: net.phase });
    notify();
    return true;
  }

  return {
    supported,
    begin,
    armResignNet,
    adoptResign,
    applyEtaFlag,
    say,
    progress,
    isRunning,
    stale,
    /** The submission in hand was refused by iOS (asking again on every touch would spam it). */
    wasRefused: () => submission != null && answered && refused,
    isLive,
    showing,
    subscribe,
    beforeEnd,
    end,
    /** The job's own per-task state to reset with the bar (begin, adoption). */
    onStartOver(reset) {
      resets.add(reset);
      return () => resets.delete(reset);
    },
  };
}

export default createContinuedTask;
