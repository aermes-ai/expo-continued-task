/**
 * @aermes/expo-continued-task — iOS 26 BGContinuedProcessingTask for Expo apps, with the rules
 * measured on device applied: start only from a tap, a cost-weighted bar under 100 % while work
 * is owed, never "Failed", notify before the task ends, and the ~30 s grace grant everywhere else.
 *
 *   createContinuedJob   a long, user-started job in one call
 *   createGraceOnlyJob   a short job that only needs the grace grant
 *   the building blocks  createContinuedTask, createCostBar, createNotifier, createForegroundBridge,
 *                        defineBackgroundJob and the busy registry
 *   the native module    beginContinuedTask, reportContinuedProgress, endContinuedTask, … (native.js)
 */
export * from './native';
export { default } from './native';
export { DEFAULT_RESUME_LINE, createContinuedJob } from './createContinuedJob';
export { createGraceOnlyJob } from './graceOnlyJob';
export {
  BAR_UNITS, BEFORE_END_MS, HEARTBEAT_MS, REPORT_MARKS, createContinuedTask,
} from './createContinuedTask';
export { OWED_CAP, createCostBar } from './costBar';
export {
  DEADMAN_SECONDS, DEADMAN_THROTTLE_MS, DEFAULT_NAMESPACE, NOTIFY_ACTIONS, STALLED, createNotifier,
} from './createNotifier';
export { createForegroundBridge } from './foregroundBridge';
export { backgroundJob, backgroundJobs, defineBackgroundJob } from './registry';
export {
  announceBusy, anyBusy, beforeAppReload, isBusy, registerBeforeReload, registerBusy, subscribeBusy,
} from './busy';
// Advanced: the machinery a multi-phase job with its own UI assembles itself.
export * as policy from './policy';
export {
  UNKNOWN_READING, createGuards, guardOverride, setGuardOverride,
} from './guards';
export { EXECUTOR_VOCABULARY, MIN_READ_HEADROOM_MS, createExecutor } from './createExecutor';
export {
  AUTOMATIC_ENTRIES, DEFAULT_PHASES, RESUME_PAUSE, RUN_OWNERS, contextFor,
} from './rules';
export { COORDINATOR_VOCABULARY, createCoordinator } from './createCoordinator';
export {
  DONE_BEAT_MS, createIndicatorPublisher, liveActivitiesOff, windowPending,
} from './createIndicatorPublisher';
export { connectIndicator } from './connectIndicator';
