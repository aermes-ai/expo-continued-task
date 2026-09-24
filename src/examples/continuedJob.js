/**
 * An example long, user-started job on `createContinuedJob`: export a list of items,
 * one at a time, with the system progress banner — started from a tap, carried on after a
 * minimise while iOS runs the task, paused (never "Failed") if iOS stops it, and a notification
 * either way before the task ends.
 *
 * Wire it in the app:
 *
 *   import { AppState } from 'react-native';
 *   import * as bgTask from '@aermes/expo-continued-task';
 *   import * as Notifications from 'expo-notifications';
 *   const exporter = createExportJob({ items, exportOne, bg: bgTask, appState: AppState, Notifications });
 *   <Button onPress={() => exporter.start()} />    // a person's tap, app in front
 *   useEffect(() => exporter.listen({ open, top, resume: () => exporter.start(), canResume: () => true }), []);
 */
import { createContinuedJob } from '../createContinuedJob';

export function createExportJob({
  items, exportOne, bg, appState, Notifications = null, store = null, name = 'example-export',
  taskPrefix = null, logDir = null,
}) {
  let next = 0;
  return createContinuedJob({
    name,
    taskPrefix,
    logDir,
    bg,
    appState,
    size: () => items.length - next,
    step: async () => {
      await exportOne(items[next]);
      next += 1;
      return next < items.length;
    },
    // Measured on device, per item, in the background — the bar's seed. A guess is fine to start;
    // the moving average corrects it within a few items.
    seedMs: 500,
    words: {
      title: 'Exporting photos',
      line: ({ done, total }) => `${done} of ${total} · on iPhone`,
      done: ({ total }) => `${total} exported`,
    },
    notifications: Notifications ? {
      Notifications,
      store,
      done: { title: 'Export finished', body: 'Your photos are ready' },
      paused: { title: 'Export paused', body: 'Tap to resume · on this iPhone' },
    } : null,
  });
}

export default createExportJob;
