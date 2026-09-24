/**
 * costBar — where a continued task's system bar stands, from the work actually done. It was
 * built for a three-phase job and generalised; the numbers below come from that job, measured
 * on a real iPhone.
 *
 * ── Why not bands ──────────────────────────────────────────────────────────────────────────
 * The bar used to be three fixed bands: phase one 0–45 %, phase two 45–50 %, phase three 50–100 %.
 * Phase two streaming in the middle of phase one could only move it across 90 % of the NEXT
 * PAGE's share of phase one's band, so in a run in testing 61 units finished in the last minute
 * moved it 0.21 points, after +12.5 in the first minute. iOS asked the tester "Processing is 28%
 * complete. Do you want to continue…?" and expired the task three minutes later. Apple: "if that
 * progression is slower than expected, the system will prompt the initiator" (WWDC25 227,
 * "Finish tasks in the background"); "the system prioritizes the termination of tasks that
 * reflect minimal or no progress" (BGContinuedProcessingTask). A job whose phases have sizes
 * learned late MUST NOT band its bar.
 *
 * ── What it does instead ───────────────────────────────────────────────────────────────────
 * Every report says what just completed, in units of a KIND of work, and each kind has a cost
 * per unit: a moving average of the time it really took on this phone, seeded with a measured
 * value (`seeds`). The bar then advances by
 *
 *     f ← f + (1 − f) · done / (done + remaining)
 *
 * where `done` is the cost of the work that just completed and `remaining` is the job's current
 * estimate of the cost of everything still owed. So:
 *   - it never goes backwards (every step is ≥ 0) and never reaches 1 while work remains;
 *   - it never freezes while work lands: each unit takes its share of what is left, however the
 *     estimate of what is left changes — a total learned late re-scales the rest of the bar,
 *     it does not stall it the way a jump in the denominator stalled the old clamp;
 *   - with a sound estimate it is linear in time, which is the only rate iOS can call "expected".
 *
 * This is the SYSTEM bar only. A feature's own UI keeps its own counts.
 *
 * ── Never full while work is owed ──────────────────────────────────────────────────────────
 * In one run measured on device the bar reached 1.0 while 10,420 units were still owed,
 * stayed full (never backwards) with an ETA of 1 s, and iOS expired a task whose bar said it was finished. So
 * while anything is owed the bar heads for `OWED_CAP`, not 1: each unit of work takes its share
 * of the distance to the cap, and 1 is reached only when nothing is owed and every size is
 * known (`unsized()` false).
 */

/**
 * The most the bar shows while anything is owed. It reaches 1 only when nothing is: in testing
 * it reached 1.0 at the end of one phase with 10,420 units still owed to the next, and iOS expired a
 * task whose bar said it was finished.
 */
export const OWED_CAP = 0.97;

/** Weight of the newest measurement in a moving average. */
const EMA = 0.3;
/** A measurement is held to [seed / 4, seed × 20] so one starved unit cannot run away with it. */
const LOW = 0.25;
const HIGH = 20;

/**
 * @param {Object} args
 * @param {Object<string, number>} args.seeds   ms per unit of each kind, measured in background
 * @param {(cost: Object<string, number>) => number} args.remaining
 *   the estimated cost (ms) of everything still owed, at the current costs
 * @param {() => boolean} args.unsized   is any size still unknown, so `remaining` can grow?
 * @param {() => number} [args.now]
 */
export function createCostBar({ seeds, remaining, unsized, now = Date.now }) {
  const cost = { ...seeds };
  let fraction = 0;
  let lastAt = now();

  /** Fold one measurement (ms per unit) into `kind`'s average. */
  function learn(kind, msPerUnit) {
    if (!Number.isFinite(msPerUnit) || msPerUnit < 0) return;
    const seed = seeds[kind];
    const held = Math.min(seed * HIGH, Math.max(seed * LOW, msPerUnit));
    cost[kind] = cost[kind] * (1 - EMA) + held * EMA;
  }

  /**
   * `units` of `kind` just completed. The time since the previous report of ANY kind is theirs:
   * reports arrive as work completes, and nothing else runs between them on the one JS thread.
   */
  function credit(kind, units) {
    const at = now();
    const elapsed = Math.max(0, at - lastAt);
    lastAt = at;
    if (!(units > 0)) return fraction;
    learn(kind, elapsed / units);
    const done = units * cost[kind];
    const left = remaining(cost);
    if (left <= 0 && !unsized()) {
      fraction = 1;
      return fraction;
    }
    // Owed: head for the cap, never past it (and never back from where it is).
    fraction = Math.max(fraction, fraction + (OWED_CAP - fraction) * (done / (done + left)));
    return fraction;
  }

  return {
    credit,
    /** The clock restarts with no credit: a new pass that starts its count again. */
    restartClock() {
      lastAt = now();
    },
    /** Where the bar stands, 0..1. */
    fraction: () => fraction,
    /** The estimate of what is left, in ms of work — for the ETA the system may be shown. */
    remainingMs: () => Math.round(remaining(cost)),
    /** The moving averages, for the debug log. */
    costs: () => ({ ...cost }),
    /** The live averages, for the job's `remaining` estimate. */
    cost,
  };
}

export default createCostBar;
