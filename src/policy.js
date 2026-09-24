/**
 * policy — the numbers and the "may we work right now" decision, as pure functions.
 *
 * The device-condition half of the executor (power, heat, access, memory). Nothing here
 * touches the job's work, its store, the clock or React: it takes a guard
 * reading and a context and answers with a verdict, so the whole guard matrix is a table in
 * a Jest file rather than a device protocol.
 *
 * ── Two vocabularies, deliberately separate ─────────────────────────────────────────────
 * A STOP reason says why the chunk loop ended. A PAUSE reason is a line the user reads in
 * the app's UI. They are not the same set and conflating them is how "Paused · memory" ends up
 * in front of someone. Running out of window, running out of headroom, or hitting the RSS
 * ceiling are ordinary endings — the work simply continues in the next window, and the user
 * is told nothing. Only a guard that will still be true next time (a flat battery, a hot
 * phone, revoked access, Low Power Mode on a background window) earns a pause line and a
 * `trackPaused` event. Being off a charger is not one of them: it holds back background
 * windows and nothing else, so it is an `idle`.
 *
 * ── The RSS ceiling is a DELTA budget ───────────────────────────────────────────────────
 * The budget is 150 MB in a background window. Measured on device, the process
 * already sits at 350–390 MB resident inside a window before any of the job's work starts —
 * that is the React host, the job's store and the system frameworks' caches, not the chunk.
 * So 150 MB is read here as GROWTH over the footprint at the moment the window opened, which is the only part
 * the executor controls and the only part that can be traded against chunk size. Absolute
 * RSS is still logged (the window log carries start and end) so a jetsam kill can be
 * attributed afterwards.
 */
/**
 * The pause vocabulary: the lines a guard can put in front of the user. A job passes
 * its own to `decide`; these are the defaults, and a job whose telemetry already has a
 * `PAUSE_REASON` set can pin its values against these.
 */
export const PAUSES = Object.freeze({
  PERMISSION_REVOKED: 'permission_revoked',
  THERMAL: 'thermal',
  NEEDS_CHARGING: 'needs_charging',
  LOW_POWER_MODE: 'low_power_mode',
});

/** Where the chunk loop is running. Each has its own budget and its own ending. */
export const CONTEXTS = Object.freeze({
  /** The user is watching. Tap-initiated runs go flat out here. */
  FOREGROUND: 'foreground',
  /** The ~30 s `beginBackgroundTask` grant after a minimise. Finish, do not start. */
  GRACE: 'grace',
  /** A BGProcessingTask window. Idle or charging, never in Low Power Mode. */
  WINDOW: 'window',
  /**
   * A BGContinuedProcessingTask the user started, running after a minimise.
   *
   * Its own context rather than FOREGROUND-with-tapInitiated, because the foreground's rules
   * would lie in the background. FOREGROUND allows 300 MB of RSS growth and never refuses Low
   * Power Mode, and its budget never expires. Here:
   *   - the RSS ceiling is the background one (150 MB). A suspended-looking process that size
   *     is what jetsam takes first, and surviving that is the point of this context.
   *   - Low Power Mode off a charger is refused, as it is for a window. The user asked their
   *     phone to save battery, and they are no longer watching it spend it.
   *   - NO charger requirement. The user started this and iOS shows it with a Stop button;
   *     that is the consent a window never has.
   *   - the budget expires when iOS stops RUNNING the task (expiry, or Stop in the system UI),
   *     read before every chunk and inside one, so the pass parks at a chunk boundary.
   */
  CONTINUED: 'continued',
});

/** Why the chunk loop ended. Only `PAUSED` carries a line for the user. */
export const STOP_REASONS = Object.freeze({
  /** The work queue is empty. */
  EMPTY: 'empty',
  /** The OS expiration handler fired, or the assumed budget ran out. */
  EXPIRED: 'expired',
  /** Not enough time left to finish another chunk (see headroomFor). */
  HEADROOM: 'headroom',
  /** RSS grew past the delta ceiling for this context. */
  RSS: 'rss',
  /** A chunk moved nothing: the queue head is all deferred or all failing. */
  STALLED: 'stalled',
  /** A guard said no. `pauseReason` says which, and the user sees it. */
  PAUSED: 'paused',
  /**
   * Ambient work is simply waiting for its conditions — off a charger with the
   * default settings. NOT a pause: the UI's line is "continues when
   * charging", not "Paused · plug in", and nothing is written to the job's store.
   */
  IDLE: 'idle',
  /** A caller asked the loop to stop (minimise with no grace, screen left, reset). */
  STOPPED: 'stopped',
  /** `work()` threw. The chunk is not committed; the next pass redoes it. */
  ERROR: 'error',
});

/** Items per chunk. A starting assumption: revisit after the first background measurement. */
export const CHUNK_SIZE = 50;

/** RSS GROWTH allowed inside one run, by context. See the header. */
export const RSS_DELTA_CEILING_MB = Object.freeze({
  [CONTEXTS.WINDOW]: 150,
  [CONTEXTS.GRACE]: 150,
  [CONTEXTS.CONTINUED]: 150,
  [CONTEXTS.FOREGROUND]: 300,
});

/** Never start a chunk with less than this left, whatever the measured chunk time. */
export const MIN_HEADROOM_MS = 10000;

/** Headroom = measured chunk time × this: "measured chunk time × 1.5". */
export const HEADROOM_FACTOR = 1.5;

/** First-chunk estimate, until a real one has been timed. 500 thumbnails took 13–35 s on device. */
export const ASSUMED_CHUNK_MS = 4000;

/** Below this, ambient work stops. Tap-initiated work carries on. */
export const BATTERY_FLOOR = 0.2;

/** Thermal states at which nothing ambient runs. */
const THERMAL_STOP = Object.freeze(['serious', 'critical']);

/** Thermal state at which the chunk halves but work continues. */
const THERMAL_HALVE = 'fair';

/**
 * Chunk size for the conditions in front of us.
 *
 * Halved on thermal `fair` and in Low Power Mode ("tap-initiated work continues at
 * reduced chunk size"). The two compound — a hot phone in Low Power Mode gets a quarter
 * chunk — because each is an independent reason to touch the CPU less, and a floor of 1 keeps
 * the loop able to make progress at all.
 *
 * @param {Object} args
 * @param {string} [args.thermal] 'nominal'|'fair'|'serious'|'critical'|'unknown'
 * @param {boolean} [args.lowPower]
 * @param {number} [args.base]
 * @returns {number} items, at least 1
 */
export function chunkSizeFor({ thermal = 'nominal', lowPower = false, base = CHUNK_SIZE } = {}) {
  let size = Math.max(1, Math.floor(base));
  if (thermal === THERMAL_HALVE) size = Math.ceil(size / 2);
  if (lowPower) size = Math.ceil(size / 2);
  return Math.max(1, size);
}

/** RSS growth allowed in this context, in MB. */
export function ceilingFor(context) {
  return RSS_DELTA_CEILING_MB[context] ?? RSS_DELTA_CEILING_MB[CONTEXTS.WINDOW];
}

/**
 * Time that must be left before another chunk may START.
 * @param {number} [lastChunkMs] the most recent measured chunk, or the assumption
 */
export function headroomFor(lastChunkMs = ASSUMED_CHUNK_MS) {
  const measured = Number.isFinite(lastChunkMs) && lastChunkMs > 0 ? lastChunkMs : ASSUMED_CHUNK_MS;
  return Math.max(MIN_HEADROOM_MS, Math.round(measured * HEADROOM_FACTOR));
}

/**
 * May the loop run another chunk, and how big?
 *
 * ── The power rule is about BACKGROUND WINDOWS, not about the work ───────────────────────
 *
 * This once read the rule as "ambient work only on power" and applied it to the foreground too,
 * so a phone off a charger did nothing while its owner sat looking at the screen — the counter
 * was frozen and nothing the user could do would move it. That is not a power policy, it is a
 * dead app.
 *
 * The charger requirement exists because a BGProcessingTask is a favour the OS does us: iOS
 * hands out processing windows on a charger, and asking for them on battery gets them either
 * refused or resented. None of that applies while the app is in front. The user tapped to
 * start the work, they are holding the phone, and the whole foreground session is that tap
 * continuing — so the foreground works on battery and only stops for the two things that are
 * about the phone rather than about the app: a nearly-flat battery and heat. Both put
 * their reason in the UI.
 *
 * Low Power Mode is therefore no longer a foreground pause either. It still halves the chunk,
 * which is the part of the Low Power rule that is about spending less CPU; refusing to work at all is the
 * part that only ever made sense for a window iOS would not have scheduled anyway.
 *
 * Order matters: access first (nothing else is worth checking without it), then heat, then the
 * flat battery — those three answer the same way everywhere. The charger question is asked
 * last, and only of a background window.
 *
 * @param {Object} args
 * @param {string} args.context one of CONTEXTS
 * @param {boolean} [args.tapInitiated] kept for callers and telemetry; it no longer changes
 *   the answer, because the whole foreground session is now treated as tap-initiated
 * @param {Object} args.reading a guards.read() snapshot
 * @param {Object} [args.settings] {allowOnBattery} — lifts the charger requirement for
 *   background windows too
 * @param {Object} [args.pauses] the job's pause vocabulary (PAUSES)
 * @returns {{proceed: boolean, pauseReason: string|null, idleReason: string|null,
 *            chunkSize: number, ceilingMb: number}}
 *   `pauseReason` is a line the user reads. `idleReason` is the ordinary resting state and
 *   is deliberately silent — see STOP_REASONS.IDLE.
 */
export function decide({ context, tapInitiated = false, reading, settings = {}, pauses = PAUSES }) {
  const ceilingMb = ceilingFor(context);
  const chunkSize = chunkSizeFor({ thermal: reading.thermal, lowPower: reading.lowPower });
  const no = (pauseReason) => ({
    proceed: false, pauseReason, idleReason: null, chunkSize, ceilingMb,
  });
  const idle = (idleReason) => ({
    proceed: false, pauseReason: null, idleReason, chunkSize, ceilingMb,
  });
  const yes = () => ({ proceed: true, pauseReason: null, idleReason: null, chunkSize, ceilingMb });

  // Access pulled from under us. Nothing runs, in any context.
  if (reading.access && reading.access !== 'full' && reading.access !== 'limited') {
    return no(pauses.PERMISSION_REVOKED);
  }

  // A serious or critical phone stops everywhere, including the foreground. Heat is
  // the one guard a tap does not override, because the user's next complaint is the phone,
  // not the job.
  if (THERMAL_STOP.includes(reading.thermal)) return no(pauses.THERMAL);

  // Never on a nearly-flat battery, in any context, whatever the settings say. `level` is
  // -1 before the OS has reported one, which is not evidence of a low battery. A pause line,
  // because the phone will not fix this on its own.
  if (!reading.charging && reading.level >= 0 && reading.level < BATTERY_FLOOR) {
    return no(pauses.NEEDS_CHARGING);
  }

  // The app is in front. The user tapped to start the work and is watching the counter; spending
  // battery they can see is the trade they already made. GRACE is the tail of that same
  // session — the ~30 s after a minimise, finishing the chunk that was already running — so
  // it answers the same way rather than switching to the background rule mid-chunk.
  if (context === CONTEXTS.FOREGROUND || context === CONTEXTS.GRACE) return yes();

  // User-started, still running after a minimise. Low Power Mode off a charger is the
  // one background rule it keeps; the charger requirement below is a window's, not this.
  if (context === CONTEXTS.CONTINUED) {
    return reading.lowPower && !reading.charging ? no(pauses.LOW_POWER_MODE) : yes();
  }

  // ── Background windows only, from here ────────────────────────────────────────────────

  /**
   * Low Power Mode, corrected against the device log.
   *
   * This used to refuse Low Power Mode outright, on the stated premise that "iOS schedules no
   * processing windows in Low Power Mode at all, so this is less a policy than a description".
   * The premise is false. Three windows on a test phone arrived with `lowPower: true` and
   * were turned away by this line — two of them back to back, about 30 minutes apart on the
   * same morning, both with `power: "charging"`.
   *
   * And charging is exactly when it bites. iOS turns Low Power Mode on by itself at 20 % and
   * leaves it on while charging until 80 %, so a phone plugged in at bedtime on a low battery
   * spends the first hours of the night in it — the hours background processing exists for. Refusing
   * there is not conserving anything: the power is coming from the wall.
   *
   * So the refusal is about the BATTERY, and it is asked of the battery. On external power the
   * window proceeds; `chunkSizeFor()` still halves the chunk, which is the part of the rule
   * that was ever about spending less CPU. Off a charger it remains a pause line: a switch the
   * user flipped and can unflip, and without the line nothing explains a counter that stopped
   * overnight.
   */
  if (reading.lowPower && !reading.charging) return no(pauses.LOW_POWER_MODE);

  // A background window is a favour the OS grants on a charger. NOT a pause — being off
  // a charger is the normal state of a phone, and the UI's line for it is "continues
  // while charging". Writing `Paused · plug in` for it would make the resting state look
  // like a fault.
  if (!reading.charging && settings.allowOnBattery !== true) {
    return idle(pauses.NEEDS_CHARGING);
  }

  return yes();
}

export default { CONTEXTS, STOP_REASONS, decide, chunkSizeFor, ceilingFor, headroomFor };
