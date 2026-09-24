/** The coordinator's pure rules: owners, automatic entries, the context table. */
import { CONTEXTS } from '../policy';
import {
  AUTOMATIC_ENTRIES, RESUME_PAUSE, RUN_OWNERS, contextFor,
} from '../rules';

test('the vocabulary, pinned', () => {
  expect(RUN_OWNERS).toEqual({ FOREGROUND: 'foreground', WINDOW: 'window', CONTINUED: 'continued' });
  expect([...AUTOMATIC_ENTRIES]).toEqual(['launch', 'foreground', 'heal']);
  expect(RESUME_PAUSE).toBe('resume');
});

test('contextFor: in front FOREGROUND unless stopping; away CONTINUED only while the task runs', () => {
  const running = jest.fn(() => true);
  const stopped = jest.fn(() => false);
  expect(contextFor({ away: false, continuedRunning: running, stopRequested: false })).toBe(CONTEXTS.FOREGROUND);
  expect(contextFor({ away: false, continuedRunning: running, stopRequested: true })).toBeNull();
  // In front the task is never asked: asking marks its launch/expiry and reads native.
  expect(running).not.toHaveBeenCalled();
  expect(contextFor({ away: true, continuedRunning: running, stopRequested: true })).toBe(CONTEXTS.CONTINUED);
  expect(contextFor({ away: true, continuedRunning: stopped, stopRequested: false })).toBeNull();
});
