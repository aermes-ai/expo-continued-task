/**
 * executor — the chunk loop. It was extracted from an app's own background scheduler, where
 * the app's persistent job store is the WorkSource.
 *
 * One responsibility: pop work from a WorkSource in chunks, run `work` on it, commit, and stop
 * at the right moment for the right reason. It knows nothing about the job's data, BGTaskScheduler,
 * React or AppState — the window and the grace grant are handed to it as a `context` and a
 * budget, which is what makes every ending below a Jest test rather than an
 * overnight device protocol.
 *
 * ── The endings, and which one the user hears about ─────────────────────────────────────
 *
 *   empty     the queue is done. Nothing to say.
 *   expired   the OS expiration handler fired, or the assumed budget ran out.
 *   headroom  not enough time for another chunk (measured chunk × 1.5, floor 10 s).
 *   rss       memory growth reached the delta ceiling for this context.
 *   stalled   a chunk moved nothing — every row it read is deferred or failing.
 *   stopped   a caller asked it to stop, at a chunk boundary.
 *   error     `work` threw. The chunk is NOT committed; the next pass redoes it.
 *   idle      a background window is waiting for its conditions (off a charger). Silent.
 *   paused    a guard said no, and it will still say no next time.
 *
 * Only `paused` reaches the user, as `Paused · reason` in the app's UI. The rest are how
 * background work normally ends: the queue picks up where it left off in the next window and
 * nobody needs to be told that iOS handed back the CPU.
 *
 * ── Why a stop request never aborts a chunk ─────────────────────────────────────────────
 * The requirement: "when the app is minimised, the chunk completes within the grace period and
 * the store shows no partial chunk". So an external stop is checked between chunks only. The one signal
 * that reaches INSIDE a chunk is expiry, and even then `work` returns the rows it finished and
 * those are committed — a short chunk, not a torn one. The commit itself should be a single
 * store transaction (`source.commit`), which is where "a kill costs at most one chunk" comes from.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────────────────
 * A commit that advances a row only while its stage is below the target means a chunk redone
 * after a force-quit re-reads the same rows, re-runs the same work and writes nothing. That is
 * the whole of the resume model: no journal, no replay log, just a monotonic stage.
 *
 * ── The WorkSource ──────────────────────────────────────────────────────────────────────
 * What the loop reads and writes is a port, so every job can bring its own:
 *
 *   queue({limit, allowNetwork})  the next chunk of units (each with an `id`), head first
 *   commit(results)               land a chunk: `{advanced, deferred, failed}`, idempotently
 *   checkpoint()                  optional: fold the job's write-ahead log back in after a run
 *   pause.write(reason) / pause.clear() / pause.read()   where the one pause line lives
 */
import { CONTEXTS, STOP_REASONS, headroomFor } from './policy';

/**
 * Stop reading pages with less than this left in the window.
 *
 * In the original job a page was 2,000 items and the native walk measured 7.5 s for 24,187, so
 * a page is a few hundred milliseconds — far cheaper than a chunk, which is why it gets its own,
 * smaller floor rather than `MIN_HEADROOM_MS`. It still needs one: a page that starts with
 * nothing left is a page redone, and upserting 2,000 rows is not free.
 */
export const MIN_READ_HEADROOM_MS = 3000;

const noop = () => {};

/**
 * The words the loop writes into what it hands back and into its log lines. Neutral by default;
 * a job whose logs, telemetry or tests already speak its own domain passes its words
 * (`vocabulary`, merged over these) so nothing it emits changes.
 *
 *   items       the key for how many items were moved: the run's summary, `onChunk`, `onChunkDone`
 *   groupIds    the key for the groups a chunk moved: read from `work`'s result, handed to `onChunk`
 *   groups      the noun in the sweep's log line, and its field
 *   onItem      the per-item listener's name (`setOnItem`) in the line that says it threw
 *   onFollowUp  the `onFollowUp` listener's name in the line that says it failed
 */
export const EXECUTOR_VOCABULARY = Object.freeze({
  items: 'items',
  groupIds: 'groupIds',
  groups: 'groups',
  onItem: 'onItem',
  onFollowUp: 'onFollowUp',
});

/**
 * @param {Object} deps
 * @param {Object} deps.source the WorkSource (see the header)
 * @param {Function} deps.work the chunk worker
 * @param {Object} deps.guards a createGuards() instance
 * @param {Function} deps.decide the policy's `decide`, with the job's pause vocabulary
 * @param {Object} [deps.settings] {allowOnBattery} — off by default
 * @param {() => number} [deps.now] injectable clock
 * @param {(line: string, data?: Object) => void} [deps.log] the job's `exec` log (tee'd)
 * @param {Object} [deps.debug] {debugLog, debugFlush, debugNet, debugCaller}
 * @param {(error, step, context) => Promise} [deps.traceError] a unit of work that threw, traced
 * @param {(fields: Object) => void} [deps.onStall] a chunk that moved nothing
 * @param {(reason: string) => void} [deps.onPaused] a run that ended on a pause
 * @param {(chunk: Object) => void} [deps.onChunkDone] a chunk committed (telemetry)
 * @param {Object} [deps.vocabulary] the words it writes (EXECUTOR_VOCABULARY)
 */
export function createExecutor({
  source,
  work,
  guards,
  decide,
  settings = {},
  // Called once per run when the queue empties, to finalise any groups of work
  // that no chunk touches any more. Optional — a caller without one just
  // ends the run.
  sweep = null,
  /**
   * Called after every chunk COMMITS, with the groups (`groupIds`) it moved.
   *
   * The progress UI is the only thing on screen that says the work is running, and a counter
   * that is read once when the run starts sits at "0/153" until the whole group is
   * done — which is what a device build showed with 1,464 items already processed. The
   * loop is where a commit happens, so the loop is what announces one; the job decides
   * how often to believe it. Never awaited and never allowed to throw: a counter cannot be
   * permitted to end a window.
   */
  onChunk = null,
  /**
   * An optional preparatory leg of the run (e.g. an indexing pass that fills the queue).
   *
   * Optional, and absent it the loop behaves exactly as it did: pop rows, work, commit. When
   * present it is called ONCE, before the first chunk, and only while the same budget that
   * governs a chunk still allows one. It returns `{read, total, complete, pages}`.
   *
   * It goes first because the queue it feeds is the queue the chunk loop reads. A window that
   * worked its way through the rows it already had and then ended would leave the unread half
   * unread for another half hour; reading first means the same window can do both, and a
   * window too short for both at least moves the cursor.
   *
   * A leg that throws does NOT end the run: the job's store should commit its cursor per page,
   * so a failed read costs one page, and the rows already in the queue are still worth a chunk.
   */
  readLeg = null,
  /**
   * The working state, told to whoever owns it — originally for a background WINDOW only.
   * Named for the phase the chunk loop is in a two-phase job: the follow-up to the read leg.
   *
   * The read leg publishes its own state because the job runs it: it sets a "reading" phase,
   * then "done" or "paused". The chunk loop is not the job's, and in the foreground
   * that did not matter — the job's own loop set a "working" phase around it. A window has
   * nothing around it, so days of background work read "done" to every surface that asked the
   * job, and the app's own Live Activity ended its bar. This is the same seam as `readLeg`,
   * pointed the other way: the loop says when work starts and how it ended, and the job
   * decides what that means.
   *
   * Called `{phase: 'start', context}` just before the first `work()` of a window run — so
   * a window that finds nothing to do, or is refused by a guard, says nothing at all — and
   * `{phase: 'end', context, summary}` once the run's ending is known, only if it started.
   * Awaited, so the ending is published before the window is handed back to iOS. Never
   * allowed to throw into the loop.
   */
  onFollowUp = null,
  now = Date.now,
  // Every line also lands in the test-build debug log: the job tees it.
  log = noop,
  debug: {
    debugLog = noop, debugFlush = noop, debugNet = noop, debugCaller = () => null,
  } = {},
  traceError = async () => {},
  onStall = noop,
  onPaused = noop,
  onChunkDone = noop,
  vocabulary = null,
}) {
  const words = { ...EXECUTOR_VOCABULARY, ...vocabulary };
  let chunkListener = onChunk;
  /**
   * Told of every item INSIDE a chunk (`setOnItem`): on one device run under the continued
   * task a 50-item chunk took up to 17 s in the background, and one 31 s gap between chunk
   * commits got the task expired. Progress per item keeps it moving through a slow chunk.
   */
  let itemListener = null;
  let running = false;
  let stopRequested = false;
  /** `requestStop({midChunk})`: the chunk in flight stops at its next item too. */
  let stopMidChunk = false;
  /** The most recent measured chunk, which sets the headroom for the next one. */
  let lastChunkMs = 0;
  /** The reason currently written to the store, so a repeat pause is not re-written. */
  let pausedReason = null;

  function isRunning() {
    return running;
  }

  /**
   * Ask the loop to stop at the next chunk boundary. Never aborts a chunk in flight — unless
   * `midChunk`: then the chunk stops at its next item and commits the items it finished.
   * That is the hand-off from a foreground pass to the continued task's at a
   * minimise: waiting out a 50-item chunk at background speed kept the pass FOREGROUND-owned
   * for minutes on the device.
   */
  function requestStop({ midChunk = false } = {}) {
    debugLog('exec', 'requestStop', { midChunk, running, caller: debugCaller() });
    stopRequested = true;
    if (midChunk) stopMidChunk = true;
  }

  /**
   * Write `Paused · reason` where the UI reads it: one job-level record (`source.pause`), and
   * NOTHING else.
   *
   * ── Why this used to stamp every group, and why it must not ─────────────────────────────
   * An earlier version wrote the reason onto every group of work that still owed work, to stop
   * the rest of the UI showing a live count under a parked pass. The rule was right and the
   * mechanism was not. The status counts skipped a stamped group in all three buckets, so one
   * hot phone turned "17 ready · 82 queued" into "17 ready" and left eighty cards each
   * repeating the same job-wide sentence — the device report that prompted the change.
   *
   * Worse, a fact written into eighty rows has to be un-written from eighty rows before the
   * UI can tell the truth again, and the only path that did it ran after a chunk committed.
   * A phone that cooled down and then found every remaining row waiting on Wi-Fi never got
   * there, so "cooling down" outlived the heat by however long the queue stayed blocked.
   *
   * A device pause is one fact about the job. It is stored once, and the UI derives
   * what it says from it: an unfinished group under a parked job reads as QUEUED, which is
   * what it is. Nothing to un-write, nothing to get stuck.
   */
  async function setPause(reason) {
    if (!reason || pausedReason === reason) return;
    pausedReason = reason;
    try {
      await source.pause.write(reason);
    } catch (error) {
      // A pause line that cannot be written is not worth failing the run over; the guard
      // still stopped the work, which is the part that matters.
      log('setPause failed', { reason, error: error?.message });
    }
  }

  /**
   * Lift the pause: clear the line, and let the source heal any row an older build stamped.
   *
   * In the original job, groups that still had queued items went back to "working"; groups
   * whose items were all done went to "ready", because a paused card with nothing left to do
   * is a lie either way round — and resetting to the initial state would look like the pass had
   * never started AND could expose the group to cleanup that deletes unstarted groups.
   *
   * ── Why it no longer gives up when the pause record is empty ────────────────────────────
   * The two writes are not atomic: clearing the job-level record first and the per-group rows
   * second meant a kill between them left rows stamped with nothing to say they were. On the
   * next launch `pausedReason` is null and the record is empty, and an early return made that
   * state permanent — the UI said "Paused" for the life of the install. A one-off migration
   * heals devices already in that state; this keeps new ones out of it. Since nothing writes
   * the per-group stamp any more, on a healthy device this costs one query.
   */
  async function clearPause() {
    pausedReason = null;
    try {
      await source.pause.clear();
    } catch (error) {
      log('clearPause failed', { error: error?.message });
    }
  }

  /**
   * Run chunks until one of the endings above.
   *
   * @param {Object} args
   * @param {string} args.context one of CONTEXTS
   * @param {boolean} [args.tapInitiated] the user started this and is watching
   * @param {boolean} [args.allowNetwork] include `needs_network` rows (Wi-Fi + power only)
   * @param {number} [args.maxChunks] cap for tests and for the grace grant
   * @returns {Promise<{chunks: number, items: number, stop: string, pauseReason: string|null,
   *                    ms: number, deferred: number, failed: number, error: string|null}>}
   *   `items` under the key `vocabulary.items` names.
   */
  async function run({
    context = CONTEXTS.FOREGROUND,
    tapInitiated = false,
    allowNetwork = false,
    maxChunks = Infinity,
  } = {}) {
    if (running) {
      return {
        chunks: 0, [words.items]: 0, stop: STOP_REASONS.STOPPED, pauseReason: null, idleReason: null,
        ms: 0, deferred: 0, failed: 0, error: null, skipped: 'already_running',
      };
    }
    running = true;
    stopRequested = false;
    stopMidChunk = false;
    const startedAt = now();
    guards.startRun(context);
    debugLog('exec', 'run.start', { context, tapInitiated, allowNetwork, maxChunks: Number.isFinite(maxChunks) ? maxChunks : null });
    debugNet({ context });
    /** When `shouldStop` first said yes inside a chunk, and why (for the debug log). */
    let stopLanded = false;

    let chunks = 0;
    let items = 0;
    /** Items the read leg walked into the store this run, and whether it finished. */
    let assetsRead = 0;
    let readComplete = null;
    let readRan = false;
    let sweptOnce = false;
    let deferred = 0;
    let failed = 0;
    let stop = STOP_REASONS.EMPTY;
    let pauseReason = null;
    let idleReason = null;
    let errorMessage = null;
    /** Did the guards ever say proceed? See the pause handling after the loop. */
    let cleared = false;
    /**
     * Has `onFollowUp` been told this run is working?
     *
     * Foreground runs tell it now too (from a device report). It used to be windows only,
     * on the premise that anything else was the job's own foreground loop, which
     * publishes its own states. Two runs were not: the scheduler's ambient pass on every
     * return to the app, and a priority pass when the user opened one group. Both worked under
     * a UI that said "done" — "while it works inside I only see the pills, no updates". The job
     * decides what an announcement means: a loop it owns ignores it.
     */
    let followUpAnnounced = false;

    try {
      for (;;) {
        if (stopRequested) { stop = STOP_REASONS.STOPPED; break; }
        if (chunks >= maxChunks) { stop = STOP_REASONS.STOPPED; break; }

        const reading = guards.read();
        const verdict = decide({ context, tapInitiated, reading, settings });
        debugLog('exec', 'guards', {
          context, chunks, ...reading, proceed: verdict.proceed, pauseReason: verdict.pauseReason || null,
          idleReason: verdict.idleReason || null, chunkSize: verdict.chunkSize ?? null, ceilingMb: verdict.ceilingMb ?? null,
          budget: guards.budget(context),
        });
        if (!verdict.proceed) {
          // A pause is a line the user reads; an idle is the resting state and says nothing.
          stop = verdict.pauseReason ? STOP_REASONS.PAUSED : STOP_REASONS.IDLE;
          pauseReason = verdict.pauseReason;
          idleReason = verdict.idleReason;
          break;
        }
        /**
         * The guards said yes at least once, so whatever they last said no about is over.
         * Read at the end of the run to decide whether the pause line still stands.
         */
        cleared = true;

        const budget = guards.budget(context);
        if (budget.expired) { stop = STOP_REASONS.EXPIRED; break; }
        if (budget.rssDeltaMb >= 0 && budget.rssDeltaMb >= verdict.ceilingMb) {
          stop = STOP_REASONS.RSS;
          break;
        }
        // Never start a chunk we cannot finish. Before the first measurement this
        // uses the assumed chunk time, which is why the first chunk of a window is the one
        // that can be cut short — and why it is committed on its own.
        if (budget.remainingMs < headroomFor(lastChunkMs)) {
          stop = STOP_REASONS.HEADROOM;
          break;
        }

        // The read leg. Once per run, here — after the guards and the budget have
        // said yes for the first time, so it is held back by heat, a flat battery and a
        // window with no room exactly as a chunk is, and before the queue is read, because
        // it is what fills that queue.
        if (readLeg && !readRan) {
          readRan = true;
          try {
            // eslint-disable-next-line no-await-in-loop
            const leg = await readLeg({
              context,
              // The same signal a chunk gets. The read commits per PAGE, so honouring this
              // between pages is what keeps "a kill costs at most one page" true.
              shouldStop: () => {
                const b = guards.budget(context);
                return b.expired || b.remainingMs < MIN_READ_HEADROOM_MS;
              },
              // The window's clock itself, so the leg can hold back a page it has TIMED as
              // longer than what is left — the 3 s floor above was set for a page of a few
              // hundred ms, and a background page measured 18–43 s on device.
              remainingMs: () => {
                const b = guards.budget(context);
                return b.expired ? 0 : b.remainingMs;
              },
            });
            if (leg) {
              assetsRead = Math.max(0, Number(leg.pages) || 0);
              readComplete = leg.complete === true;
              if (leg.skipped) log('read leg skipped', { reason: leg.skipped });
              else log('read leg done', { assets: assetsRead, complete: readComplete });
            }
          } catch (error) {
            // Not an ending. Pages already committed stay committed and the queue they fed
            // is still worth a chunk; the next window re-tries the read from the cursor.
            log('read leg failed', { error: error?.message });
          }
          // eslint-disable-next-line no-continue
          continue;
        }

        let rows;
        const queueAt = now();
        try {
          // eslint-disable-next-line no-await-in-loop
          rows = await source.queue({ limit: verdict.chunkSize, allowNetwork });
        } catch (error) {
          // The commonest cause is a store that is not open yet — a window that
          // arrived before the provider finished init. Ending the run cleanly lets
          // the next window try again; throwing would leave the window unreleased.
          stop = STOP_REASONS.ERROR;
          errorMessage = error?.message || String(error);
          log('workQueue failed', { error: errorMessage });
          // eslint-disable-next-line no-await-in-loop
          await traceError(error, 'queue', context);
          break;
        }
        debugLog('exec', 'queue', { context, rows: rows.length, ms: now() - queueAt, head: rows[0]?.id ?? null });
        if (!rows.length) {
          // Before calling it empty: a group whose last item finished in the last
          // chunk of a previous run was never revisited, so it was never
          // finalised and its UI still says "working". One
          // sweep per run, and only when the queue has nothing left, so it
          // costs a single query on the common path.
          if (!sweptOnce && typeof sweep === 'function') {
            sweptOnce = true;
            try {
              // eslint-disable-next-line no-await-in-loop
              const swept = await sweep();
              if (swept > 0) { log(`swept ${words.groups} awaiting verdicts`, { [words.groups]: swept }); continue; }
            } catch (error) {
              log('sweep failed', { error: error?.message });
            }
          }
          stop = STOP_REASONS.EMPTY;
          break;
        }

        // WINDOW and FOREGROUND: the two contexts a visible screen can be watching. GRACE and
        // CONTINUED run only with the app away, and CONTINUED passes are always the job
        // loop's own — publishing for them would speak to the Lock Screen's one-indicator
        // logic (see createIndicatorPublisher), which is not this hook's to change.
        if (!followUpAnnounced && onFollowUp && (context === CONTEXTS.WINDOW || context === CONTEXTS.FOREGROUND)) {
          followUpAnnounced = true;
          // eslint-disable-next-line no-await-in-loop
          await tellFollowUp({ phase: 'start', context });
        }

        const chunkStart = now();
        let result;
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await work(rows, {
            context,
            remainingMs: budget.remainingMs,
            // The ONE signal that reaches inside a chunk. A worker that honours it returns
            // the rows it finished; those are committed, the rest are redone.
            shouldStop: () => {
              const budgetNow = guards.budget(context);
              const yes = stopMidChunk || budgetNow.expired;
              if (yes && !stopLanded) {
                stopLanded = true;
                debugLog('exec', 'stop.landed', {
                  context, midChunk: stopMidChunk, expired: budgetNow.expired, sinceChunkMs: now() - chunkStart,
                });
                debugFlush();
              }
              return yes;
            },
            // Per item, as the worker finishes each one. Never allowed to fail the chunk.
            onProgress: (p) => {
              if (!itemListener) return;
              try {
                itemListener({ context, done: p?.done ?? 0, total: p?.total ?? 0 });
              } catch (error) {
                log(`${words.onItem} threw`, { error: error?.message });
              }
            },
          });
        } catch (error) {
          // Nothing is committed: the chunk's rows stay where they were and the next pass
          // runs them again. This is the failure mode the idempotent commit is designed for.
          stop = STOP_REASONS.ERROR;
          errorMessage = error?.message || String(error);
          log('chunk threw', { error: errorMessage });
          // eslint-disable-next-line no-await-in-loop
          await traceError(error, 'chunk', context);
          break;
        }
        lastChunkMs = now() - chunkStart;
        debugLog('exec', 'work', {
          context, rows: rows.length, ms: lastChunkMs, results: result?.results?.length ?? 0, pause: result?.pause || null,
        });

        let committed;
        const commitAt = now();
        try {
          // eslint-disable-next-line no-await-in-loop
          committed = await source.commit(result?.results ?? []);
        } catch (error) {
          // The chunk ran but did not land. Its rows are untouched, so the next
          // pass redoes exactly this chunk — the one-chunk cost the design allows.
          stop = STOP_REASONS.ERROR;
          errorMessage = error?.message || String(error);
          log('commitChunk failed', { error: errorMessage });
          // eslint-disable-next-line no-await-in-loop
          await traceError(error, 'commit', context);
          break;
        }
        debugLog('exec', 'commit', {
          context, ms: now() - commitAt, advanced: committed.advanced, deferred: committed.deferred,
          failed: committed.failed, budget: guards.budget(context),
        });
        chunks += 1;
        items += committed.advanced;
        deferred += committed.deferred;
        failed += committed.failed;

        onChunkDone({
          context,
          [words.items]: committed.advanced,
          ms: lastChunkMs,
          reading,
          budget,
          offlineShare: result?.offlineShare,
        });

        announceChunk({
          context,
          [words.groupIds]: result?.[words.groupIds] ?? [],
          // The queue's head: the item this chunk had in hand.
          assetId: rows[0]?.id ?? null,
          [words.items]: committed.advanced,
          deferred: committed.deferred,
          failed: committed.failed,
        });

        // A worker can raise a pause of its own, for a condition no device guard can see:
        // e.g. an 88 MB model the work needs is not on disk, and nothing downloads it inside a
        // chunk. It is read AFTER the commit so a chunk that processed some items and then hit
        // the missing model still banks what it did.
        if (result?.pause) {
          stop = STOP_REASONS.PAUSED;
          pauseReason = result.pause;
          break;
        }

        // A chunk that moved nothing has read a queue head it cannot move — every row
        // deferred for network or failing. Looping on it burns the window for no progress.
        // Except when the budget ran out under it (seen in a device log): the continued task
        // expired, the chunk stopped before its first item, and "stalled" became
        // `waiting_for_wifi` on a phone sitting on home Wi-Fi. That is an expiry. A minimise
        // that cut it before an item is a stop, not a stall, for the same reason. There is no
        // network probe behind `waiting_for_wifi`: it is this branch's name for itself, so the
        // mark carries what it actually saw.
        if (committed.advanced === 0) {
          const spent = guards.budget(context);
          if (spent.expired) stop = STOP_REASONS.EXPIRED;
          else if (stopMidChunk) stop = STOP_REASONS.STOPPED;
          else stop = STOP_REASONS.STALLED;
          onStall({
            context,
            stop,
            rows: rows.length,
            deferred: committed.deferred,
            failed: committed.failed,
            budgetExpired: spent.expired,
            remainingMs: Number.isFinite(spent.remainingMs) ? Math.round(spent.remainingMs) : null,
            midChunk: stopMidChunk,
            allowNetwork,
          });
          break;
        }
      }
    } finally {
      guards.endRun();
      running = false;
      /**
       * Fold the write-ahead log back in now the loop has stopped writing.
       *
       * A run is hundreds of committed chunks and, with the read leg, thousands of upserted
       * rows — all of it landing in the WAL, which SQLite only folds back when a writer
       * happens to find it long enough AND no reader is holding a snapshot. On a phone where
       * the list is always mounted, that second condition is rarely true and the file just
       * grows: 93.5 MB of it on the device where this was found.
       *
       * Passive, so it yields to a reader rather than blocking one, and awaited so a window
       * does not hand back its budget mid-checkpoint.
       */
      if (typeof source.checkpoint === 'function') {
        try { await source.checkpoint(); } catch (error) { /* a large file is not a failure */ }
      }
    }

    if (stop === STOP_REASONS.PAUSED && pauseReason) {
      await setPause(pauseReason);
      onPaused(pauseReason);
    } else if (cleared) {
      /**
       * Getting past the guards is what makes the old reason untrue — not committing a
       * chunk.
       *
       * `chunks > 0` was the gate, and it is the wrong question. A phone that cooled down,
       * started a pass and found every remaining row waiting on Wi-Fi ends `stalled` with
       * nothing committed, so the stale "Your phone is cooling down" stayed up over a cold
       * phone for as long as the queue stayed blocked. The heat was gone the moment the
       * guard said proceed; that is the moment to stop saying it.
       *
       * An IDLE run never reaches this — `decide` refused before the flag is set — so a
       * background window off a charger still says nothing, as the power rule requires.
       */
      await clearPause();
    }

    const summary = {
      chunks,
      [words.items]: items,
      deferred,
      failed,
      stop,
      pauseReason,
      idleReason,
      error: errorMessage,
      // `readComplete` is null when no read leg ran, which is not the same as a
      // leg that ran and found the source unfinished — the arming rule cares about the
      // difference and so does the window log.
      assetsRead,
      readComplete,
      ms: now() - startedAt,
    };
    debugLog('exec', 'run.end', { context, ...summary });
    debugFlush();
    if (followUpAnnounced) await tellFollowUp({ phase: 'end', context, summary });
    return summary;
  }

  /** `onFollowUp`, awaited and fenced: a state publish must never be able to end a window. */
  async function tellFollowUp(event) {
    try {
      await onFollowUp(event);
    } catch (error) {
      log(`${words.onFollowUp} failed`, { phase: event.phase, error: error?.message });
    }
  }

  /** Tell whoever is listening that a chunk landed. Their failure is never ours. */
  function announceChunk(info) {
    if (!chunkListener) return;
    try {
      const result = chunkListener(info);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => log('onChunk rejected', { error: error?.message }));
      }
    } catch (error) {
      log('onChunk threw', { error: error?.message });
    }
  }

  /** The reason the source currently carries, for the UI on a cold start. */
  async function storedPauseReason() {
    try {
      const value = await source.pause.read();
      return value || null;
    } catch (error) {
      return null;
    }
  }

  return {
    run,
    requestStop,
    isRunning,
    /**
     * Register the chunk listener after construction.
     *
     * An app typically builds the scheduler before the job — the job takes the scheduler
     * as a dependency — so the job cannot be handed over at construction time and
     * registers itself instead.
     */
    setOnChunk: (fn) => { chunkListener = typeof fn === 'function' ? fn : null; },
    setOnItem: (fn) => { itemListener = typeof fn === 'function' ? fn : null; },
    setPause,
    clearPause,
    storedPauseReason,
    /** Test seam: the measured chunk time that sets the next headroom. */
    __lastChunkMs: () => lastChunkMs,
  };
}

export default createExecutor;
