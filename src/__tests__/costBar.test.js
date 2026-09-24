/**
 * createCostBar — the generic rules any job's system bar keeps. An app's own multi-phase preset
 * can be pinned by golden tests of its own; these are the rules a new job relies on.
 */
import { createCostBar, OWED_CAP } from '../costBar';

/** One kind, `total` units, the size known or not. */
function job({ total = 100, known = true, seed = 10 } = {}) {
  let clock = 0;
  const state = { done: 0, total, known };
  const bar = createCostBar({
    seeds: { unit: seed },
    remaining: (cost) => Math.max(0, state.total - state.done) * cost.unit,
    unsized: () => !state.known,
    now: () => clock,
  });
  return {
    bar,
    state,
    step(units, ms) {
      clock += ms;
      state.done += units;
      return bar.credit('unit', units);
    },
  };
}

test('never backwards, never 1 while work is owed, 1 once everything is done and sized', () => {
  const j = job();
  let last = 0;
  for (let i = 0; i < 99; i += 1) {
    const f = j.step(1, 10);
    expect(f).toBeGreaterThanOrEqual(last);
    expect(f).toBeLessThanOrEqual(OWED_CAP);
    last = f;
  }
  expect(j.step(1, 10)).toBe(1);
});

test('an unsized job never fills, even at a remaining of 0: it holds at the cap', () => {
  const j = job({ total: 10, known: false });
  for (let i = 0; i < 10; i += 1) j.step(1, 10);
  expect(j.bar.fraction()).toBe(OWED_CAP);
  j.step(1, 10);
  expect(j.bar.fraction()).toBe(OWED_CAP);
});

test('a total learned late re-scales the rest: the bar keeps moving, it does not stall', () => {
  const j = job({ total: 10 });
  for (let i = 0; i < 5; i += 1) j.step(1, 10);
  const before = j.bar.fraction();
  j.state.total = 10000;
  const after = j.step(1, 10);
  expect(after).toBeGreaterThan(before);
});

test('costs learn from the time per unit, held to [seed/4, seed*20]', () => {
  const j = job({ seed: 10 });
  j.step(1, 1e9);
  expect(j.bar.costs().unit).toBeCloseTo(10 * 0.7 + 200 * 0.3);
  const k = job({ seed: 10 });
  k.step(1, 0);
  expect(k.bar.costs().unit).toBeCloseTo(10 * 0.7 + 2.5 * 0.3);
});

test('restartClock credits nothing and starts timing again', () => {
  const j = job();
  j.step(1, 10);
  const f = j.bar.fraction();
  j.bar.restartClock();
  expect(j.bar.fraction()).toBe(f);
  expect(j.bar.credit('unit', 0)).toBe(f);
});
