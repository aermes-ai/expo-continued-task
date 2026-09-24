/**
 * An example job that needs only the grace tier: the ~30 s iOS grants after a
 * minimise. No continued task, no windows, no Live Activity — the smallest thing that is still
 * correct: it is declared, it says when it is busy, it finishes the unit in hand and stops at a
 * boundary when the app leaves, and it hands the grant back.
 *
 * Copy this shape for work that is short and must not be torn in half by a minimise (a queue of
 * small uploads, a cache flush). Anything longer than the grant needs the continued tier and a
 * person's tap: see README.md.
 */
import { defineBackgroundJob } from './registry';
import { createForegroundBridge } from './foregroundBridge';

/**
 * @param {Object} deps
 * @param {string} deps.name  the job's unique name
 * @param {() => Promise<boolean>} deps.step  one unit of work; resolves false when there is none left
 * @param {Object} deps.appState  react-native's AppState
 * @param {Object} deps.bg  the native bridge, native.js (begin/end the grace grant)
 */
export function createGraceOnlyJob({ name, step, appState, bg }) {
  const job = defineBackgroundJob({ name, description: 'example: grace tier only' });
  let running = null;
  let stopRequested = false;

  /** Units until the queue is empty or a stop is asked for — checked only between units. */
  async function loop() {
    stopRequested = false;
    for (;;) {
      if (stopRequested) return 'stopped';
      const more = await step();
      if (!more) return 'empty';
    }
  }

  function start() {
    if (!running) {
      running = loop().finally(() => {
        running = null;
        job.announceBusy();
      });
      job.announceBusy();
    }
    return running;
  }

  const offBusy = job.registerBusy(() => running != null);
  // The grant is held around the WAIT for the unit in flight, never around new work.
  const bridge = createForegroundBridge({
    appState,
    bg,
    onMinimise: async () => {
      stopRequested = true;
      await running;
    },
    onForeground: async () => {},
  });
  const offBridge = bridge.start();

  return {
    job,
    start,
    isRunning: () => running != null,
    /** Exposed for tests: drive AppState without an emitter. */
    handleChange: bridge.handleChange,
    dispose() {
      offBridge();
      offBusy();
    },
  };
}

export default createGraceOnlyJob;
