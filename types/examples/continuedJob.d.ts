/**
 * An example long, user-started job on `createContinuedJob`: export a list of items, one at a
 * time, with the system progress banner. Not part of the root export.
 */
import type {
  AppStateLike, ContinuedBridge, ContinuedJob, KeyValueStore, NotificationsLike,
} from '../index';

export interface ExportJobOptions<T> {
  items: T[];
  exportOne: (item: T) => Promise<unknown>;
  bg: ContinuedBridge;
  appState: AppStateLike;
  /** expo-notifications; omit for no notifications. */
  Notifications?: NotificationsLike | null;
  store?: KeyValueStore | null;
  /** Default 'example-export'. */
  name?: string;
  taskPrefix?: string | null;
  logDir?: string | null;
}

export declare function createExportJob<T>(options: ExportJobOptions<T>): ContinuedJob;
export default createExportJob;
