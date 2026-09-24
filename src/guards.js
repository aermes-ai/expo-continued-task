/**
 * guards — everything the device says about whether we may keep working.
 *
 * The device-reading half of the executor's guard layer. Two readings:
 *
 *   read()            thermal, Low Power Mode, charging, battery level, library access, RSS
 *   budget(context)   how much window and how much memory growth is left
 *
 * `policy.js` turns the first into a verdict; `executor.js` uses the second to decide whether
 * another chunk fits. Both are injectable, so the whole guard matrix and every expiry path
 * are exercised in Jest against plain objects.
 *
 * ── Why the power reading is native and not expo-battery ────────────────────────────────
 * expo-battery need not be a dependency of the app, and adding one for two scalars that the
 * scheduler's own native module already has to read anyway (it needs them inside a
 * BGProcessingTask window, where no JS timer is running) is a dependency for nothing.
 * The device module's `powerState()` caches UIDevice's battery level and state off UIKit
 * notifications — batteryLevel is main-thread-only, and the guards are polled from the JS
 * thread inside a window — and its `lowPowerMode()` reads ProcessInfo directly.
 *
 * ── Why RSS is a delta ──────────────────────────────────────────────────────────────────
 * See the header of policy.js. The ceiling is growth since the run started, not an absolute
 * footprint: a window's process already sits at 350–390 MB before the first chunk. In a
 * window the baseline comes from the native side (it is captured the instant iOS hands the
 * task over, before any JS runs); in the foreground and in the grace grant there is no such
 * moment, so the baseline is taken here when the run starts.
 */
import { CONTEXTS } from './policy';

/**
 * A forced device reading, for reproducing a pause on a simulator (`__DEV__` only).
 *
 * Every guard pause was previously unreproducible without the phone actually being in the
 * state: you cannot make a simulator's `ProcessInfo` report `serious`, so "the pass parks on
 * heat and the UI tells the truth about it" was a claim nobody could check before shipping
 * it. That is how a status stamp once shipped that erased the progress display — the state it
 * applied to could not be looked at.
 *
 * `read()` consults this after the real reads, so an override of one field leaves the rest
 * honest. The setter is inert outside a dev build, and the fields are the guard's own
 * vocabulary so a dev-menu item can name a case ("thermal serious") rather than a number.
 */
let override = null;

/**
 * @param {Object|null} next `{thermal, lowPower, charging, level, access}`; null clears it.
 * @returns {Object|null} what is now in force
 */
export function setGuardOverride(next) {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return null;
  override = next && Object.keys(next).length ? { ...next } : null;
  return override;
}

/** What is being forced, if anything. The dev menu shows this in its label. */
export function guardOverride() {
  return override ? { ...override } : null;
}

/** What a reading looks like when nothing can be read — no native module, or a simulator. */
export const UNKNOWN_READING = Object.freeze({
  thermal: 'unknown',
  lowPower: false,
  charging: false,
  level: -1,
  access: 'unknown',
  rssMb: -1,
});

/**
 * @param {Object} deps
 * @param {Object} deps.device the device port: `memoryUsage()`, `thermalState()`,
 *   `lowPowerMode()`, `powerState()`, `authorization()` and the window state `windowState()` —
 *   typically the app's device module surface, which has all six
 * @param {Object} deps.bg the expo-bg-task module surface
 * @param {() => string} [deps.getAccess] standing library authorization; never prompts
 * @param {() => number} [deps.now]
 * @param {() => Object} [deps.windowState] the processing window's state
 *   `{active, expired, remainingMs, rssMb, rssDeltaMb, seq}`; by default the device port's
 *   `windowState()`. For a device module that names it otherwise.
 */
export function createGuards({
  device,
  bg,
  getAccess = null,
  now = Date.now,
  windowState = () => device.windowState?.(),
}) {
  /** RSS at the start of the current foreground/grace run. Null between runs. */
  let baselineRssMb = null;
  /** When the current grace/foreground run started, for the foreground's soft budget. */
  let runStartedAt = null;

  function rss() {
    try {
      const value = device.memoryUsage?.();
      const mb = typeof value === 'number' ? value : value?.rssMb;
      return Number.isFinite(mb) ? mb : -1;
    } catch (e) {
      return -1;
    }
  }

  /**
   * One device reading. Every field degrades to something safe rather than throwing: a guard
   * that crashes the job is worse than a guard that reads 'unknown'.
   * @returns {{thermal: string, lowPower: boolean, charging: boolean, level: number,
   *            access: string, rssMb: number}}
   */
  function read() {
    let thermal = 'unknown';
    let lowPower = false;
    let charging = false;
    let level = -1;
    try { thermal = device.thermalState?.() || 'unknown'; } catch (e) { /* unknown */ }
    try { lowPower = device.lowPowerMode?.() === true; } catch (e) { /* off */ }
    try {
      const power = device.powerState?.() || {};
      charging = power.charging === true;
      level = Number.isFinite(power.level) ? power.level : -1;
      // ProcessInfo is the same source either way; powerState carries it so one call answers
      // the whole power question.
      if (power.lowPower === true) lowPower = true;
    } catch (e) { /* unplugged, unknown level */ }

    let access = 'unknown';
    try {
      const raw = getAccess ? getAccess() : device.authorization?.();
      // The reader reports the platform's vocabulary; policy speaks the job's.
      if (raw === 'authorized' || raw === 'full') access = 'full';
      else if (raw) access = raw;
    } catch (e) { /* unknown */ }

    const reading = { thermal, lowPower, charging, level, access, rssMb: rss() };
    // Last, and field by field: a forced `thermal` must not also invent a battery level.
    return override ? { ...reading, ...override } : reading;
  }

  /**
   * Open a run: fix the RSS baseline for contexts that have no native one.
   * @param {string} context one of CONTEXTS
   */
  function startRun(context) {
    runStartedAt = now();
    baselineRssMb = context === CONTEXTS.WINDOW ? null : rss();
    return baselineRssMb;
  }

  function endRun() {
    baselineRssMb = null;
    runStartedAt = null;
  }

  /**
   * How much room is left, in time and in memory growth.
   *
   * - WINDOW: both come from the native window state. `remainingMs` counts down the assumed
   *   budget and is slammed to 0 by the OS expiration handler (BGTask publishes no deadline,
   *   so an assumed budget plus the handler is the honest model).
   * - GRACE: `UIApplication.backgroundTimeRemaining`, which iOS does publish.
   * - CONTINUED: no deadline. It lasts exactly as long as iOS reports the continued task
   *   `running`; anything else (expired, cancelled from the system UI, never started, or a
   *   binary without the task) is expired.
   * - FOREGROUND: unbounded time; only the RSS ceiling and the guards end a run.
   *
   * @param {string} context
   * @returns {{remainingMs: number, expired: boolean, rssMb: number, rssDeltaMb: number,
   *            active: boolean, seq: number}}
   */
  function budget(context) {
    if (context === CONTEXTS.WINDOW) {
      let state = {};
      try { state = windowState() || {}; } catch (e) { state = {}; }
      const expired = state.expired === true || state.active === false;
      return {
        remainingMs: expired ? 0 : Math.max(0, Number(state.remainingMs) || 0),
        expired,
        rssMb: Number.isFinite(state.rssMb) ? state.rssMb : -1,
        rssDeltaMb: Number.isFinite(state.rssDeltaMb) ? state.rssDeltaMb : -1,
        active: state.active === true,
        seq: Number(state.seq) || 0,
      };
    }

    const current = rss();
    const delta = baselineRssMb == null || current < 0 || baselineRssMb < 0
      ? -1
      : current - baselineRssMb;

    if (context === CONTEXTS.GRACE) {
      let remainingMs = -1;
      try { remainingMs = bg.remainingMs?.() ?? -1; } catch (e) { remainingMs = -1; }
      // -1 means "no grant held" — either the module is missing or begin() was never called.
      // Treating that as an expired grace is the safe reading: it stops the loop at a chunk
      // boundary instead of running past a suspension the OS is about to impose.
      const expired = !(remainingMs > 0);
      return {
        remainingMs: expired ? 0 : remainingMs,
        expired,
        rssMb: current,
        rssDeltaMb: delta,
        active: !expired,
        seq: 0,
      };
    }

    if (context === CONTEXTS.CONTINUED) {
      let phase = 'none';
      try { phase = bg.continuedTaskState?.() ?? 'none'; } catch (e) { phase = 'none'; }
      const expired = phase !== 'running';
      return {
        remainingMs: expired ? 0 : Number.POSITIVE_INFINITY,
        expired,
        rssMb: current,
        rssDeltaMb: delta,
        active: !expired,
        seq: 0,
      };
    }

    return {
      remainingMs: Number.POSITIVE_INFINITY,
      expired: false,
      rssMb: current,
      rssDeltaMb: delta,
      active: true,
      seq: 0,
    };
  }

  /** Milliseconds since startRun(), for telemetry. */
  function elapsed() {
    return runStartedAt == null ? 0 : now() - runStartedAt;
  }

  return { read, budget, startRun, endRun, elapsed, rss };
}

export default createGuards;
