/**
 * The example grace-only job: declared, busy while it runs, and a minimise
 * finishes the unit in hand inside the grant, stops at the boundary and hands the grant back.
 */
import { anyBusy } from '../busy';
import { backgroundJob } from '../registry';
import { createGraceOnlyJob } from '../graceOnlyJob';

function appState() {
  return { currentState: 'active', addEventListener: () => ({ remove: () => {} }) };
}

test('a minimise finishes the unit in hand under the grant, then stops at the boundary', async () => {
  const bg = { beginBackgroundTask: jest.fn(), endBackgroundTask: jest.fn() };
  const done = [];
  let release = null;
  const step = jest.fn(() => new Promise((resolve) => {
    release = () => { done.push(done.length); resolve(done.length < 10); };
  }));
  const job = createGraceOnlyJob({ name: 'example-grace', step, appState: appState(), bg });
  expect(backgroundJob('example-grace')).toBe(job.job);

  const run = job.start();
  expect(anyBusy()).toBe(true);
  release();
  await Promise.resolve();
  // The app leaves mid-unit: the grant is taken, the unit in hand finishes, nothing new starts.
  const leaving = job.handleChange('background');
  expect(bg.beginBackgroundTask).toHaveBeenCalledTimes(1);
  await new Promise((r) => setImmediate(r));
  release();
  expect(await run).toBe('stopped');
  await leaving;
  expect(done).toEqual([0, 1]);
  expect(bg.endBackgroundTask).toHaveBeenCalledTimes(1);
  expect(anyBusy()).toBe(false);
  job.dispose();
});
