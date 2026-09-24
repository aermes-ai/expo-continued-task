/**
 * Type-check fixture for the hand-authored declarations. Not shipped, never run:
 *   npx -y -p typescript@5 tsc -p packages/expo-continued-task/types/tsconfig.json
 *
 * It mirrors the README and src/examples/continuedJob.js against the real react-native AppState
 * and expo-notifications types, and every `@ts-expect-error` below proves a wrong use is rejected.
 */
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

import * as bg from '@aermes/expo-continued-task';
import nativeDefault, {
  AUTOMATIC_ENTRIES,
  BAR_UNITS,
  COORDINATOR_VOCABULARY,
  DEFAULT_NAMESPACE,
  DEFAULT_PHASES,
  DEFAULT_RESUME_LINE,
  NOTIFY_ACTIONS,
  OWED_CAP,
  RESUME_PAUSE,
  RUN_OWNERS,
  UNKNOWN_READING,
  anyBusy,
  beforeAppReload,
  beginContinuedTask,
  connectIndicator,
  contextFor,
  continuedTaskState,
  createContinuedJob,
  createContinuedTask,
  createCoordinator,
  createCostBar,
  createExecutor,
  createForegroundBridge,
  createGraceOnlyJob,
  createGuards,
  createIndicatorPublisher,
  createNotifier,
  defineBackgroundJob,
  policy,
  registerBeforeReload,
  subscribeBusy,
  type ContinuedJobResult,
  type ContinuedTaskState,
  type ExecutorSummary,
  type NotifyResult,
} from '@aermes/expo-continued-task';
import { createContinuedJob as createJobFromSubpath } from '@aermes/expo-continued-task/createContinuedJob';
import createCostBarDefault from '@aermes/expo-continued-task/costBar';
import native, { continuedSupported, remainingMs } from '@aermes/expo-continued-task/native';
import { anyBusy as anyBusyFromSubpath, registerBusy } from '@aermes/expo-continued-task/busy';
import { backgroundJobs } from '@aermes/expo-continued-task/registry';
import { NOTIFY_ACTIONS as ACTIONS } from '@aermes/expo-continued-task/createNotifier';
import { createForegroundBridge as bridgeFromSubpath } from '@aermes/expo-continued-task/foregroundBridge';
import createGraceDefault from '@aermes/expo-continued-task/graceOnlyJob';
import { HEARTBEAT_MS } from '@aermes/expo-continued-task/createContinuedTask';
import createExportJob from '@aermes/expo-continued-task/examples/continuedJob';

declare function exportNext(): Promise<boolean>;
declare function flushOne(): Promise<boolean>;
declare const items: string[];
declare const kv: { kvGet(key: string): Promise<string | null>; kvSet(key: string, value: string): Promise<void> };

// ── README: a long job, in one call ─────────────────────────────────────────────────────────

const exporter = createContinuedJob({
  name: 'export',
  bg,
  appState: AppState,
  size: () => items.length,
  step: async () => exportNext(),
  seedMs: 500,
  words: {
    title: 'Exporting photos',
    line: ({ done, total }) => `${done} of ${total}`,
    done: ({ total }) => `${total} exported`,
  },
  notifications: {
    Notifications,
    store: kv,
    done: { title: 'Export finished', body: 'Your photos are ready' },
    paused: { title: 'Export paused', body: 'Tap to resume' },
  },
});

const started: Promise<ContinuedJobResult> = exporter.start();
void started.then((r) => {
  const complete: boolean = r.complete;
  const total: number | null = r.total;
  return { complete, total };
});
const unlisten: () => void = exporter.listen({
  open: () => {},
  top: () => {},
  resume: () => exporter.start(),
  canResume: () => true,
});
unlisten();
void exporter.stop();
exporter.dispose();

// The native module as the whole bridge, via the default export too.
const viaDefault = createJobFromSubpath({
  name: 'export-2',
  bg: nativeDefault,
  appState: AppState,
  size: async () => null,
  step: async () => false,
  words: { title: 't', line: () => 'l', done: () => 'd', paused: 'Paused', resume: DEFAULT_RESUME_LINE },
});
void viaDefault.start();

// ── README: a short job ─────────────────────────────────────────────────────────────────────

const flush = createGraceOnlyJob({ name: 'flush', step: async () => flushOne(), appState: AppState, bg });
const ended: Promise<'stopped' | 'empty'> = flush.start();
void ended;
const flush2 = createGraceDefault({ name: 'flush-2', step: flushOne, appState: AppState, bg: native });
flush2.dispose();

// ── examples/continuedJob ───────────────────────────────────────────────────────────────────

const exportJob = createExportJob({
  items,
  exportOne: async (item: string) => item.length,
  bg,
  appState: AppState,
  Notifications,
});
void exportJob.start();

// ── Native functions ────────────────────────────────────────────────────────────────────────

async function nativeCalls() {
  const supported: boolean = continuedSupported();
  const left: number = remainingMs();
  const state: ContinuedTaskState = continuedTaskState();
  const result = await beginContinuedTask({ title: 'Working', subtitle: '0 of 10', prefix: 'com.example.app.work' });
  if (!result.ok) {
    const reason: string | undefined = result.reason;
    void reason;
  }
  bg.reportContinuedProgress(1, 10, '1 of 10');
  bg.endContinuedTask(true);
  bg.armContinuedAtResign(true, { title: 'Working' });
  const net = bg.takeResignSubmission();
  const cpu: number | null = bg.cpuTimeMs();
  return { supported, left, state, net, cpu, available: bg.isAvailable };
}
void nativeCalls;

// ── Building blocks ─────────────────────────────────────────────────────────────────────────

const job = defineBackgroundJob({ name: 'sync', identifiers: { kvKey: 'sync.cursor' } });
const offBusy = job.registerBusy(() => true);
offBusy();
const busyNow: boolean = anyBusy() || anyBusyFromSubpath();
void busyNow;
subscribeBusy(() => {})();
registerBusy('other', null)();
registerBeforeReload(async () => 'drained');
void beforeAppReload({ timeoutMs: 1000 });
const jobs = backgroundJobs().map((j) => j.name);
void jobs;

const bar = createCostBar({
  seeds: { read: 20, work: 300 },
  remaining: (cost) => 10 * cost.read + 5 * cost.work,
  unsized: () => false,
});
const f: number = bar.credit('work', 1);
void f;
const bar2 = createCostBarDefault({ seeds: { unit: 500 }, remaining: () => 0, unsized: () => true });
void bar2.fraction();

const task = createContinuedTask({
  bg,
  copy: {
    title: (phase) => (phase === DEFAULT_PHASES.main ? 'Reading' : 'Working'),
    line: ({ done = 0, total = 0 }) => `${done} of ${total}`,
    pausedTitle: (reason) => (reason === 'thermal' ? 'Paused · iPhone is warm' : 'Paused'),
    pausedLine: () => 'Tap to resume',
    pausedGeneric: ({ titled }) => (titled ? 'Tap to resume' : 'Paused · Tap to resume'),
    doneLine: () => 'Done',
  },
  createBar: ({ now }) => createCostBar({ seeds: { unit: 500 }, remaining: () => 1000, unsized: () => false, now }),
  phases: { main: 'read' },
});
void task.begin({ phase: 'read', done: 0, total: 10, followUpPending: true });
task.progress('unit', (b) => b.credit('unit', 1), () => task.say('read', { done: 1, total: 10 }));
task.beforeEnd(({ complete }) => complete);
void task.end({ complete: false, reason: 'stopped' });
const units: number = BAR_UNITS + HEARTBEAT_MS;
void units;

const notifier = createNotifier({
  Notifications,
  appState: () => AppState.currentState,
  store: kv,
  namespace: { dataKey: 'sync', deadmanId: 'sync-deadman', dedupeKey: 'sync.notify.dedupe' },
  copyFor: (state) => (state.pauseReason
    ? { title: 'Paused', body: 'Tap to resume', action: NOTIFY_ACTIONS.RESUME, reason: state.pauseReason }
    : null),
  stalledCopy: () => ({ title: 'Paused', body: 'Tap to resume' }),
  onTap: { [ACTIONS.REVIEW]: (data) => data.runId },
});
const sent: Promise<NotifyResult> = notifier.notify({ pauseReason: 'thermal' });
void sent;
void notifier.serially(async () => 1).then((n: number) => n);
void DEFAULT_NAMESPACE.dataKey;

const bridge = createForegroundBridge({ appState: AppState, bg, onMinimise: async () => {} });
bridge.start()();
void bridgeFromSubpath;

// ── Advanced ────────────────────────────────────────────────────────────────────────────────

const guards = createGuards({
  device: { thermalState: () => 'nominal', powerState: () => ({ charging: true, level: 0.5 }) },
  bg,
});
const reading = guards.read();
const verdict = policy.decide({ context: policy.CONTEXTS.WINDOW, reading });
void verdict.proceed;
void policy.default.headroomFor(4000);
void UNKNOWN_READING.level;

interface Row { id: string }
const executor = createExecutor<Row, { id: string; ok: boolean }>({
  source: {
    queue: async ({ limit }) => items.slice(0, limit).map((id) => ({ id })),
    commit: async (results) => ({ advanced: results.length, deferred: 0, failed: 0 }),
    pause: { write: async () => {}, clear: async () => {}, read: async () => null },
  },
  work: async (rows, { shouldStop }) => ({ results: rows.filter(() => !shouldStop()).map((r) => ({ id: r.id, ok: true })) }),
  guards,
  decide: (args) => policy.decide({ ...args, pauses: policy.PAUSES }),
  onFollowUp: (event) => (event.phase === 'end' ? event.summary.stop : null),
});
const summary: Promise<ExecutorSummary> = executor.run({ context: 'foreground', tapInitiated: true });
void summary;

const coordinator = createCoordinator({ continued: task, isForeground: () => AppState.currentState === 'active' });
coordinator.beginTask({ phase: DEFAULT_PHASES.followUp });
const parked: number = coordinator.parkForResume('read', { setPaused: () => {}, getState: () => 1 });
void parked;
void contextFor({ away: true, continuedRunning: () => task.isRunning(), stopRequested: false });
void [RUN_OWNERS.WINDOW, RESUME_PAUSE, COORDINATOR_VOCABULARY.beginTask, AUTOMATIC_ENTRIES.has('launch'), OWED_CAP];

interface Pipeline { done: number; total: number }
interface Bar { paused?: boolean; done: number; total: number }
const publisher = createIndicatorPublisher({
  read: (): Pipeline => ({ done: 1, total: 10 }),
  appState: () => AppState.currentState,
  systemShowing: () => task.showing(),
  model: (input): Bar | null => ({ done: input.done, total: input.total }),
  payload: (next, { kind }) => ({ ...next, kind }),
  donePayload: (input) => ({ done: input.total, total: input.total }),
  samePayload: (a, b) => b != null && a.done === b.done,
  payloadFields: (p) => ({ ...p }),
  passing: () => false,
  isFound: (input) => input.done >= input.total,
  parking: () => null,
  describe: (input) => ({ ...input }),
  handoffState: () => ({}),
});
const live = connectIndicator({
  publisher,
  sources: [(publish) => task.subscribe(publish)],
  subscribeAppState: (listener) => {
    const sub = AppState.addEventListener('change', listener);
    return () => sub.remove();
  },
});
live.disconnect();

// ── Wrong usage is rejected ─────────────────────────────────────────────────────────────────

// @ts-expect-error `step` is required
createContinuedJob({ name: 'x', bg, appState: AppState, size: () => 1, words: { title: 't', line: () => '', done: () => '' } });

createContinuedJob({
  name: 'x', bg, appState: AppState, size: () => 1, step: async () => true,
  // @ts-expect-error `words.line` is a function of {done, total}, not a string
  words: { title: 't', line: 'x of y', done: () => '' },
});

createContinuedJob({
  name: 'x', bg, appState: AppState, size: () => 1, step: async () => true,
  // @ts-expect-error `words.title` is required
  words: { line: () => '', done: () => '' },
});

// @ts-expect-error `step` resolves a boolean ("more left?"), not nothing
createGraceOnlyJob({ name: 'x', step: async () => {}, appState: AppState, bg });

// @ts-expect-error `bg` must carry beginContinuedTask for a continued job
createContinuedJob({ name: 'x', bg: {}, appState: AppState, size: () => 1, step: async () => true, words: { title: 't', line: () => '', done: () => '' } });

// @ts-expect-error `title` and `subtitle` are required
void beginContinuedTask({ title: 'only a title' });

// @ts-expect-error a cost bar credits only the kinds it was seeded with
bar.credit('upload', 1);

// @ts-expect-error continuedTaskState() is a known union
const notAState: 'finished' = continuedTaskState();
void notAState;

// @ts-expect-error `copyFor` is required
createNotifier({ Notifications, appState: () => 'active', stalledCopy: () => ({ title: '', body: '' }) });

// @ts-expect-error `defineBackgroundJob` needs a name
defineBackgroundJob({ description: 'no name' });

// @ts-expect-error `context` must be one of policy.CONTEXTS
void executor.run({ context: 'somewhere' });
