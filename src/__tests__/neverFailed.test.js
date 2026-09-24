/**
 * The user never sees "Failed" (a product requirement), enforced in the package too.
 *
 * iOS's BGContinuedProcessingTask UI says "Failed" for a task completed with `success: false`.
 * An app can sweep its own source the same way; this is that sweep over the package, and the
 * behaviour behind it: every argument shape `end` takes, and a
 * task created without a `complete` port, completes with a literal `true`.
 */
import fs from 'fs';
import path from 'path';

import { BAR_UNITS, createContinuedTask } from '../createContinuedTask';
import { createCostBar } from '../costBar';

const COPY = {
  title: (phase) => `T:${phase}`,
  line: ({ phase, done = 0, total = 0 }) => `${phase} ${done}/${total}`,
  pausedTitle: (reason) => (reason === 'thermal' ? 'Paused · warm' : 'Paused'),
  pausedLine: () => 'Tap Resume',
  pausedGeneric: () => 'Tap Resume',
  doneLine: () => 'Done',
};

function bridge() {
  const b = {
    phase: 'none',
    ends: [],
    continuedSupported: () => true,
    beginContinuedTask: async () => { b.phase = 'running'; return { ok: true }; },
    reportContinuedProgress: jest.fn(),
    endContinuedTask: (success) => {
      b.ends.push(success);
      if (success !== true) throw new Error('would say Failed');
      b.phase = 'ended';
    },
    continuedTaskState: () => b.phase,
  };
  return b;
}

const bar = ({ now }) => createCostBar({ seeds: { unit: 1 }, remaining: () => 1, unsized: () => false, now });

test.each([
  [{ complete: false, reason: 'error', failed: true }],
  [{ complete: true, failed: true }],
  [{ complete: false, reason: 'thermal' }],
  [{ complete: true }],
  [{}],
])('end(%j) completes as a success, the bar filled first', async (args) => {
  const bg = bridge();
  const task = createContinuedTask({ bg, copy: COPY, createBar: bar });
  task.begin({ phase: 'work' });
  task.progress('unit', (b) => b.credit('unit', 1), () => 'w');
  await task.end(args);
  expect(bg.ends).toEqual([true]);
  expect(bg.reportContinuedProgress.mock.calls.at(-1).slice(0, 2)).toEqual([BAR_UNITS, BAR_UNITS]);
});

test('every endContinuedTask call in the package passes a literal true', () => {
  const root = path.resolve(__dirname, '..');
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(full);
    return /\.js$/.test(entry.name) ? [full] : [];
  });
  const calls = [];
  files(root).forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?<!function )\bendContinuedTask\s*(?:\?\.)?\(([^)]*)\)/g)) {
      calls.push({ file: path.relative(root, file), args: match[1].trim() });
    }
  });
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((call) => call.args !== 'true')).toEqual([]);
});

test('taskOptions ride on the submission; without them it is exactly {title, subtitle}', async () => {
  const plain = bridge();
  plain.beginContinuedTask = jest.fn(async () => ({ ok: true }));
  createContinuedTask({ bg: plain, copy: COPY, createBar: bar }).begin({ phase: 'work' });
  await Promise.resolve();
  expect(plain.beginContinuedTask.mock.calls[0][0]).toEqual({ title: 'T:work', subtitle: 'work 0/0' });
  const job = bridge();
  job.beginContinuedTask = jest.fn(async () => ({ ok: true }));
  createContinuedTask({
    bg: job, copy: COPY, createBar: bar, taskOptions: { prefix: 'com.example.app.work.uploads', logDir: 'uploads' },
  }).begin({ phase: 'work' });
  await Promise.resolve();
  expect(job.beginContinuedTask.mock.calls[0][0]).toEqual({
    title: 'T:work', subtitle: 'work 0/0', prefix: 'com.example.app.work.uploads', logDir: 'uploads',
  });
});
