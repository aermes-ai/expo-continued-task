/**
 * @aermes/expo-continued-task: iOS 26 BGContinuedProcessingTask for Expo apps, with the rules
 * measured on device applied: start only from a tap, a cost-weighted bar under 100 % while work
 * is owed, never "Failed", notify before the task ends, and the ~30 s grace grant everywhere else.
 *
 *   createContinuedJob   a long, user-started job in one call
 *   createGraceOnlyJob   a short job that only needs the grace grant
 *   the building blocks  createContinuedTask, createCostBar, createNotifier, createForegroundBridge,
 *                        defineBackgroundJob and the busy registry
 *   the native module    beginContinuedTask, reportContinuedProgress, endContinuedTask, ...
 */
import type { DecideArgs, RunContext, StopReason, Verdict } from './policy';

export type { DecideArgs, PauseVocabulary, RunContext, StopReason, Verdict } from './policy';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The app's debug log: `(category, event, fields)`. */
export type DebugFn = (cat: string, ev: string, fields?: Record<string, unknown>) => void;
/** The app's memory trace: `(label, extra)`. */
export type MarkFn = (label: string, extra?: Record<string, unknown> | null) => void;
/** A plain log line. */
export type LogFn = (line: string, data?: Record<string, unknown>) => void;
/** Removes whatever was registered. */
export type Unsubscribe = () => void;

/**
 * The subset of react-native's `AppState` the package uses. It is injected: the package imports
 * no React Native. Pass `AppState` from 'react-native'.
 */
export interface AppStateLike {
  /** 'active' in front, 'background', 'inactive', ... */
  currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: string) => void): { remove?(): void } | null | undefined | void;
}

/** The app's key-value store, where a notifier's per-run dedupe survives a relaunch. */
export interface KeyValueStore {
  kvGet?(key: string): Promise<string | null | undefined> | string | null | undefined;
  kvSet?(key: string, value: string): unknown;
}

/** The request a notifier schedules (expo-notifications' `NotificationRequestInput`, loosely). */
export interface ScheduleRequestLike {
  identifier?: string;
  content: object;
  trigger: object | null;
}

/** A notification response (expo-notifications' `NotificationResponse`, loosely). */
export interface NotificationResponseLike {
  notification?: {
    request?: {
      identifier?: string;
      content?: { data?: Record<string, unknown> | null };
    };
  };
}

/** Notification permissions as expo-notifications reports them. */
export interface NotificationPermissionsLike {
  status?: string;
  granted?: boolean;
  canAskAgain?: boolean;
}

/**
 * The subset of expo-notifications the package uses. It is injected: the package imports no
 * native module. Pass `import * as Notifications from 'expo-notifications'`.
 */
export interface NotificationsLike {
  scheduleNotificationAsync?(request: ScheduleRequestLike): Promise<string>;
  cancelScheduledNotificationAsync?(identifier: string): Promise<unknown>;
  getPermissionsAsync?(): Promise<NotificationPermissionsLike>;
  requestPermissionsAsync?(): Promise<NotificationPermissionsLike>;
  addNotificationResponseReceivedListener?(
    listener: (response: NotificationResponseLike) => void,
  ): { remove?(): void } | null | undefined;
  getLastNotificationResponseAsync?(): Promise<NotificationResponseLike | null | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Native module (native.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The continued task's state as native reports it. */
export type ContinuedTaskState = 'none' | 'pending' | 'running' | 'expired' | 'ended';

/**
 * What a submission answered. Never a rejection. Known reasons include 'unsupported',
 * 'already', 'identifierNotPermitted', 'submitFailed', 'noResult' and 'threw'.
 */
export interface ContinuedBeginResult {
  ok: boolean;
  reason?: string;
  error?: string;
  [key: string]: unknown;
}

export interface BeginContinuedTaskArgs {
  /** The banner's title. */
  title: string;
  /** The banner's subtitle (iOS cuts it at ~30 characters). */
  subtitle: string;
  /**
   * Another job's identifier prefix; must match a permitted wildcard. Without it, the config
   * plugin's default submission.
   */
  prefix?: string | null;
  /** Another job's lifecycle log folder under Documents. */
  logDir?: string | null;
}

/** True only when the native module is actually present. When false, every call is a no-op. */
export declare const isAvailable: boolean;

/**
 * Ask iOS to keep the app running briefly after it's backgrounded (the ~30 s grace grant).
 * `name` (optional) names the grant in iOS's logs, on a binary that can.
 */
export declare function beginBackgroundTask(name?: string | null): void;

/**
 * Hand back the grant native takes by itself at willResignActive. Call once the minimise's work
 * is done. A binary without it has nothing to release.
 */
export declare function releaseMinimiseGrant(): void;

/**
 * Let native take the minimise pre-grant at willResignActive (true), or stop it (false). Arm it
 * only while something will call `releaseMinimiseGrant` on the way out.
 */
export declare function armMinimiseGrant(armed: boolean): void;

/** The process's CPU time so far (user + system, ms), or null on a binary without it. */
export declare function cpuTimeMs(): number | null;

/** Release the background-task grant once the work is done. Always pair with `beginBackgroundTask`. */
export declare function endBackgroundTask(): void;

/** Milliseconds of grace iOS says are left, or -1 when no grant is held (or the module is missing). */
export declare function remainingMs(): number;

/** True when this binary AND this OS can run a BGContinuedProcessingTask. */
export declare function continuedSupported(): boolean;

/**
 * Submit the continued task. Only from a user action, with the app in front (Apple's rule).
 * Never rejects: resolves `{ok: false, reason}` when it could not submit.
 */
export declare function beginContinuedTask(args: BeginContinuedTaskArgs): Promise<ContinuedBeginResult>;

/** completed/total onto the system progress UI, and the subtitle beside it. */
export declare function reportContinuedProgress(completed: number, total: number, subtitle?: string): void;

/**
 * Retitle the task in the system UI (e.g. "Paused" before a planned stop completes it). A binary
 * without it keeps its title.
 */
export declare function retitleContinued(title: string, subtitle?: string): void;

/** Can this binary retitle the task? */
export declare function canRetitleContinued(): boolean;

/** Complete the task. Idempotent; safe when none was ever submitted. */
export declare function endContinuedTask(success: boolean): void;

/** The continued task's ETA display: true / false, or null for the build's default. */
export declare function setContinuedEta(enabled: boolean | null | undefined): void;

/** The continued task's state; 'none' when unavailable. */
export declare function continuedTaskState(): ContinuedTaskState;

/**
 * The willResignActive safety net: while armed, native submits the continued task itself as
 * the app stops being active, for work that is running with no task. A binary without it
 * ignores this.
 */
export declare function armContinuedAtResign(armed: boolean, lines?: { title?: string; subtitle?: string }): void;

/**
 * What the safety net did at the last willResignActive, once: `{ok, reason?}`, or null when it
 * did nothing (or the binary has no net).
 */
export declare function takeResignSubmission(): { ok: boolean; reason?: string; [key: string]: unknown } | null;

/**
 * The native bridge's surface: `import * as bg from '@aermes/expo-continued-task'` satisfies it.
 * Every building block takes it (or the part of it it uses) as `bg`.
 */
export interface NativeBridge {
  isAvailable: boolean;
  beginBackgroundTask: typeof beginBackgroundTask;
  endBackgroundTask: typeof endBackgroundTask;
  releaseMinimiseGrant: typeof releaseMinimiseGrant;
  armMinimiseGrant: typeof armMinimiseGrant;
  cpuTimeMs: typeof cpuTimeMs;
  remainingMs: typeof remainingMs;
  continuedSupported: typeof continuedSupported;
  beginContinuedTask: typeof beginContinuedTask;
  reportContinuedProgress: typeof reportContinuedProgress;
  retitleContinued: typeof retitleContinued;
  canRetitleContinued: typeof canRetitleContinued;
  endContinuedTask: typeof endContinuedTask;
  setContinuedEta: typeof setContinuedEta;
  continuedTaskState: typeof continuedTaskState;
  armContinuedAtResign: typeof armContinuedAtResign;
  takeResignSubmission: typeof takeResignSubmission;
}

/** What the grace grant needs of `bg` (createForegroundBridge, createGraceOnlyJob). */
export type GraceBridge = Partial<Pick<NativeBridge, 'beginBackgroundTask' | 'endBackgroundTask'>>;

/** What a continued task needs of `bg`: `beginContinuedTask`, and whatever else the binary has. */
export type ContinuedBridge = Partial<NativeBridge> & Pick<NativeBridge, 'beginContinuedTask'>;

/** The native module's default export. */
declare const native: {
  beginBackgroundTask: typeof beginBackgroundTask;
  endBackgroundTask: typeof endBackgroundTask;
  releaseMinimiseGrant: typeof releaseMinimiseGrant;
  armMinimiseGrant: typeof armMinimiseGrant;
  remainingMs: typeof remainingMs;
  isAvailable: boolean;
  continuedSupported: typeof continuedSupported;
  beginContinuedTask: typeof beginContinuedTask;
  reportContinuedProgress: typeof reportContinuedProgress;
  endContinuedTask: typeof endContinuedTask;
  retitleContinued: typeof retitleContinued;
  canRetitleContinued: typeof canRetitleContinued;
  continuedTaskState: typeof continuedTaskState;
  armContinuedAtResign: typeof armContinuedAtResign;
  takeResignSubmission: typeof takeResignSubmission;
};
export default native;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Busy registry (busy.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** True while `name`'s work is live. */
export declare function isBusy(name: string): boolean;

/** True while any registered job is busy: the question an app-wide gate asks. */
export declare function anyBusy(): boolean;

/** Called whenever something the busy answer depends on may have changed. Returns the unsubscribe. */
export declare function subscribeBusy(listener: () => void): Unsubscribe;

/**
 * A job's side: what "busy" means for `name`. Returns the unregister. Passing a non-function
 * removes `name`.
 */
export declare function registerBusy(name: string, fn: (() => boolean) | null | undefined): Unsubscribe;

/**
 * Register what must happen before the JS runtime is replaced (e.g. draining a database
 * queue). One hook at a time. Returns the unregister.
 */
export declare function registerBeforeReload(fn: (() => unknown) | null | undefined): Unsubscribe;

/**
 * Run the registered reload hook, bounded; never throws, never holds a reload past `timeoutMs`
 * (default 4000). Resolves with the hook's result, `{timedOut: true}`, `{error}`, or null when
 * no hook is registered.
 */
export declare function beforeAppReload(opts?: { timeoutMs?: number }): Promise<unknown>;

/** Something the busy answer depends on may have changed; listeners re-ask. */
export declare function announceBusy(): void;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Job registry (registry.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BackgroundJobSpec {
  /** Unique; also the busy source's name. */
  name: string;
  /**
   * The job's persisted identifiers (BG task ids, kv keys, log files, App Group keys,
   * notification namespace). Free-form: recorded, never read by the package.
   */
  identifiers?: Record<string, unknown>;
  description?: string;
}

/** A declared job (frozen). */
export interface BackgroundJob {
  readonly name: string;
  readonly identifiers: Record<string, unknown>;
  readonly description: string;
  /** What "busy" means for this job. Returns the unregister. */
  readonly registerBusy: (fn: (() => boolean) | null | undefined) => Unsubscribe;
  /** Something the answer depends on may have changed. */
  readonly announceBusy: () => void;
  readonly isBusy: () => boolean;
}

/**
 * The one place a feature declares that it does background work. Declaring it registers the
 * name, so app-wide questions (`anyBusy`) include it. Names are unique: defining one twice
 * returns the first, unchanged. Throws when `name` is not a non-empty string.
 */
export declare function defineBackgroundJob(spec: BackgroundJobSpec): BackgroundJob;

/** Every job declared so far, in the order they were. */
export declare function backgroundJobs(): BackgroundJob[];

/** The job declared under `name`, or null. */
export declare function backgroundJob(name: string): BackgroundJob | null;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cost bar (costBar.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The most the bar shows while anything is owed. It reaches 1 only when nothing is. */
export declare const OWED_CAP: 0.97;

export interface CostBarOptions<K extends string = string> {
  /** ms per unit of each kind, measured in the background. */
  seeds: Record<K, number>;
  /** The estimated cost (ms) of everything still owed, at the current costs. */
  remaining: (cost: Record<K, number>) => number;
  /** Is any size still unknown, so `remaining` can grow? */
  unsized: () => boolean;
  now?: () => number;
}

export interface CostBar<K extends string = string> {
  /** `units` of `kind` just completed. Returns where the bar stands now, 0..1. */
  credit(kind: K, units: number): number;
  /** The clock restarts with no credit: a new pass that starts its count again. */
  restartClock(): void;
  /** Where the bar stands, 0..1. */
  fraction(): number;
  /** The estimate of what is left, in ms of work. */
  remainingMs(): number;
  /** A copy of the moving averages, for the debug log. */
  costs(): Record<K, number>;
  /** The live averages, for the job's `remaining` estimate. */
  readonly cost: Record<K, number>;
}

/**
 * Where a continued task's system bar stands, from the work actually done. Each report says
 * what just completed, in units of a kind of work with a measured cost per unit; the bar never
 * goes backwards, never freezes while work lands, and stays under `OWED_CAP` while anything is
 * owed.
 */
export declare function createCostBar<K extends string>(options: CostBarOptions<K>): CostBar<K>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rules (rules.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Who is driving a run. Exactly one owner drives the job's state machine at a time. */
export declare const RUN_OWNERS: Readonly<{
  FOREGROUND: 'foreground';
  WINDOW: 'window';
  CONTINUED: 'continued';
}>;

/** One of `RUN_OWNERS`. */
export type RunOwner = (typeof RUN_OWNERS)[keyof typeof RUN_OWNERS];

/** `start()` entries that are NOT a user action, so never submit a continued task. */
export declare const AUTOMATIC_ENTRIES: Set<string>;

/** The pause an automatic start takes in front when no continued task is live. */
export declare const RESUME_PAUSE: 'resume';

/** A two-phase job's phase names. */
export interface PhaseNames {
  main: string;
  followUp: string;
}

/** The package's neutral phase names. */
export declare const DEFAULT_PHASES: Readonly<{ main: 'main'; followUp: 'followUp' }>;

/** Which rules the next pass runs under, or null to stop. */
export declare function contextFor(args: {
  away: boolean;
  /** Asked only when away. */
  continuedRunning: () => boolean;
  stopRequested: boolean;
}): 'continued' | 'foreground' | null;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Continued task (createContinuedTask.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The one bar's resolution, in units. */
export declare const BAR_UNITS: 100000;
/** How often a moving bar also tells the listeners, ms. */
export declare const HEARTBEAT_MS: 5000;
/** How many reports of each phase go into the memory trace. */
export declare const REPORT_MARKS: 12;
/** How long an end waits on its `beforeEnd` hooks, ms. */
export declare const BEFORE_END_MS: 2000;

/**
 * What a banner line is built from: the phase, the counts the caller passed, the job's
 * `context()` fields, and whether the phase is the banner's title.
 */
export interface ContinuedLineArgs {
  phase: string;
  titled: boolean;
  done?: number;
  total?: number;
  [field: string]: unknown;
}

/** The banner's words. */
export interface ContinuedTaskCopy {
  title(phase: string): string;
  line(args: ContinuedLineArgs): string;
  pausedTitle(reason: string | null): string;
  /** A falsy answer falls back to `pausedGeneric`. */
  pausedLine(reason: string | null, opts: { titled: boolean }): string | null | undefined;
  pausedGeneric(opts: { titled: boolean }): string;
  doneLine(context: Record<string, unknown>): string;
}

/** What a continued task needs of its bar (a `createCostBar` result fits). */
export interface ContinuedTaskBar {
  remainingMs(): number;
  costs(): Record<string, number>;
}

export interface ContinuedTaskOptions<B extends ContinuedTaskBar = ContinuedTaskBar> {
  /** The native bridge's surface (required: the package imports no native code here). */
  bg: ContinuedBridge;
  log?: LogFn;
  now?: () => number;
  copy: ContinuedTaskCopy;
  /** Fields the job's lines lead with, spread into every line. */
  context?: () => Record<string, unknown>;
  /** A new bar for each task (and each job restarted on a live task). */
  createBar: (args: { phase: string; follows: boolean; now: () => number }) => B;
  debug?: DebugFn;
  mark?: MarkFn;
  /** How the task is completed natively. Default `bg.endContinuedTask(true)`: always a success. */
  completeTask?: () => void;
  /** A job's own identifier prefix and log folder for the submission; absent, the config's default. */
  taskOptions?: { prefix?: string; logDir?: string } | null;
  /** The job's phase names, merged over `DEFAULT_PHASES`. */
  phases?: Partial<PhaseNames>;
}

export interface ContinuedBeginArgs {
  phase?: string;
  done?: number;
  total?: number;
  /** An older alias of `done`. */
  read?: number;
  /** A later phase is owed after this one (the bar counts it). */
  followUpPending?: boolean;
}

export interface ContinuedEndArgs {
  /** Anything that is not complete is a stop: paused, and still a success. */
  complete?: boolean;
  reason?: string | null;
  /** A real error: shown as a pause (never "Failed"), the cause goes to the logs. */
  failed?: boolean;
}

export interface ResignNetArgs {
  armed?: boolean;
  phase?: string;
  followUpPending?: boolean;
  subtitle?: string;
}

export interface ContinuedTask<B extends ContinuedTaskBar = ContinuedTaskBar> {
  /** Can this binary and OS run the task? */
  supported(): boolean;
  /**
   * Submit the task. Call only from a user action, with the app in front. Null when unsupported;
   * otherwise the submission (the live one, when a task is already live).
   */
  begin(args?: ContinuedBeginArgs): Promise<ContinuedBeginResult> | null;
  /** Keep native's willResignActive safety net armed with what the task would say. */
  armResignNet(args?: ResignNetArgs): void;
  /** Adopt a task native submitted at willResignActive. True when one was adopted. */
  adoptResign(): boolean;
  /** 'on' / 'off' switches the ETA display; anything else leaves the build's default. */
  applyEtaFlag(raw: unknown): void;
  /** The subtitle for `phase`, retitling the banner first when the phase has moved on. */
  say(phase: string, args?: Record<string, unknown>, opts?: { retitle?: boolean }): string;
  /**
   * One unit of progress: `credit(bar)` moves the bar and returns its fraction, then
   * `subtitle()` says it. Nothing without a live submission.
   */
  progress(kind: string, credit: (bar: B) => number, subtitle: () => string, phase?: string | null): void;
  /** Is iOS running the task right now? */
  isRunning(): boolean;
  /** Submitted and never ended, but iOS is no longer running it. */
  stale(): boolean;
  /** The submission in hand was refused by iOS. */
  wasRefused(): boolean;
  /** A task has been submitted and not yet ended. */
  isLive(): boolean;
  /** Is the system's progress banner for this task on screen? */
  showing(): boolean;
  /** Told when the system banner comes or goes (and on a heartbeat while it moves). */
  subscribe(listener: () => void): Unsubscribe;
  /** Runs before native hears an end (capped at `BEFORE_END_MS`). */
  beforeEnd(hook: (args: { complete: boolean; reason: string | null; failed: boolean }) => unknown): Unsubscribe;
  /** End the task. Always completes it as a success. Resolves once native has been told. */
  end(args?: ContinuedEndArgs): Promise<void>;
  /** The job's own per-task state to reset with the bar. */
  onStartOver(reset: () => void): Unsubscribe;
}

/**
 * A job's BGContinuedProcessingTask (iOS 26+), as the job sees it: begin from a tap, report
 * progress, ask whether iOS is still running it, and end it: always as a success, never
 * "Failed". Without native support every call is a no-op and `isRunning()` is false.
 */
export declare function createContinuedTask<B extends ContinuedTaskBar>(
  options: ContinuedTaskOptions<B>,
): ContinuedTask<B>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Notifier (createNotifier.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where a job's notifications live. */
export interface NotifyNamespace {
  /** Marks a notification's `data` as the job's. */
  dataKey: string;
  /** The dead-man's notification request id. */
  deadmanId: string;
  /** The kv row of the run's dedupe. */
  dedupeKey: string;
}

/** The neutral fallback namespace. Pass your own. */
export declare const DEFAULT_NAMESPACE: Readonly<{
  dataKey: 'expoContinuedTask';
  deadmanId: 'expo-continued-task-deadman';
  dedupeKey: 'expoContinuedTask.notify.dedupe';
}>;

/** Seconds out the dead-man's notification is kept while work runs away from the screen. */
export declare const DEADMAN_SECONDS: 45;
/** How often the dead-man's notification is pushed back, at most, ms. */
export declare const DEADMAN_THROTTLE_MS: 5000;
/** The reason key the dead-man's notification occupies in the run's dedupe. */
export declare const STALLED: 'stalled';

/** The actions every job's taps understand; a job adds its own with `onTap`. */
export declare const NOTIFY_ACTIONS: Readonly<{
  RESUME: 'resume';
  PAUSED: 'paused';
  REVIEW: 'review';
}>;

/** The words for one notification. `reason` is the dedupe key within a run. */
export interface NotifierCopy {
  title: string;
  body: string;
  action: string;
  reason: string;
}

/** What `notify` is told about the job. Free-form; `pauseReason` is read when present. */
export interface NotifierState {
  pauseReason?: string | null;
  [key: string]: unknown;
}

/** A notification's `data`, as a tap hands it to `onTap`. */
export interface NotificationTapData {
  action?: string;
  runId?: number;
  reason?: string;
  [key: string]: unknown;
}

/** What a tap may do. */
export interface NotificationTapActions {
  /** Navigate to the job's screen. */
  open: () => void | Promise<unknown>;
  /** Scroll it to the top. */
  top: () => void;
  /** The user-started continue path. */
  resume: () => void | Promise<unknown>;
  /** May work start right now? (the guards) */
  canResume: () => boolean;
  /**
   * The app has finished launching; nothing starts before it, and nothing starts if it says
   * false.
   */
  ready?: () => Promise<boolean> | boolean;
  /** Anything a job's own `onTap` actions read. */
  [key: string]: unknown;
}

export interface NotifierOptions<S extends NotifierState = NotifierState> {
  /** expo-notifications; a fake in tests. */
  Notifications?: NotificationsLike | null;
  /** The app's state now ('active' in front). */
  appState: () => string | null | undefined;
  mark?: MarkFn;
  /** The app's kv store; without one the dedupe is this process's memory. */
  store?: KeyValueStore | null;
  now?: () => number;
  namespace?: NotifyNamespace;
  /** The job's words for a state, or null for none. */
  copyFor: (state: S) => NotifierCopy | null | undefined;
  /** The dead-man's words (a pause with no reason). */
  stalledCopy: () => { title: string; body: string };
  /** The state's fields for the log line. */
  describe?: (state: S) => Record<string, unknown>;
  debug?: DebugFn;
  /** Extra tap actions, by `data.action`. */
  onTap?: Record<string, (data: NotificationTapData, ctx: { id: string; actions: NotificationTapActions }) => unknown>;
}

/** What `notify` did. */
export type NotifyResult = 'sent' | 'foreground' | 'nothing' | 'dedupe' | 'no_permission' | 'failed';

export interface Notifier<S extends NotifierState = NotifierState> {
  /** Send the job's notification for `state`: once per run and reason, never in front. */
  notify(state?: S): Promise<NotifyResult>;
  /** A new run: the last run's sent reasons are dropped. Resolves with the run number. */
  beginRun(): Promise<number>;
  /** A sign of life while work runs away from the screen: push the dead-man's notification back. */
  feedDeadman(): Promise<'foreground' | 'throttled' | 'armed' | 'dedupe' | 'no_permission' | 'failed'>;
  /** Work ended normally, or the app is back in front: no dead-man's notification is owed. */
  disarmDeadman(): Promise<'none' | 'fired' | 'cancelled'>;
  /** Ask for permission, in front, at a user's tap: the first time only. */
  askInFront(): Promise<boolean>;
  /** Act on a tap. Resolves true when it was the job's. */
  handleResponse(response: NotificationResponseLike | null | undefined, actions: NotificationTapActions): Promise<boolean>;
  /** Listen for taps: the one that launched the app, and every one after. Returns the unsubscribe. */
  listen(actions: NotificationTapActions): Unsubscribe;
  /** For a job's own notifications: the same queue. */
  serially<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Is notification permission granted? */
  granted(): Promise<boolean>;
  /** The memory trace, fenced. */
  note(label: string, extra?: Record<string, unknown> | null): void;
}

/**
 * Namespaced, passive notifications for a job: once per run and reason (deduped across
 * relaunches via `store`), never with the app in front, never asking for permission from the
 * background, a dead-man's notification while work runs away from the screen, and tap routing
 * (`resume`, `paused`, `review`, or the job's own `onTap`).
 */
export declare function createNotifier<S extends NotifierState = NotifierState>(options: NotifierOptions<S>): Notifier<S>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Foreground bridge (foregroundBridge.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ForegroundBridgeOptions {
  /** Settle whatever is in flight; awaited inside the grace grant. */
  onMinimise?: () => unknown;
  /** Resume. */
  onForeground?: () => unknown;
  /** react-native's AppState (injected). */
  appState: AppStateLike;
  /** The native bridge (injected). */
  bg: GraceBridge;
  log?: LogFn;
}

export interface ForegroundBridge {
  /** Subscribe to AppState. Returns `stop`. */
  start(): () => void;
  stop(): void;
  /** Drive a transition without an emitter (tests). */
  handleChange(next: string): Promise<void>;
  /** Is a minimise's grace handler in flight? */
  isSettling(): boolean;
}

/**
 * AppState, and the ~30 s grace grant around a minimise: on `background` take the grant, await
 * `onMinimise`, release it; on `active` await `onForeground`. `inactive` is ignored.
 */
export declare function createForegroundBridge(options: ForegroundBridgeOptions): ForegroundBridge;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Grace-only job (graceOnlyJob.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface GraceOnlyJobOptions {
  /** The job's unique name. */
  name: string;
  /** One unit of work; resolves false when there is none left. */
  step: () => Promise<boolean>;
  /** react-native's AppState. */
  appState: AppStateLike;
  /** The native bridge (begin/end the grace grant). */
  bg: GraceBridge;
}

export interface GraceOnlyJob {
  job: BackgroundJob;
  /** Start (or join) the loop. Resolves 'empty' when the work ran out, 'stopped' on a minimise. */
  start(): Promise<'stopped' | 'empty'>;
  isRunning(): boolean;
  /** Drive AppState without an emitter (tests). */
  handleChange(next: string): Promise<void>;
  dispose(): void;
}

/**
 * A short job that needs only the ~30 s grace grant after a minimise: declared, busy while it
 * runs, finishes the unit in hand and stops at a boundary when the app leaves.
 */
export declare function createGraceOnlyJob(options: GraceOnlyJobOptions): GraceOnlyJob;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Continued job (createContinuedJob.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The resume line, short enough for the ~30-character banner subtitle. */
export declare const DEFAULT_RESUME_LINE: 'Tap to resume';

/** The banner's words. */
export interface ContinuedJobWords {
  title: string;
  line: (counts: { done: number; total: number }) => string;
  done: (counts: { total: number }) => string;
  /** Default 'Paused'. */
  paused?: string;
  /** Default `DEFAULT_RESUME_LINE`. */
  resume?: string;
}

export interface ContinuedJobNotifications {
  /** expo-notifications. */
  Notifications: NotificationsLike;
  /** Where the dedupe survives a relaunch. */
  store?: KeyValueStore | null;
  done: { title: string; body: string };
  paused: { title: string; body: string };
}

export interface ContinuedJobOptions {
  /** Unique job name; also its notification namespace. */
  name: string;
  /** Persisted identifiers, recorded on the job. */
  identifiers?: Record<string, unknown>;
  /** The native bridge (`import * as bg from '@aermes/expo-continued-task'`). */
  bg: ContinuedBridge;
  /** react-native's AppState. */
  appState: AppStateLike;
  /** How many units the run owes; null when unknown. */
  size: () => number | null | Promise<number | null>;
  /** One unit; resolves false when none are left. */
  step: () => Promise<boolean>;
  /** Measured background cost of one unit, ms (the bar's seed). Default 1000. */
  seedMs?: number;
  words: ContinuedJobWords;
  /** Omit for no notifications. */
  notifications?: ContinuedJobNotifications | null;
  /**
   * The continued task's identifier prefix; must match a prefix the config plugin permits.
   * Default: the plugin's `taskIdentifierPrefix`.
   */
  taskPrefix?: string | null;
  /** The lifecycle log's folder. Default: the plugin's `logDirectory`. */
  logDir?: string | null;
  now?: () => number;
  debug?: DebugFn;
  mark?: MarkFn;
}

/** How a run ended. `total` is null when the size was unknown. */
export interface ContinuedJobResult {
  complete: boolean;
  done: number;
  total: number | null;
}

export interface ContinuedJob {
  job: BackgroundJob;
  /** Start from a person's tap, with the app in front. Joins a run already in flight. */
  start(): Promise<ContinuedJobResult>;
  /** Stop at the next unit boundary (still a paused success). Null when nothing was running. */
  stop(): Promise<ContinuedJobResult | null>;
  isRunning(): boolean;
  /** Taps on the job's notifications. Returns the unsubscribe (a no-op without notifications). */
  listen(actions: NotificationTapActions): Unsubscribe;
  /** Drive AppState without an emitter (tests). */
  handleChange(next: string): Promise<void>;
  dispose(): void;
}

/**
 * A long, user-started background job in one call, for work that is "a queue of units":
 * `start()` submits the BGContinuedProcessingTask (call it from a tap, app in front), every unit
 * moves a cost-weighted bar that stays under 100 % while units are owed, the work goes on away
 * from the app while iOS runs the task and otherwise stops at a unit boundary inside the grace
 * grant, every ending completes as a success ("Paused" or the done line), and with
 * `notifications` the done / paused notification is sent before the task ends.
 */
export declare function createContinuedJob(options: ContinuedJobOptions): ContinuedJob;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Advanced: the machinery a multi-phase job with its own UI assembles itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

export * as policy from './policy';

// Guards (guards.js) ───────────────────────────────────────────────────────────────────────────

/** 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown', or whatever the device reports. */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown' | (string & {});

/** One device reading. Every field degrades to something safe rather than throwing. */
export interface GuardReading {
  thermal: ThermalState;
  lowPower: boolean;
  charging: boolean;
  /** 0..1, or -1 before the OS has reported one. */
  level: number;
  /** 'full', 'limited', 'unknown', or the platform's word for anything else. */
  access: string;
  /** -1 when unreadable. */
  rssMb: number;
}

/** A reading when nothing can be read. */
export declare const UNKNOWN_READING: Readonly<{
  thermal: 'unknown';
  lowPower: false;
  charging: false;
  level: -1;
  access: 'unknown';
  rssMb: -1;
}>;

/**
 * Force device reading fields (dev builds only; inert outside `__DEV__`). Null or `{}` clears it.
 * Returns what is now in force.
 */
export declare function setGuardOverride(next: Partial<GuardReading> | null): Partial<GuardReading> | null;

/** What is being forced, if anything. */
export declare function guardOverride(): Partial<GuardReading> | null;

/** A processing window's state, as the device module reports it. */
export interface WindowState {
  active?: boolean;
  expired?: boolean;
  remainingMs?: number;
  rssMb?: number;
  rssDeltaMb?: number;
  seq?: number;
}

/** The device port: typically the app's own device module. Every method is optional. */
export interface DevicePort {
  /** RSS in MB, or `{rssMb}`. */
  memoryUsage?(): number | { rssMb?: number } | null | undefined;
  thermalState?(): string | null | undefined;
  lowPowerMode?(): boolean;
  powerState?(): { charging?: boolean; level?: number; lowPower?: boolean } | null | undefined;
  /** Standing library authorization ('authorized' reads as 'full'). */
  authorization?(): string | null | undefined;
  windowState?(): WindowState | null | undefined;
}

/** How much room is left, in time and in memory growth. */
export interface GuardBudget {
  remainingMs: number;
  expired: boolean;
  rssMb: number;
  rssDeltaMb: number;
  active: boolean;
  seq: number;
}

export interface GuardsOptions {
  device: DevicePort;
  bg: Partial<Pick<NativeBridge, 'remainingMs' | 'continuedTaskState'>>;
  /** Standing library authorization; never prompts. Default: `device.authorization()`. */
  getAccess?: (() => string | null | undefined) | null;
  now?: () => number;
  /** The processing window's state. Default: `device.windowState()`. */
  windowState?: () => WindowState | null | undefined;
}

export interface Guards {
  read(): GuardReading;
  budget(context: RunContext): GuardBudget;
  /** Open a run: fix the RSS baseline (null for a window, whose baseline is native's). */
  startRun(context: RunContext): number | null;
  endRun(): void;
  /** ms since `startRun()`. */
  elapsed(): number;
  /** RSS in MB, or -1. */
  rss(): number;
}

/** Everything the device says about whether the job may keep working: `read()` and `budget(context)`. */
export declare function createGuards(options: GuardsOptions): Guards;

// Executor (createExecutor.js) ────────────────────────────────────────────────────────────────

/** Stop reading pages with less than this left in the window, ms. */
export declare const MIN_READ_HEADROOM_MS: 3000;

/** The words the executor writes (summary keys, log lines). */
export interface ExecutorVocabulary {
  items: string;
  groupIds: string;
  groups: string;
  onItem: string;
  onFollowUp: string;
}

/** The neutral defaults. */
export declare const EXECUTOR_VOCABULARY: Readonly<{
  items: 'items';
  groupIds: 'groupIds';
  groups: 'groups';
  onItem: 'onItem';
  onFollowUp: 'onFollowUp';
}>;

/** What a commit landed. */
export interface CommitResult {
  advanced: number;
  deferred: number;
  failed: number;
}

/** Where the executor reads and writes the job's work. */
export interface WorkSource<U = { id?: unknown }, R = unknown> {
  /** The next chunk of units, head first. */
  queue(args: { limit: number; allowNetwork: boolean }): Promise<U[]>;
  /** Land a chunk, idempotently. */
  commit(results: R[]): Promise<CommitResult>;
  /** Optional: fold the job's write-ahead log back in after a run. */
  checkpoint?(): unknown;
  /** Where the one pause line lives. */
  pause: {
    write(reason: string): unknown;
    clear(): unknown;
    read(): Promise<string | null | undefined> | string | null | undefined;
  };
}

/** What `work` is handed beside the chunk. */
export interface ChunkContext {
  context: RunContext;
  remainingMs: number;
  /** The one signal that reaches inside a chunk: return the rows finished so far. */
  shouldStop(): boolean;
  /** Per item, as the worker finishes each one. */
  onProgress(progress?: { done?: number; total?: number }): void;
}

/**
 * What `work` resolves with. `pause` raises a pause of its own; the groups moved are read under
 * the `vocabulary.groupIds` key.
 */
export interface ChunkResult<R = unknown> {
  results?: R[];
  pause?: string | null;
  offlineShare?: unknown;
  [key: string]: unknown;
}

/** A chunk committed (`onChunk`). Counts are under the vocabulary's `items` / `groupIds` keys. */
export interface ChunkInfo {
  context: RunContext;
  assetId: unknown;
  deferred: number;
  failed: number;
  [key: string]: unknown;
}

/** The run's summary. `items` is under the key `vocabulary.items` names. */
export interface ExecutorSummary {
  chunks: number;
  deferred: number;
  failed: number;
  stop: StopReason;
  pauseReason: string | null;
  idleReason: string | null;
  error: string | null;
  ms: number;
  /** Absent on an `already_running` answer. */
  assetsRead?: number;
  /** Null when no read leg ran. Absent on an `already_running` answer. */
  readComplete?: boolean | null;
  /** 'already_running' when a run was already in flight. */
  skipped?: 'already_running';
  [key: string]: unknown;
}

export type FollowUpEvent =
  | { phase: 'start'; context: RunContext }
  | { phase: 'end'; context: RunContext; summary: ExecutorSummary };

export interface ExecutorOptions<U = { id?: unknown }, R = unknown> {
  source: WorkSource<U, R>;
  /** The chunk worker. */
  work: (rows: U[], ctx: ChunkContext) => Promise<ChunkResult<R> | null | undefined>;
  guards: Pick<Guards, 'read' | 'budget' | 'startRun' | 'endRun'>;
  /** The policy's `decide`, with the job's pause vocabulary. */
  decide: (args: DecideArgs) => Verdict;
  settings?: { allowOnBattery?: boolean };
  /** Once per run when the queue empties: finalise groups no chunk touches any more. */
  sweep?: (() => number | Promise<number>) | null;
  /** After every chunk commits. Never awaited, never allowed to throw into the loop. */
  onChunk?: ((info: ChunkInfo) => unknown) | null;
  /** A preparatory leg (e.g. an indexing pass that fills the queue), once, before the first chunk. */
  readLeg?:
    | ((args: { context: RunContext; shouldStop: () => boolean; remainingMs: () => number }) => Promise<
        { read?: number; total?: number; complete?: boolean; pages?: number; skipped?: unknown } | null | undefined
      >)
    | null;
  /** The chunk loop starting (`{phase: 'start'}`) and ending (`{phase: 'end', summary}`); awaited. */
  onFollowUp?: ((event: FollowUpEvent) => unknown) | null;
  now?: () => number;
  log?: LogFn;
  debug?: {
    debugLog?: DebugFn;
    debugFlush?: () => void;
    debugNet?: (fields: Record<string, unknown>) => void;
    debugCaller?: () => unknown;
  };
  /** A unit of work that threw, traced; awaited. */
  traceError?: (error: unknown, step: 'queue' | 'chunk' | 'commit', context: RunContext) => unknown;
  /** A chunk that moved nothing. */
  onStall?: (fields: Record<string, unknown>) => void;
  /** A run that ended on a pause. */
  onPaused?: (reason: string) => void;
  /** A chunk committed (telemetry). */
  onChunkDone?: (chunk: Record<string, unknown>) => void;
  /** The words it writes, merged over `EXECUTOR_VOCABULARY`. */
  vocabulary?: Partial<ExecutorVocabulary> | null;
}

export interface Executor {
  /** Run chunks until one of the endings. */
  run(args?: { context?: RunContext; tapInitiated?: boolean; allowNetwork?: boolean; maxChunks?: number }): Promise<ExecutorSummary>;
  /** Stop at the next chunk boundary; with `midChunk`, at the chunk's next item. */
  requestStop(opts?: { midChunk?: boolean }): void;
  isRunning(): boolean;
  setOnChunk(fn: ((info: ChunkInfo) => unknown) | null | undefined): void;
  setOnItem(fn: ((item: { context: RunContext; done: number; total: number }) => void) | null | undefined): void;
  setPause(reason: string | null | undefined): Promise<void>;
  clearPause(): Promise<void>;
  /** The reason the source currently carries. */
  storedPauseReason(): Promise<string | null>;
  /** Test seam. */
  __lastChunkMs(): number;
}

/**
 * The chunk loop: pop work from a `WorkSource` in chunks, run `work`, commit, and stop at the
 * right moment for the right reason. A stop request never aborts a chunk (unless `midChunk`).
 */
export declare function createExecutor<U = { id?: unknown }, R = unknown>(options: ExecutorOptions<U, R>): Executor;

// Coordinator (createCoordinator.js) ──────────────────────────────────────────────────────────

/** The words the coordinator writes. */
export interface CoordinatorVocabulary {
  debugCategory: string;
  beginTask: string;
  awaitingResume: string;
  followUpPendingKey: string;
}

/** The neutral defaults. */
export declare const COORDINATOR_VOCABULARY: Readonly<{
  debugCategory: 'coordinator';
  beginTask: 'beginTask';
  awaitingResume: 'awaiting_resume';
  followUpPendingKey: 'followUpPending';
}>;

/** What the coordinator needs of the job's continued task (a `createContinuedTask` result fits). */
export type CoordinatorContinued = Pick<ContinuedTask, 'begin' | 'end'> &
  Partial<Pick<ContinuedTask, 'supported' | 'isLive' | 'stale' | 'armResignNet' | 'adoptResign'>>;

export interface CoordinatorOptions {
  continued: CoordinatorContinued | null;
  /** Is the app in front? A probe that throws is yes. */
  isForeground: () => boolean;
  debug?: DebugFn;
  mark?: MarkFn;
  phases?: Partial<PhaseNames>;
  vocabulary?: Partial<CoordinatorVocabulary> | null;
}

export interface Coordinator {
  inFront(): boolean;
  /** A FOREGROUND loop needs the app in front; the other owners carry their own licence. */
  mayOwn(owner: string): boolean;
  /** Work is owed and the app is in front with no task under it: wait for the person. */
  mustAskFirst(): boolean;
  /** Park for the person's Resume; returns `getState()` (null by default). */
  parkForResume<S = null>(
    kind: string,
    opts: { caller?: unknown; onPark?: () => void; setPaused: (pauseReason: string) => void; getState?: () => S },
  ): S;
  /** Keep native's resign net armed exactly while work runs with no task live. */
  syncResignNet(work: { mainRunning: boolean; followUpRunning: unknown; line: (phase: string) => string }): void;
  /** Submit the continued task for work the user started by a tap. True when one was asked for. */
  beginTask(args?: { phase?: string; caller?: unknown }): boolean;
  /** The minimise, as far as the continued task is concerned. Synchronous. */
  minimiseHandOff(args: {
    followUpRunning: () => unknown;
    openUnits: () => unknown;
    leave: () => void;
    passContext: () => string | null | undefined;
    stopMidChunk: () => void;
  }): void;
}

/** Who may start what, when a person must be asked first, and the hand-off to the continued task. */
export declare function createCoordinator(options: CoordinatorOptions): Coordinator;

// Indicator publisher (createIndicatorPublisher.js, connectIndicator.js) ─────────────────────────

/** How long the done line stays up after the continued task hands over, ms. */
export declare const DONE_BEAT_MS: 4000;

/** The Live Activity module surface (the app's own). Every method is optional. */
export interface LiveActivityLike {
  start?(payload: unknown): unknown;
  update?(payload: unknown): unknown;
  end?(): unknown;
  /** `false` is off. */
  isEnabled?(): boolean;
  setDebugLogGate?(on: boolean): unknown;
}

/** The background processing window the scheduler has not finished with. */
export interface ProcessingWindow {
  pending(): boolean;
  subscribe(listener: () => void): Unsubscribe;
  active?: boolean;
  expired?: boolean;
}

/** `false` from `Live.isEnabled()` is off; anything else (on, or an older binary) is not. */
export declare function liveActivitiesOff(Live: LiveActivityLike | null | undefined): boolean;

/** A window the scheduler has not finished with. Anything unreadable is not one. */
export declare function windowPending(processingWindow: { pending?: () => boolean } | null | undefined): boolean;

/** A bar for the pipeline's state: the job's own shape. A truthy `paused` marks a paused bar. */
export interface IndicatorModel {
  paused?: boolean;
}

export interface IndicatorPublisherOptions<I extends object = Record<string, unknown>, M extends object = IndicatorModel, P = unknown> {
  /** The model's inputs: the job's state. */
  read: () => I | null | undefined;
  processingWindow?: () => ProcessingWindow | null | undefined;
  Live?: LiveActivityLike | null;
  appState: () => string;
  /** Live Activities are off: ask once (e.g. send the user to Settings). */
  prompt?: () => void;
  /** Is the continued task's own banner on screen? Then it is the one indicator. */
  systemShowing?: () => boolean;
  /** The App Group file name of the item in hand's thumbnail, or null. */
  thumb?: () => string | null | undefined;
  mark?: MarkFn;
  /** A bar is owed after the hand-over, but the app is away and ActivityKit will not start one. */
  onBackgroundHandoffRefused?: (state: { runId: number; owed: boolean; [key: string]: unknown }) => void;
  /** The continued banner took over: a new job run begins. */
  onHandoverBegan?: () => void;
  /** Every publish while the continued banner shows. */
  onSystemProgress?: (appState: string) => void;
  /** The continued banner went away. */
  onSystemGone?: () => void;
  /** Is work still owed? */
  owed?: () => boolean;
  /** Is a read or a work pass running (or committed to) right now? */
  running?: () => boolean;
  /** The bar for the pipeline's state, or null. */
  model: (input: I & { parking: unknown }) => M | null | undefined;
  /** The content state ActivityKit is handed. */
  payload: (next: M, extras: { thumb: string | null; kind: 'running' | 'paused' | 'done' }) => P;
  /** The take-over's done bar. */
  donePayload: (input: I) => M;
  /** Would ActivityKit be told anything new? */
  samePayload: (a: P, b: P | null) => boolean;
  /** The content state, flat, for the debug log. */
  payloadFields: (payload: P) => Record<string, unknown>;
  /** A pass is running or committed to. */
  passing: (input: I) => boolean;
  /** The pipeline says it is done. */
  isFound: (input: I) => boolean;
  /** The app is leaving work behind that is about to park. */
  parking: (input: I, current: string, window: ProcessingWindow | null | undefined) => unknown;
  /** The input's fields for the log line. */
  describe: (input: I) => Record<string, unknown>;
  /** The state the refused-hand-off hook is told. */
  handoffState: (input: I) => Record<string, unknown>;
  debug?: DebugFn;
  isDebugLogEnabled?: () => boolean;
}

export interface IndicatorPublisher<P = unknown> {
  /** Bring the Lock Screen into line with the pipeline. Synchronous; at most one native call. */
  publish(current?: string): void;
  /** Stop listening, and take down a bar this session put up. */
  dispose(): void;
  /** Back in front: forget what was believed while away. */
  resync(): void;
  /** Show the done line briefly. */
  showDone(): void;
  /** Test seam. */
  __last(): P | null;
}

/** The one place a job's Live Activity is told anything. */
export declare function createIndicatorPublisher<I extends object, M extends object, P>(
  options: IndicatorPublisherOptions<I, M, P>,
): IndicatorPublisher<P>;

export interface ConnectIndicatorOptions {
  publisher: Pick<IndicatorPublisher, 'publish' | 'resync' | 'dispose' | 'showDone'>;
  /** Each subscribes and returns its unsubscribe (or null). */
  sources?: Array<(publish: () => void) => Unsubscribe | null | undefined | void>;
  subscribeAppState: (listener: (state: string) => void) => Unsubscribe | null | undefined | void;
}

export interface ConnectedIndicator {
  publish(current?: string): void;
  showDone(): void;
  disconnect(): void;
}

/** Wire an indicator publisher to what moves it, and re-assert it on every return to the app. */
export declare function connectIndicator(options: ConnectIndicatorOptions): ConnectedIndicator;
