/**
 * foregroundBridge — AppState, and the 30 s grace grant around a minimise.
 *
 * Two events matter and nothing else does:
 *
 *   → background   take the `beginBackgroundTask` grant, let the chunk in flight finish and
 *                  commit, release the grant. The requirement: "the chunk completes within the
 *                  grace period and the job's store shows no partial chunk".
 *   → active       release anything still held, and resume.
 *
 * `inactive` is deliberately ignored. It fires for a Control Centre pull-down, a notification
 * banner and the app switcher — moments the user is still in the app. Treating those as a
 * minimise would stop the loop several times a minute for no reason.
 *
 * The grant is held around the WAIT, not around the work: the executor is asked to stop at the
 * next chunk boundary and then awaited. So the grant covers exactly the tail of the chunk that
 * was already running, which is what iOS grants it for, and is released the moment that chunk
 * commits rather than being sat on for the full ~30 s.
 */
const noop = async () => {};

/**
 * @param {Object} deps
 * @param {() => Promise<void>} [deps.onMinimise] settle whatever is in flight; awaited inside
 *   the grace grant
 * @param {() => Promise<void>} [deps.onForeground] resume
 * @param {Object} deps.appState react-native's AppState (injected: the package imports no RN)
 * @param {Object} deps.bg the native bridge, native.js (injected: this module imports no native module)
 * @param {(line: string, data?: Object) => void} [deps.log]
 */
export function createForegroundBridge({
  onMinimise = noop,
  onForeground = noop,
  appState,
  bg,
  log = () => {},
}) {
  let subscription = null;
  /** The last state we ACTED on, so a background→inactive→background run fires once. */
  let last = appState?.currentState || 'active';
  /** Set while the grace handler is in flight, so two rapid minimises share one grant. */
  let settling = null;

  async function handleBackground() {
    if (settling) return settling;
    let granted = false;
    settling = (async () => {
      try {
        bg.beginBackgroundTask?.();
        granted = true;
        await onMinimise();
      } catch (error) {
        log('grace handler failed', { error: error?.message });
      } finally {
        if (granted) {
          try { bg.endBackgroundTask?.(); } catch (e) { /* the grant expires on its own */ }
        }
        settling = null;
      }
    })();
    return settling;
  }

  async function handleActive() {
    // A minimise still settling when the user comes back: let it finish first, so the resume
    // never starts a second run alongside the one being parked.
    if (settling) {
      try { await settling; } catch (e) { /* already logged */ }
    }
    try {
      await onForeground();
    } catch (error) {
      log('foreground handler failed', { error: error?.message });
    }
  }

  /** Exposed so tests can drive the transition without an emitter. */
  async function handleChange(next) {
    if (next === last) return undefined;
    last = next;
    if (next === 'background') return handleBackground();
    if (next === 'active') return handleActive();
    // 'inactive' and anything new iOS invents: remembered, not acted on.
    return undefined;
  }

  function start() {
    if (subscription) return stop;
    last = appState?.currentState || 'active';
    subscription = appState.addEventListener('change', (next) => {
      // Fire and forget: AppState listeners are synchronous, and the grace grant is what
      // keeps the work alive past the return, not the listener's stack.
      handleChange(next);
    });
    return stop;
  }

  function stop() {
    subscription?.remove?.();
    subscription = null;
  }

  return { start, stop, handleChange, isSettling: () => settling != null };
}

export default createForegroundBridge;
