import { requireNativeModule } from 'expo-modules-core';

// iOS-only native module; on other platforms (or before the dev client is rebuilt)
// requireNativeModule throws — fall back to no-ops so callers never need to branch.
let BgTask = null;
try { BgTask = requireNativeModule('ExpoContinuedTask'); } catch (e) { /* not available */ }

// True only when the native module is actually present. When false, begin()/end()
// are no-ops and backgrounded jobs get NO OS grant — surface that so a
// dev client that wasn't rebuilt doesn't silently lose background execution.
export const isAvailable = !!BgTask;

let warnedUnavailable = false;

/**
 * Ask iOS to keep the app running briefly after it's backgrounded (to finish upload prep).
 * `name` (optional) names a new grant in iOS's logs, on a binary that can; without one,
 * or on an older binary, this is exactly the unnamed grant it always was.
 */
export function beginBackgroundTask(name) {
  if (!BgTask) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        '[expo-continued-task] native module unavailable — background grant will NOT be requested. '
        + 'Rebuild the dev client (the JS no-op fallback is active).',
      );
    }
    return;
  }
  if (name != null && typeof BgTask.beginNamed === 'function') {
    try { BgTask.beginNamed(String(name)); } catch (e) { /* no-op */ }
    return;
  }
  try { BgTask.begin(); } catch (e) { /* no-op */ }
}

/**
 * Hand back the grant native takes by itself at willResignActive:
 * Apple asks for `beginBackgroundTask` "as early as possible … preferably before your app
 * actually enters the background", which JS — told of a minimise only after the fact — cannot
 * do. Call once the minimise's work is done. A binary without it has nothing to release.
 */
export function releaseMinimiseGrant() {
  if (typeof BgTask?.releaseMinimiseGrant !== 'function') return;
  try { BgTask.releaseMinimiseGrant(); } catch (e) { /* no-op */ }
}

/**
 * Let native take the minimise pre-grant at willResignActive (true), or stop it (false). Arm it
 * only while something will call `releaseMinimiseGrant` on the way out.
 */
export function armMinimiseGrant(armed) {
  if (typeof BgTask?.armMinimiseGrant !== 'function') return;
  try { BgTask.armMinimiseGrant(armed === true); } catch (e) { /* no-op */ }
}

/**
 * The process's CPU time so far (user + system, ms), or null on a binary without it.
 * Beside a wall-clock duration it separates work from waiting: 19 s of wall with 200 ms of
 * CPU is a process that was suspended or blocked, not one that was busy.
 */
export function cpuTimeMs() {
  if (typeof BgTask?.cpuTimeMs !== 'function') return null;
  try {
    const ms = BgTask.cpuTimeMs();
    return Number.isFinite(ms) ? ms : null;
  } catch (e) {
    return null;
  }
}

/** Release the background-task grant once the work is done. Always pair with begin(). */
export function endBackgroundTask() {
  try { BgTask?.end(); } catch (e) { /* no-op */ }
}

/**
 * Milliseconds of grace iOS says are left, or -1 when no grant is held (or the module is
 * missing). Unlike a BGProcessingTask window, this is a real number the OS publishes, so a
 * caller can decide whether the work in flight fits before minimise becomes suspension.
 */
export function remainingMs() {
  if (!BgTask?.remaining) return -1;
  try {
    const seconds = BgTask.remaining();
    return seconds < 0 ? -1 : seconds * 1000;
  } catch (e) {
    return -1;
  }
}

// ── Continued processing (iOS 26+) ────────────────────────────────────────────────────────
//
// Every call below checks for its native function by name before calling it. The JS ships over
// OTA and the Swift only in a binary, so a new bundle WILL run on binaries that predate these
// functions — there `continuedSupported()` is simply false and the caller keeps the grace grant.

function has(name) {
  return typeof BgTask?.[name] === 'function';
}

/** True when this binary AND this OS can run a BGContinuedProcessingTask. */
export function continuedSupported() {
  if (!has('continuedSupported') || !has('continuedBegin')) return false;
  try {
    return BgTask.continuedSupported() === true;
  } catch (e) {
    return false;
  }
}

/**
 * Submit the task. Only from a user action, with the app in front (Apple's rule).
 *
 * `prefix` and `logDir` (optional) are another job's: its identifier prefix, which must
 * match a permitted wildcard (`com.example.app.work.*`), and its lifecycle log's folder under
 * Documents. Without them this is the config's default submission, exactly as before; with
 * them, a binary that predates `continuedBeginWith` answers `unsupported` rather than submit under the wrong id.
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>} never rejects
 */
export async function beginContinuedTask({
  title, subtitle, prefix = null, logDir = null,
}) {
  if (!continuedSupported()) return { ok: false, reason: 'unsupported' };
  const options = {};
  if (prefix != null) options.prefix = String(prefix);
  if (logDir != null) options.logDir = String(logDir);
  const withOptions = Object.keys(options).length > 0;
  if (withOptions && !has('continuedBeginWith')) return { ok: false, reason: 'unsupported' };
  try {
    const result = withOptions
      ? await BgTask.continuedBeginWith(String(title), String(subtitle), options)
      : await BgTask.continuedBegin(String(title), String(subtitle));
    return result && typeof result === 'object' ? result : { ok: false, reason: 'noResult' };
  } catch (e) {
    return { ok: false, reason: 'threw', error: e?.message || String(e) };
  }
}

/** completed/total onto the system progress UI, and the subtitle beside it. */
export function reportContinuedProgress(completed, total, subtitle = '') {
  if (!has('continuedProgress')) return;
  try { BgTask.continuedProgress(Number(completed) || 0, Number(total) || 0, String(subtitle)); } catch (e) { /* no-op */ }
}

/**
 * Retitle the task in the system UI — "Paused — iPhone is warm" before a planned stop completes
 * it (on device, a stopped bar under the running phase's title read as "Failed"). A binary without
 * it keeps its title; the subtitle still says paused.
 */
export function retitleContinued(title, subtitle = '') {
  if (!has('continuedRetitle')) return;
  try { BgTask.continuedRetitle(String(title), String(subtitle)); } catch (e) { /* no-op */ }
}

/**
 * Can this binary retitle the task? The phase is the banner's title, so a JS
 * bundle on an older binary puts the phase in the subtitle instead.
 */
export function canRetitleContinued() {
  return has('continuedRetitle');
}

/** Complete the task. Idempotent; safe when none was ever submitted. */
export function endContinuedTask(success) {
  if (!has('continuedEnd')) return;
  try { BgTask.continuedEnd(success === true); } catch (e) { /* no-op */ }
}

/**
 * The continued task's ETA experiment: true / false, or null for the build's
 * default (on outside production). A binary without it has no experiment to switch.
 */
export function setContinuedEta(enabled) {
  if (!has('continuedEtaEnabled')) return;
  try { BgTask.continuedEtaEnabled(enabled == null ? null : enabled === true); } catch (e) { /* no-op */ }
}

/** 'none' | 'pending' | 'running' | 'expired' | 'ended' — 'none' when unavailable. */
export function continuedTaskState() {
  if (!has('continuedState')) return 'none';
  try {
    return String(BgTask.continuedState());
  } catch (e) {
    return 'none';
  }
}

/**
 * The willResignActive safety net: while armed, native submits the continued task
 * itself as the app stops being active — the last moment iOS accepts one — for work that is
 * running with no task. Arm it with the lines the task would carry; a binary without it ignores
 * this, and the JS path (asking in front) is unchanged.
 */
export function armContinuedAtResign(armed, { title = '', subtitle = '' } = {}) {
  if (!has('continuedArmResign')) return;
  try { BgTask.continuedArmResign(armed === true, String(title), String(subtitle)); } catch (e) { /* no-op */ }
}

/**
 * What the safety net did at the last willResignActive, once: `{ok, reason?}`, or null when it
 * did nothing (or the binary has no net).
 */
export function takeResignSubmission() {
  if (!has('continuedTakeResign')) return null;
  try {
    const result = BgTask.continuedTakeResign();
    return result && typeof result === 'object' ? result : null;
  } catch (e) {
    return null;
  }
}

export default {
  beginBackgroundTask,
  endBackgroundTask,
  releaseMinimiseGrant,
  armMinimiseGrant,
  remainingMs,
  isAvailable,
  continuedSupported,
  beginContinuedTask,
  reportContinuedProgress,
  endContinuedTask,
  retitleContinued,
  canRetitleContinued,
  continuedTaskState,
  armContinuedAtResign,
  takeResignSubmission,
};
