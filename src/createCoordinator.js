/**
 * The coordinator: who may start what, when a person must be asked first, and the hand-off to
 * the continued task (extracted verbatim from an app's own job runner).
 *
 * Every function here is synchronous and awaits nothing. The job calls it on exactly the tick it
 * always did: the minimise hand-off in particular sits on a path where "not even a microtask may
 * change" (the job's own rule) — the foreground pass starts, and the chunk in flight stops, on
 * the tick they always have.
 *
 * @param {Object} deps
 * @param {Object|null} deps.continued  the job's continued task (createContinuedTask's surface)
 * @param {() => boolean} deps.isForeground  is the app in front? A probe that throws is yes.
 * @param {(cat: string, ev: string, fields?: Object) => void} [deps.debug]
 * @param {(label: string, extra?: Object) => void} [deps.mark]
 * @param {{main: string, followUp: string}} [deps.phases]  the phase names it writes (DEFAULT_PHASES)
 * @param {Object} [deps.vocabulary]  the other words it writes (COORDINATOR_VOCABULARY)
 */
import { CONTEXTS } from './policy';
import { DEFAULT_PHASES, RESUME_PAUSE, RUN_OWNERS } from './rules';

/**
 * Every other word the coordinator writes into a debug line, a trace mark or the continued
 * task's arguments. Neutral by default; a job whose logs, traces or goldens already speak its
 * own words passes them (`vocabulary`, merged over these) so what it emits does not change.
 *
 *   debugCategory       the debug log category of its lines
 *   beginTask           the event `beginTask` logs
 *   awaitingResume      the trace mark `parkForResume` leaves
 *   followUpPendingKey  the key `syncResignNet` hands `armResignNet` for "a follow-up is owed"
 *                       (createContinuedTask reads `followUpPending`)
 */
export const COORDINATOR_VOCABULARY = Object.freeze({
  debugCategory: 'coordinator',
  beginTask: 'beginTask',
  awaitingResume: 'awaiting_resume',
  followUpPendingKey: 'followUpPending',
});

export function createCoordinator({
  continued,
  isForeground,
  debug = () => {},
  mark = () => {},
  phases = DEFAULT_PHASES,
  vocabulary = null,
}) {
  const { main: MAIN, followUp: FOLLOW_UP } = { ...DEFAULT_PHASES, ...phases };
  const words = { ...COORDINATOR_VOCABULARY, ...vocabulary };
  /** Is the app in front? A probe that throws counts as yes, as `mayOwn` has it. */
  function inFront() {
    try {
      return isForeground() !== false;
    } catch (e) {
      return true;
    }
  }

  /** A FOREGROUND loop needs the app in front; the other owners carry their own licence. */
  function mayOwn(owner) {
    if (owner !== RUN_OWNERS.FOREGROUND) return true;
    try {
      return isForeground() !== false;
    } catch (e) {
      return true;
    }
  }

  /**
   * Work is owed and the app is in front with no task under it: wait for the person.
   * Apple: "Submission needs to occur as a result of a person's action, such as tapping a
   * button" — and tasks submitted at launch, when tried, ran with the process suspended under
   * them. So an automatic start does not run the pass at all where a task could be asked for:
   * it parks (`RESUME_PAUSE`), and the app's UI shows the counted pause with [Resume]. The tap
   * starts the pass AND asks for the task (`start({entry: 'resume'})`). Where no task can ever
   * be had (an older iOS, the Xcode 16 stub) nothing changes: the pass runs as before.
   */
  function mustAskFirst() {
    if (!continued || !inFront()) return false;
    let supported = false;
    try {
      supported = continued.supported?.() === true;
    } catch (e) {
      supported = false;
    }
    if (!supported) return false;
    return !(continued.isLive?.() && !continued.stale?.());
  }

  /**
   * Park for the person's Resume. `caller` is the job's `debugCaller()`, taken in its own frame.
   * `onPark` records that the job is waiting (the return to the app must not unpark it),
   * `setPaused(pauseReason)` publishes the pause, and `getState` is what is returned.
   */
  function parkForResume(kind, {
    caller = null, onPark = () => {}, setPaused, getState = () => null,
  }) {
    debug(words.debugCategory, 'parkForResume', { kind, caller });
    onPark();
    setPaused(RESUME_PAUSE);
    mark(words.awaitingResume, { kind });
    return getState();
  }

  /**
   * Keep native's willResignActive safety net armed exactly while work is running with no task
   * live: a main phase (with its follow-up to come) or a follow-up phase. Everything else
   * disarms it. Cheap and idempotent — called on every publish and every task change.
   *
   * @param {{mainRunning: boolean, followUpRunning: *, line: (phase: string) => string}} work
   *   `followUpRunning` is read for truthiness (a pass's promise will do).
   */
  function syncResignNet({ mainRunning, followUpRunning, line }) {
    if (!continued?.armResignNet) return;
    const live = continued.isLive?.() === true && continued.stale?.() !== true;
    const phase = mainRunning ? MAIN : FOLLOW_UP;
    const armed = !live && (mainRunning || !!followUpRunning);
    continued.armResignNet({
      armed,
      phase,
      // A main phase the net carries is scoped like the tap's: that phase only.
      [words.followUpPendingKey]: false,
      subtitle: armed ? line(phase) : '',
    });
  }

  /**
   * Submit the continued task for work the user started by a tap. Apple's rule is a
   * user action in the foreground: `init(identifier:title:subtitle:)` "creates an instance on
   * behalf of the currently foregrounded app", so it cannot be asked for at the minimise itself
   * — by then the app is not the foregrounded one. It is asked for here, at the tap, and simply
   * keeps running if the user then leaves. `caller` is the job's `debugCaller()`.
   */
  function beginTask({ phase = FOLLOW_UP, caller = null } = {}) {
    debug(words.debugCategory, words.beginTask, {
      has: !!continued, stale: continued?.stale?.() ?? null, live: continued?.isLive?.() ?? null, caller,
    });
    if (!continued) return false;
    // A task iOS has stopped running but nobody ended (an expiry while the app was away, a
    // refusal) is ended first, so this one can be asked for.
    if (continued.stale?.()) continued.end({ complete: false, reason: 'stopped' });
    if (continued.isLive?.()) return false;
    continued.begin({ phase });
    return true;
  }

  /**
   * The minimise, as far as the continued task is concerned. Synchronous, in this order:
   *
   *   1. A task native submitted at willResignActive, for work that had none:
   *      this run's from here, before anything asks whether to keep going. A pass mid-run
   *      (`followUpRunning()`) opens its bar (`openUnits`, not awaited).
   *   2. `leave()`: the job marks itself away and asks its work to stop at a boundary.
   *   3. A foreground pass with the continued task live hands over NOW: its chunk
   *      stops at the next unit and commits what it finished (`stopMidChunk`), and the loop's
   *      next pass is the task's. Waiting out the chunk at background speed left the device's
   *      pass FOREGROUND-owned for about five minutes in one device log.
   */
  function minimiseHandOff({
    followUpRunning, openUnits, leave, passContext, stopMidChunk,
  }) {
    if (continued?.adoptResign?.() && followUpRunning()) openUnits();
    leave();
    if (passContext() === CONTEXTS.FOREGROUND && continued?.isLive?.()) {
      stopMidChunk();
    }
  }

  return {
    inFront, mayOwn, mustAskFirst, parkForResume, syncResignNet, beginTask, minimiseHandOff,
  };
}

export default createCoordinator;
