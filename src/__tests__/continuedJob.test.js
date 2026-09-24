/**
 * createContinuedJob through the example export job: the acceptance criteria, against a
 * recorded native bridge and expo-notifications on one timeline.
 */
import { anyBusy } from '../busy';
import { createExportJob } from '../examples/continuedJob';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function world({ supported = true } = {}) {
  const timeline = [];
  const bg = {
    phase: 'none',
    progress: [],
    beginBackgroundTask: () => timeline.push('grant.begin'),
    endBackgroundTask: () => timeline.push('grant.end'),
    remainingMs: () => 30000,
    continuedSupported: () => supported,
    beginContinuedTask: jest.fn(async (args) => { timeline.push(['begin', args]); bg.phase = 'running'; return { ok: true }; }),
    reportContinuedProgress: (completed, total, subtitle) => bg.progress.push({ completed, total, subtitle }),
    canRetitleContinued: () => true,
    retitleContinued: (title, subtitle) => timeline.push(['retitle', title, subtitle]),
    endContinuedTask: (success) => { timeline.push(['setTaskCompleted', success]); bg.phase = 'ended'; },
    continuedTaskState: () => bg.phase,
  };
  const appState = { currentState: 'active', addEventListener: () => ({ remove: () => {} }) };
  const Notifications = {
    getPermissionsAsync: async () => ({ status: 'granted' }),
    scheduleNotificationAsync: async (request) => {
      timeline.push(['notify', request.content.title, request.identifier || null]);
      return 'n';
    },
    cancelScheduledNotificationAsync: async (id) => timeline.push(['cancel', id]),
  };
  return { timeline, bg, appState, Notifications };
}

/** An export whose items resolve when told, so a test can act between them. */
function gatedExport(w, count, name) {
  const gates = [];
  const exportOne = () => new Promise((resolve) => gates.push(resolve));
  const job = createExportJob({
    items: Array.from({ length: count }, (_, i) => i), exportOne, bg: w.bg, appState: w.appState, Notifications: w.Notifications, name,
  });
  const next = async () => { while (!gates.length) await flush(); gates.shift()(); await flush(); };
  return { job, next };
}

const leave = async (w, job) => { w.appState.currentState = 'background'; await job.handleChange('background'); };

test('a tap runs it under the task; the bar advances, ends filled, a success, with the done line', async () => {
  const w = world();
  const { job, next } = gatedExport(w, 3, 'ac1');
  const run = job.start();
  expect(anyBusy()).toBe(true);
  for (let i = 0; i < 3; i += 1) await next();
  expect(await run).toMatchObject({ complete: true, done: 3 });
  // No prefix set: the submission is the config plugin's own (its taskIdentifierPrefix).
  expect(w.bg.beginContinuedTask.mock.calls[0][0]).toEqual({ title: 'Exporting photos', subtitle: '0 of 3 · on iPhone' });
  // One report per unit, each further along; under 100 % while units are owed, full at the last.
  const moving = w.bg.progress.slice(0, -1).map((p) => p.completed);
  moving.forEach((c, i) => { if (i > 0) expect(c).toBeGreaterThan(moving[i - 1]); });
  expect(moving.slice(0, -1).every((c) => c < 100000)).toBe(true);
  expect(moving.at(-1)).toBe(100000);
  expect(w.bg.progress.at(-1)).toEqual({ completed: 100000, total: 100000, subtitle: '3 exported' });
  expect(w.timeline.filter((e) => e[0] === 'setTaskCompleted')).toEqual([['setTaskCompleted', true]]);
  expect(anyBusy()).toBe(false);
  job.dispose();
});

test('a minimise while the task runs changes nothing — the rest runs away', async () => {
  const w = world();
  const { job, next } = gatedExport(w, 4, 'ac2');
  const run = job.start();
  await next();
  await leave(w, job);
  for (let i = 0; i < 3; i += 1) await next();
  expect(await run).toMatchObject({ complete: true, done: 4 });
  // Away, the done notification goes out before the task is completed.
  const order = w.timeline.map((e) => (Array.isArray(e) ? e[0] : e));
  expect(order.indexOf('notify')).toBeLessThan(order.indexOf('setTaskCompleted'));
  job.dispose();
});

test('iOS expires the task away — stops at the boundary, "Paused" and success:true, the paused notification first', async () => {
  const w = world();
  const { job, next } = gatedExport(w, 5, 'ac3');
  const run = job.start();
  await next();
  await leave(w, job);
  w.bg.phase = 'expired';
  await next();
  expect(await run).toMatchObject({ complete: false, done: 2 });
  const ends = w.timeline.filter((e) => e[0] === 'setTaskCompleted');
  expect(ends).toEqual([['setTaskCompleted', true]]);
  expect(w.timeline).toContainEqual(['retitle', 'Paused', 'Tap to resume']);
  expect(w.bg.progress.at(-1)).toMatchObject({ completed: 100000, total: 100000 });
  const i = w.timeline.findIndex((e) => e[0] === 'notify' && e[1] === 'Export paused' && e[2] === null);
  expect(i).toBeGreaterThan(-1);
  expect(i).toBeLessThan(w.timeline.findIndex((e) => e[0] === 'setTaskCompleted'));
  job.dispose();
});

test('no continued task on this binary — the unit in hand finishes under the grace grant, then it stops', async () => {
  const w = world({ supported: false });
  const { job, next } = gatedExport(w, 5, 'ac4');
  const run = job.start();
  await next();
  const leaving = leave(w, job);
  await next();
  expect(await run).toMatchObject({ complete: false, done: 2 });
  await leaving;
  expect(w.bg.beginContinuedTask).not.toHaveBeenCalled();
  expect(w.timeline.filter((e) => typeof e === 'string')).toEqual(['grant.begin', 'grant.end']);
  // Still told, even with no task to end.
  expect(w.timeline).toContainEqual(['notify', 'Export paused', null]);
  expect(anyBusy()).toBe(false);
  job.dispose();
});

test('a job under its own prefix and log folder', async () => {
  const w = world();
  const gates = [];
  const job = createExportJob({
    items: [1], exportOne: () => new Promise((resolve) => gates.push(resolve)), bg: w.bg, appState: w.appState,
    name: 'prefixed', taskPrefix: 'com.example.app.work.export', logDir: 'export',
  });
  const run = job.start();
  while (!gates.length) await flush();
  gates.shift()();
  await run;
  expect(w.bg.beginContinuedTask.mock.calls[0][0]).toMatchObject({ prefix: 'com.example.app.work.export', logDir: 'export' });
  job.dispose();
});
