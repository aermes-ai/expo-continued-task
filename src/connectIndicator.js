/**
 * Wire an indicator publisher to what moves it (first written for an app's own Live Activity,
 * then generalised so any job's indicator can be wired the same way).
 *
 * Every source publishes on its own schedule: the job's state transitions (synchronously, so a
 * window's ending is on the Lock Screen before the CPU is handed back), anything else the bar
 * draws from, and the continued task's banner coming and going. AppState is the one that also
 * RE-ASSERTS: back in front, `resync` forgets what was believed while away and the publish that
 * follows starts a bar if one is owed (a device build showed none after a return). The way OUT
 * matters as much as the way in: on a minimise JS is about to stop running, so the publish writes the last thing that
 * is actually true — a parked pass as paused — before the CPU goes.
 *
 * @param {Object} deps
 * @param {{publish: Function, resync: Function, dispose: Function, showDone: Function}} deps.publisher
 * @param {Array<(publish: () => void) => (() => void)|null>} deps.sources  each subscribes and
 *   returns its unsubscribe (or null)
 * @param {(listener: (state: string) => void) => (() => void)} deps.subscribeAppState
 * @returns {{publish: Function, showDone: Function, disconnect: Function}}
 */
export function connectIndicator({ publisher, sources = [], subscribeAppState }) {
  const offs = sources.map((subscribe) => subscribe(() => publisher.publish()) || null);
  const offAppState = subscribeAppState((state) => {
    // Back in front, every bar owed is re-asserted with a `start`.
    if (state === 'active') publisher.resync();
    if (state === 'active' || state === 'background') publisher.publish(state);
  });
  publisher.publish();
  return {
    publish: publisher.publish,
    showDone: publisher.showDone,
    disconnect: () => {
      offs.forEach((off) => off?.());
      offAppState?.();
      publisher.dispose();
    },
  };
}

export default connectIndicator;
