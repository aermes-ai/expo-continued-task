/**
 * createContinuedJob — a long, user-started background job in one call.
 *
 * An app can wire the continued tier by hand from five modules; this puts the same pieces
 * together, with the iOS rules already applied, for a job whose work is "a queue of units":
 *
 *   - START ONLY FROM A TAP. `start()` submits the BGContinuedProcessingTask, so call it from a
 *     person's action with the app in front (Apple's rule; testing on device showed
 *     launch-submitted tasks run with the process suspended). Nothing here starts work on its own.
 *   - AN HONEST BAR. Every unit is weighed by its measured cost (`createCostBar`, seeded with
 *     `seedMs`), and the bar stays under 100 % while units are owed.
 *   - AWAY FROM THE APP the work goes on while iOS runs the task. If iOS stops running it
 *     (expiry, Stop in the system UI, a refusal) — or the binary/OS has no continued task — the
 *     unit in hand finishes (inside the ~30 s grace grant) and the job stops at the boundary.
 *   - NEVER "FAILED". Every ending completes the task with success:true: "Paused" over the
 *     resume line when it stopped, the job's done line when it finished (createContinuedTask).
 *   - NOTIFY BEFORE THE END. With `notifications`, the done / paused notification is sent in a
 *     `beforeEnd` hook — before native hears the end, while the task still holds the process
 *     — and a dead-man's notification is kept 45 s out while the work runs away from the
 *     screen, for the case where iOS freezes the process before it can say anything (seen on device).
 *   - BUSY. The job is declared (`defineBackgroundJob`) and answers `anyBusy()` while it runs.
 *
 * Everything platform-shaped is passed in: `bg` (the native bridge, native.js), `appState`
 * (react-native's AppState), and optionally `notifications.Notifications` (expo-notifications).
 */
import { defineBackgroundJob } from './registry';
import { createForegroundBridge } from './foregroundBridge';
import { createNotifier } from './createNotifier';
import { createContinuedTask } from './createContinuedTask';
import { createCostBar } from './costBar';

/** The resume line, short enough for the ~30-character banner subtitle. */
export const DEFAULT_RESUME_LINE = 'Tap to resume';

/**
 * @param {Object} spec
 * @param {string} spec.name  unique job name; also its task prefix and log folder
 * @param {Object} [spec.identifiers]  persisted identifiers, recorded on the job
 * @param {Object} spec.bg  the native bridge (native.js)
 * @param {Object} spec.appState  react-native's AppState
 * @param {() => number|Promise<number>} spec.size  how many units the run owes (unknown: null)
 * @param {() => Promise<boolean>} spec.step  one unit; resolves false when none are left
 * @param {number} [spec.seedMs]  measured background cost of one unit, ms (the bar's seed)
 * @param {Object} spec.words  the banner's words:
 *   title (string), line({done, total}) (string), done({total}) (string),
 *   [paused] (string, default 'Paused'), [resume] (string, default DEFAULT_RESUME_LINE)
 * @param {Object} [spec.notifications]  {Notifications, store?, done: {title, body},
 *   paused: {title, body}} — omit for no notifications
 * @param {string} [spec.taskPrefix]  the continued task's identifier prefix; must match a
 *   prefix the config plugin permits (`taskIdentifierPrefix` or `extraTaskIdentifierPrefixes`).
 *   Default: the plugin's `taskIdentifierPrefix`
 * @param {string} [spec.logDir]  the lifecycle log's folder. Default: the plugin's `logDirectory`
 * @param {Function} [spec.debug]  (cat, ev, fields) — the app's debug log
 * @param {Function} [spec.mark]  (label, extra) — the app's memory trace
 */
export function createContinuedJob({
  name,
  identifiers = {},
  bg,
  appState,
  size,
  step,
  seedMs = 1000,
  words,
  notifications = null,
  taskPrefix = null,
  logDir = null,
  now = Date.now,
  debug = () => {},
  mark = () => {},
}) {
  const job = defineBackgroundJob({ name, identifiers, description: 'continued job' });
  const paused = words.paused || 'Paused';
  const resume = words.resume || DEFAULT_RESUME_LINE;

  /** The current run: how much it owes and has done. */
  let total = null;
  let done = 0;
  let running = null;
  let away = false;
  let stopRequested = false;

  const task = createContinuedTask({
    bg,
    now,
    debug,
    mark,
    copy: {
      title: () => words.title,
      line: ({ done: d = 0, total: t = 0 }) => words.line({ done: d, total: t }),
      pausedTitle: () => paused,
      pausedLine: (reason, { titled = true } = {}) => (titled ? resume : `${paused} · ${resume}`),
      pausedGeneric: ({ titled = true } = {}) => (titled ? resume : `${paused} · ${resume}`),
      doneLine: () => words.done({ total: total ?? done }),
    },
    createBar: ({ now: clock }) => createCostBar({
      seeds: { unit: seedMs },
      remaining: (cost) => (total == null ? 0 : Math.max(0, total - done) * cost.unit),
      unsized: () => total == null,
      now: clock,
    }),
    // Only what the job set: without either, the submission is the config plugin's own.
    taskOptions: taskPrefix || logDir
      ? { ...(taskPrefix ? { prefix: taskPrefix } : null), ...(logDir ? { logDir } : null) }
      : null,
  });

  const notifier = notifications ? createNotifier({
    Notifications: notifications.Notifications,
    appState: () => appState?.currentState,
    store: notifications.store || null,
    now,
    namespace: { dataKey: name, deadmanId: `${name}-deadman`, dedupeKey: `${name}.notify.dedupe` },
    copyFor: ({ complete }) => (complete
      ? { ...notifications.done, action: 'review', reason: 'done' }
      : { ...notifications.paused, action: 'resume', reason: 'stopped' }),
    stalledCopy: () => notifications.paused,
    describe: ({ complete }) => ({ complete: complete === true }),
    debug,
    mark,
  }) : null;

  // What must reach the person goes out before native hears the end.
  if (notifier) task.beforeEnd(({ complete }) => notifier.notify({ complete }));

  async function run() {
    stopRequested = false;
    done = 0;
    total = null;
    let complete = false;
    try {
      const counted = await size();
      total = Number.isFinite(counted) ? counted : null;
      task.begin({ phase: name, done: 0, total: total ?? 0 });
      if (notifier) await notifier.beginRun();
      debug('job', 'start', { name, total });
      for (;;) {
        if (stopRequested) break;
        // Away with no task running (expired, stopped from the system UI, never granted): the
        // grace grant covered the unit in hand; nothing new starts.
        if (away && !task.isRunning()) break;
        const more = await step();
        done += 1;
        task.progress('unit', (bar) => bar.credit('unit', 1), () => task.say(name, { done, total: total ?? 0 }));
        if (away && notifier) notifier.feedDeadman();
        if (!more) {
          complete = true;
          break;
        }
      }
    } finally {
      debug('job', 'end', { name, complete, done, total });
      // No task was live (an older binary or OS, or iOS refused it): no `beforeEnd` will run,
      // so the notification goes out here, the same way.
      if (notifier && !task.isLive()) await notifier.notify({ complete });
      await task.end(complete ? { complete: true } : { complete: false, reason: 'stopped' });
      if (notifier) await notifier.disarmDeadman();
    }
    return { complete, done, total };
  }

  /** Start from a person's tap, with the app in front. Joins a run already in flight. */
  function start() {
    if (!running) {
      running = run().finally(() => {
        running = null;
        job.announceBusy();
      });
      job.announceBusy();
    }
    return running;
  }

  /** Stop at the next unit boundary. The task still ends as a paused success. */
  function stop() {
    stopRequested = true;
    return running || Promise.resolve(null);
  }

  const offBusy = job.registerBusy(() => running != null);
  const bridge = createForegroundBridge({
    appState,
    bg,
    onMinimise: async () => {
      away = true;
      // Without a running task, the grace grant is all there is: let the unit in hand finish.
      if (running && !task.isRunning()) {
        stopRequested = true;
        await running;
      }
    },
    onForeground: async () => {
      away = false;
      if (notifier) await notifier.disarmDeadman();
    },
    log: (line, data) => debug('job', line, data),
  });
  const offBridge = bridge.start();

  return {
    job,
    start,
    stop,
    isRunning: () => running != null,
    /** Taps on the job's notifications: `{open, top, resume, canResume, ready}` (see createNotifier). */
    listen: (actions) => (notifier ? notifier.listen(actions) : () => {}),
    /** Exposed for tests: drive AppState without an emitter. */
    handleChange: bridge.handleChange,
    dispose() {
      offBridge();
      offBusy();
    },
  };
}

export default createContinuedJob;
