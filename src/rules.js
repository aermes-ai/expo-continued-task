/**
 * Who may drive a job's run, and under which rules — the pure half of the coordinator
 * (extracted from an app's own job runner).
 */
import { CONTEXTS } from './policy';

/**
 * Who is driving a run. Exactly one owner drives the job's state machine at a time,
 * and the question a caller asks before starting one is whether it may OWN it — not merely
 * what AppState says.
 *
 *   FOREGROUND  the app is in front: a tap, a launch, a return to the app. Needs the app in
 *               front to start, and stops looping when it leaves.
 *   WINDOW      a BGProcessingTask window. Owns its run and its ending.
 *   CONTINUED   a user-started job iOS keeps running after a minimise under a
 *               BGContinuedProcessingTask (either phase: main or follow-up). Legitimately runs
 *               while backgrounded, as its own owner.
 */
export const RUN_OWNERS = Object.freeze({
  FOREGROUND: 'foreground',
  WINDOW: 'window',
  CONTINUED: 'continued',
});

/**
 * `start()` entries that are NOT a user action. A BGContinuedProcessingTask may only
 * be requested in response to one, so these never submit it: a launch resuming an unfinished
 * walk, and a foreground event picking a parked one back up.
 */
export const AUTOMATIC_ENTRIES = new Set(['launch', 'foreground', 'heal']);

/**
 * The pause an automatic start takes in front when no continued task is live:
 * nothing runs until the person taps Resume, which asks for the task. See `mustAskFirst`. One
 * reason for a read and a work phase alike; the app's progress line says which (`pausedAtLine`),
 * and the app's own Live Activity can draw it on the Lock Screen and in the notification too.
 */
export const RESUME_PAUSE = 'resume';

/**
 * The names of a two-phase job's phases, as the package writes them (a continued task's `phase`,
 * the resign net's, the coordinator's): the MAIN phase (e.g. a pass that reads what is to be
 * done) and the FOLLOW-UP phase that works through what it found. Neutral by default; a job
 * whose logs, copy or goldens already name its phases passes its own (`phases`) so what it
 * emits does not change.
 */
export const DEFAULT_PHASES = Object.freeze({
  main: 'main',
  followUp: 'followUp',
});

/**
 * Which rules the next pass runs under, or null to stop.
 *
 *   in front          FOREGROUND, unless something asked it to stop (a restart, a reset)
 *   away, task        CONTINUED — iOS is still running the user's continued task
 *   away, none        stop. The grace grant finishes the chunk in flight (the scheduler's
 *                     own bridge), and the BGProcessingTask windows take it from there.
 *
 * `continuedRunning` is asked only when away: asking it marks the task's launch/expiry in the
 * trace and reads native, so a foreground answer must not ask it.
 *
 * @param {{away: boolean, continuedRunning: () => boolean, stopRequested: boolean}} args
 */
export function contextFor({ away, continuedRunning, stopRequested }) {
  if (away) return continuedRunning() ? CONTEXTS.CONTINUED : null;
  return stopRequested ? null : CONTEXTS.FOREGROUND;
}
