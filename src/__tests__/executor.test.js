/**
 * The generic chunk loop over a WorkSource: a minimal job —
 * units in memory, a pause row of its own — ends for each reason the loop knows. An app's
 * persistent store as a source belongs in that app's suites.
 */
import { CONTEXTS, STOP_REASONS, decide } from '../policy';
import { createExecutor } from '../createExecutor';

function memorySource(count) {
  const units = Array.from({ length: count }, (_, i) => ({ id: `u${i}`, done: false }));
  const store = { pause: '' };
  return {
    units,
    store,
    queue: async ({ limit }) => units.filter((u) => !u.done).slice(0, limit),
    commit: async (results) => {
      results.forEach((r) => { units.find((u) => u.id === r.id).done = true; });
      return { advanced: results.length, deferred: 0, failed: 0 };
    },
    pause: {
      write: async (reason) => { store.pause = reason; },
      clear: async () => { store.pause = ''; },
      read: async () => store.pause,
    },
  };
}

function guards(reading = {}) {
  return {
    read: () => ({
      thermal: 'nominal', lowPower: false, charging: true, level: 0.9, access: 'full', rssMb: 100, ...reading,
    }),
    budget: () => ({ remainingMs: Infinity, expired: false, rssMb: 100, rssDeltaMb: 0, active: true, seq: 0 }),
    startRun: () => {},
    endRun: () => {},
  };
}

const work = async (rows) => ({ results: rows.map((r) => ({ id: r.id })) });

test('works the queue to empty, chunk by chunk, telling the listener each commit', async () => {
  const source = memorySource(120);
  const chunks = [];
  const exec = createExecutor({
    source, work, guards: guards(), decide, onChunk: (info) => chunks.push(info.items),
  });
  const summary = await exec.run({ context: CONTEXTS.FOREGROUND });
  expect(summary).toMatchObject({ stop: STOP_REASONS.EMPTY, items: 120, chunks: 3 });
  expect(chunks).toEqual([50, 50, 20]);
});

test("a job's own vocabulary names what the loop hands back and logs", async () => {
  const source = memorySource(3);
  const chunks = [];
  const lines = [];
  const followUps = [];
  const exec = createExecutor({
    source,
    work: async (rows) => ({ results: rows.map((r) => ({ id: r.id })), folderIds: ['F1'] }),
    guards: guards(),
    decide,
    onChunk: (info) => chunks.push(info),
    onFollowUp: (event) => { followUps.push(event.phase); throw new Error('boom'); },
    log: (line) => lines.push(line),
    vocabulary: {
      items: 'files', groupIds: 'folderIds', groups: 'folders', onItem: 'onFile', onFollowUp: 'onUpload',
    },
  });
  const summary = await exec.run({ context: CONTEXTS.FOREGROUND });
  expect(summary).toMatchObject({ files: 3, chunks: 1 });
  expect(summary).not.toHaveProperty('items');
  expect(chunks).toEqual([expect.objectContaining({ files: 3, folderIds: ['F1'] })]);
  expect(followUps).toEqual(['start', 'end']);
  expect(lines).toContain('onUpload failed');
});

test('setOnItem hears each item inside a chunk; one that throws is logged, not fatal', async () => {
  const source = memorySource(2);
  const seen = [];
  const lines = [];
  const exec = createExecutor({
    source,
    work: async (rows, { onProgress }) => {
      rows.forEach((r, i) => onProgress({ done: i + 1, total: rows.length }));
      return { results: rows.map((r) => ({ id: r.id })) };
    },
    guards: guards(),
    decide,
    log: (line) => lines.push(line),
  });
  exec.setOnItem((p) => { seen.push(p.done); throw new Error('x'); });
  expect(await exec.run({ context: CONTEXTS.FOREGROUND })).toMatchObject({ items: 2 });
  expect(seen).toEqual([1, 2]);
  expect(lines).toContain('onItem threw');
});

test('a guard pause is written to the source, and lifted by a run the guards clear', async () => {
  const source = memorySource(10);
  const paused = [];
  const hot = createExecutor({
    source, work, guards: guards({ thermal: 'serious' }), decide, onPaused: (r) => paused.push(r),
  });
  expect(await hot.run({ context: CONTEXTS.FOREGROUND })).toMatchObject({ stop: STOP_REASONS.PAUSED, pauseReason: 'thermal' });
  expect(await hot.storedPauseReason()).toBe('thermal');
  expect(paused).toEqual(['thermal']);
  const cool = createExecutor({ source, work, guards: guards(), decide });
  await cool.run({ context: CONTEXTS.FOREGROUND });
  expect(await cool.storedPauseReason()).toBeNull();
});

test('a chunk that moves nothing stalls, and says so', async () => {
  const source = memorySource(10);
  const stalls = [];
  const exec = createExecutor({
    source, work: async () => ({ results: [] }), guards: guards(), decide, onStall: (f) => stalls.push(f.stop),
  });
  source.commit = async () => ({ advanced: 0, deferred: 10, failed: 0 });
  expect((await exec.run({ context: CONTEXTS.FOREGROUND })).stop).toBe(STOP_REASONS.STALLED);
  expect(stalls).toEqual([STOP_REASONS.STALLED]);
});

test('a mid-chunk stop reaches inside the chunk: the unit in hand commits, the next is not started', async () => {
  const source = memorySource(200);
  let exec = null;
  const seen = [];
  const perUnit = async (rows, ctx) => {
    const done = [];
    for (const row of rows) {
      if (ctx.shouldStop()) break;
      if (done.length === 5 && seen.length === 0) exec.requestStop({ midChunk: true });
      done.push({ id: row.id });
    }
    seen.push(done.length);
    return { results: done };
  };
  exec = createExecutor({ source, work: perUnit, guards: guards(), decide });
  const summary = await exec.run({ context: CONTEXTS.FOREGROUND });
  expect(summary.stop).toBe(STOP_REASONS.STOPPED);
  expect(seen).toEqual([6]);
});
