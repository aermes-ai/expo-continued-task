/** defineBackgroundJob: a declared job is in the app-wide busy question. */
import { anyBusy } from '../busy';
import { backgroundJob, backgroundJobs, defineBackgroundJob } from '../registry';

test('a job registers its busy answer under its name, and anyBusy hears it', () => {
  const job = defineBackgroundJob({ name: 'uploads', identifiers: { kv: { cursor: 'uploads.cursor' } } });
  expect(backgroundJob('uploads')).toBe(job);
  expect(backgroundJobs().map((j) => j.name)).toContain('uploads');
  expect(anyBusy()).toBe(false);
  const off = job.registerBusy(() => true);
  expect(job.isBusy()).toBe(true);
  expect(anyBusy()).toBe(true);
  off();
  expect(anyBusy()).toBe(false);
});

test('defining a name twice returns the first job, unchanged', () => {
  const first = defineBackgroundJob({ name: 'twice', description: 'a' });
  expect(defineBackgroundJob({ name: 'twice', description: 'b' })).toBe(first);
  expect(first.description).toBe('a');
  expect(() => defineBackgroundJob({})).toThrow();
});
