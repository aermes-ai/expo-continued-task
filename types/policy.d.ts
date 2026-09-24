/**
 * policy: the numbers and the "may we work right now" decision, as pure functions.
 *
 * Exposed from the package root as the `policy` namespace (`import { policy } from
 * '@aermes/expo-continued-task'`). It is not a subpath export of its own.
 */
import type { GuardReading } from './index';

/**
 * The pause vocabulary: the lines a guard can put in front of the user. A job passes its own to
 * `decide`; these are the defaults.
 */
export declare const PAUSES: Readonly<{
  PERMISSION_REVOKED: 'permission_revoked';
  THERMAL: 'thermal';
  NEEDS_CHARGING: 'needs_charging';
  LOW_POWER_MODE: 'low_power_mode';
}>;

/** A job's own pause vocabulary: the same keys as `PAUSES`, any values. */
export interface PauseVocabulary {
  PERMISSION_REVOKED: string;
  THERMAL: string;
  NEEDS_CHARGING: string;
  LOW_POWER_MODE: string;
}

/** Where the chunk loop is running. Each has its own budget and its own ending. */
export declare const CONTEXTS: Readonly<{
  /** The user is watching. Tap-initiated runs go flat out here. */
  FOREGROUND: 'foreground';
  /** The ~30 s `beginBackgroundTask` grant after a minimise. Finish, do not start. */
  GRACE: 'grace';
  /** A BGProcessingTask window. Idle or charging, never in Low Power Mode. */
  WINDOW: 'window';
  /** A BGContinuedProcessingTask the user started, running after a minimise. */
  CONTINUED: 'continued';
}>;

/** One of `CONTEXTS`. */
export type RunContext = (typeof CONTEXTS)[keyof typeof CONTEXTS];

/** Why the chunk loop ended. Only `PAUSED` carries a line for the user. */
export declare const STOP_REASONS: Readonly<{
  /** The work queue is empty. */
  EMPTY: 'empty';
  /** The OS expiration handler fired, or the assumed budget ran out. */
  EXPIRED: 'expired';
  /** Not enough time left to finish another chunk (see `headroomFor`). */
  HEADROOM: 'headroom';
  /** RSS grew past the delta ceiling for this context. */
  RSS: 'rss';
  /** A chunk moved nothing: the queue head is all deferred or all failing. */
  STALLED: 'stalled';
  /** A guard said no. `pauseReason` says which, and the user sees it. */
  PAUSED: 'paused';
  /** Ambient work is waiting for its conditions (off a charger). Not a pause. */
  IDLE: 'idle';
  /** A caller asked the loop to stop. */
  STOPPED: 'stopped';
  /** `work()` threw. The chunk is not committed; the next pass redoes it. */
  ERROR: 'error';
}>;

/** One of `STOP_REASONS`. */
export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];

/** Items per chunk. */
export declare const CHUNK_SIZE: 50;

/** RSS GROWTH allowed inside one run, by context, in MB. */
export declare const RSS_DELTA_CEILING_MB: Readonly<{
  window: 150;
  grace: 150;
  continued: 150;
  foreground: 300;
}>;

/** Never start a chunk with less than this left, whatever the measured chunk time. */
export declare const MIN_HEADROOM_MS: 10000;

/** Headroom = measured chunk time x this. */
export declare const HEADROOM_FACTOR: 1.5;

/** First-chunk estimate, until a real one has been timed. */
export declare const ASSUMED_CHUNK_MS: 4000;

/** Below this battery level, ambient work stops. */
export declare const BATTERY_FLOOR: 0.2;

/**
 * Chunk size for the conditions in front of us: halved on thermal `fair` and in Low Power Mode
 * (the two compound). At least 1.
 */
export declare function chunkSizeFor(args?: {
  /** 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown' */
  thermal?: string;
  lowPower?: boolean;
  base?: number;
}): number;

/** RSS growth allowed in this context, in MB (unknown contexts get the window's). */
export declare function ceilingFor(context: string): number;

/** Time that must be left before another chunk may START, from the last measured chunk. */
export declare function headroomFor(lastChunkMs?: number): number;

export interface DecideArgs {
  /** One of `CONTEXTS`. */
  context: RunContext;
  /** Kept for callers and telemetry; it no longer changes the answer. */
  tapInitiated?: boolean;
  /** A `guards.read()` snapshot. */
  reading: Partial<GuardReading>;
  /** `allowOnBattery` lifts the charger requirement for background windows too. */
  settings?: { allowOnBattery?: boolean };
  /** The job's pause vocabulary (`PAUSES` by default). */
  pauses?: PauseVocabulary;
}

export interface Verdict {
  proceed: boolean;
  /** A line the user reads. */
  pauseReason: string | null;
  /** The ordinary resting state; deliberately silent. */
  idleReason: string | null;
  chunkSize: number;
  ceilingMb: number;
}

/**
 * May the loop run another chunk, and how big? Access first, then heat, then a flat battery
 * (the same everywhere); Low Power Mode off a charger stops continued and window runs; the
 * charger requirement applies to background windows only (as an idle, not a pause).
 */
export declare function decide(args: DecideArgs): Verdict;

declare const _default: {
  CONTEXTS: typeof CONTEXTS;
  STOP_REASONS: typeof STOP_REASONS;
  decide: typeof decide;
  chunkSizeFor: typeof chunkSizeFor;
  ceilingFor: typeof ceilingFor;
  headroomFor: typeof headroomFor;
};
export default _default;
