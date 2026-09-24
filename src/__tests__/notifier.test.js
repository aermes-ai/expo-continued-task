/**
 * createNotifier's namespace: a neutral one by default, and a second job's entirely its
 * own — its data key on every notification, its dead-man id, its dedupe row.
 */
import { DEFAULT_NAMESPACE, createNotifier } from '../createNotifier';

test('the default namespace is neutral: no app\'s names', () => {
  expect(DEFAULT_NAMESPACE).toEqual({
    dataKey: 'expoContinuedTask', deadmanId: 'expo-continued-task-deadman', dedupeKey: 'expoContinuedTask.notify.dedupe',
  });
});

function fakes() {
  const kv = new Map();
  const sent = [];
  return {
    kv,
    sent,
    store: { kvGet: async (k) => kv.get(k) ?? null, kvSet: async (k, v) => { kv.set(k, v); } },
    Notifications: {
      getPermissionsAsync: async () => ({ status: 'granted' }),
      scheduleNotificationAsync: async (request) => { sent.push(request); return `n${sent.length}`; },
      cancelScheduledNotificationAsync: async () => {},
    },
  };
}

test('another job\'s namespace: its key, its dead-man, its dedupe row; taps of other keys are not its', async () => {
  const f = fakes();
  const notifier = createNotifier({
    Notifications: f.Notifications,
    appState: () => 'background',
    store: f.store,
    namespace: { dataKey: 'uploads_v1', deadmanId: 'uploads-deadman', dedupeKey: 'uploads.dedupe' },
    copyFor: ({ done }) => (done ? { title: 'Uploaded', body: 'b', action: 'review', reason: 'done' } : null),
    stalledCopy: () => ({ title: 'Paused', body: 'Tap to resume' }),
  });
  await notifier.beginRun();
  expect(await notifier.feedDeadman()).toBe('armed');
  expect(await notifier.notify({ done: true })).toBe('sent');
  expect(await notifier.notify({ done: true })).toBe('dedupe');
  expect(f.sent[0]).toMatchObject({ identifier: 'uploads-deadman', content: { data: { uploads_v1: true, action: 'resume' } } });
  expect(f.sent[1].content.data).toMatchObject({ uploads_v1: true, action: 'review', reason: 'done' });
  expect(JSON.parse(f.kv.get('uploads.dedupe'))).toMatchObject({ run: 1, sent: ['done'] });
  expect(f.kv.has(DEFAULT_NAMESPACE.dedupeKey)).toBe(false);
  const tap = (data) => ({ notification: { request: { identifier: `t${Math.random()}`, content: { data } } } });
  expect(await notifier.handleResponse(tap({ expoContinuedTask: true, action: 'review' }), {})).toBe(false);
  expect(await notifier.handleResponse(tap({ uploads_v1: true, action: 'review' }), { top: () => {} })).toBe(true);
});
