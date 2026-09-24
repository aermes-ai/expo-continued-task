/**
 * The stateful coordinator: the rules a job relies on, independent of any one app's job.
 * An app's own paths through it belong in that app's suites.
 */
import { CONTEXTS } from '../policy';
import { createCoordinator } from '../createCoordinator';

function task(over = {}) {
  return {
    supported: () => true, isLive: () => false, stale: () => false, begin: jest.fn(), end: jest.fn(),
    armResignNet: jest.fn(), adoptResign: jest.fn(() => false), ...over,
  };
}

test('mustAskFirst: in front with a task to be had and none live; never without support or away', () => {
  expect(createCoordinator({ continued: task(), isForeground: () => true }).mustAskFirst()).toBe(true);
  expect(createCoordinator({ continued: task(), isForeground: () => false }).mustAskFirst()).toBe(false);
  expect(createCoordinator({ continued: task({ supported: () => false }), isForeground: () => true }).mustAskFirst()).toBe(false);
  expect(createCoordinator({ continued: task({ isLive: () => true }), isForeground: () => true }).mustAskFirst()).toBe(false);
  // A live task iOS stopped running is no task: ask again.
  expect(createCoordinator({ continued: task({ isLive: () => true, stale: () => true }), isForeground: () => true })
    .mustAskFirst()).toBe(true);
  expect(createCoordinator({ continued: null, isForeground: () => true }).mustAskFirst()).toBe(false);
});

test('a probe that throws counts as in front', () => {
  const c = createCoordinator({ continued: task(), isForeground: () => { throw new Error('x'); } });
  expect(c.inFront()).toBe(true);
  expect(c.mayOwn('foreground')).toBe(true);
});

test('beginTask ends a stale task first, never submits over a live one', () => {
  const stale = task({ stale: () => true });
  expect(createCoordinator({ continued: stale, isForeground: () => true }).beginTask()).toBe(true);
  expect(stale.end).toHaveBeenCalledWith({ complete: false, reason: 'stopped' });
  expect(stale.begin).toHaveBeenCalledWith({ phase: 'followUp' });
  const live = task({ isLive: () => true });
  expect(createCoordinator({ continued: live, isForeground: () => true }).beginTask()).toBe(false);
  expect(live.begin).not.toHaveBeenCalled();
});

test('minimiseHandOff: adopt, then leave, then the mid-chunk stop — synchronously, in that order', () => {
  const order = [];
  const continued = task({ adoptResign: () => { order.push('adopt'); return true; }, isLive: () => true });
  const c = createCoordinator({ continued, isForeground: () => true });
  const result = c.minimiseHandOff({
    followUpRunning: () => true,
    openUnits: () => order.push('openUnits'),
    leave: () => order.push('leave'),
    passContext: () => CONTEXTS.FOREGROUND,
    stopMidChunk: () => order.push('stopMidChunk'),
  });
  expect(result).toBeUndefined();
  expect(order).toEqual(['adopt', 'openUnits', 'leave', 'stopMidChunk']);
});

test('the resign net: armed only while work runs with no task live', () => {
  const continued = task();
  const c = createCoordinator({ continued, isForeground: () => true });
  c.syncResignNet({ mainRunning: false, followUpRunning: Promise.resolve(), line: (phase) => `line:${phase}` });
  expect(continued.armResignNet).toHaveBeenLastCalledWith({
    armed: true, phase: 'followUp', followUpPending: false, subtitle: 'line:followUp',
  });
  c.syncResignNet({ mainRunning: false, followUpRunning: null, line: () => 'x' });
  expect(continued.armResignNet).toHaveBeenLastCalledWith({
    armed: false, phase: 'followUp', followUpPending: false, subtitle: '',
  });
  c.syncResignNet({ mainRunning: true, followUpRunning: null, line: (phase) => `line:${phase}` });
  expect(continued.armResignNet).toHaveBeenLastCalledWith({
    armed: true, phase: 'main', followUpPending: false, subtitle: 'line:main',
  });
});

test("neutral words by default; a job's own phases and vocabulary are what it writes", () => {
  const debug = jest.fn();
  const mark = jest.fn();
  const plain = createCoordinator({ continued: task(), isForeground: () => true, debug, mark });
  plain.beginTask();
  plain.parkForResume('main', { setPaused: () => {} });
  expect(debug.mock.calls.map(([cat, ev]) => [cat, ev])).toEqual([
    ['coordinator', 'beginTask'], ['coordinator', 'parkForResume'],
  ]);
  expect(mark).toHaveBeenCalledWith('awaiting_resume', { kind: 'main' });

  debug.mockClear();
  mark.mockClear();
  const continued = task();
  const own = createCoordinator({
    continued,
    isForeground: () => true,
    debug,
    mark,
    phases: { main: 'index', followUp: 'upload' },
    vocabulary: {
      debugCategory: 'uploader', beginTask: 'beginUploadTask', awaitingResume: 'index.awaiting_resume', followUpPendingKey: 'uploadFollows',
    },
  });
  own.beginTask();
  own.parkForResume('index', { setPaused: () => {} });
  own.syncResignNet({ mainRunning: true, followUpRunning: null, line: (phase) => `line:${phase}` });
  expect(continued.begin).toHaveBeenCalledWith({ phase: 'upload' });
  expect(debug.mock.calls.map(([cat, ev]) => [cat, ev])).toEqual([
    ['uploader', 'beginUploadTask'], ['uploader', 'parkForResume'],
  ]);
  expect(mark).toHaveBeenCalledWith('index.awaiting_resume', { kind: 'index' });
  expect(continued.armResignNet).toHaveBeenLastCalledWith({
    armed: true, phase: 'index', uploadFollows: false, subtitle: 'line:index',
  });
});
