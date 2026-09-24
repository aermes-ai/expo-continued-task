/**
 * defineBackgroundJob — the one place a feature declares that it does background work.
 *
 * A job is a name and its identifiers: what it calls its continued task, its BGProcessing task,
 * its notifications and its log. Declaring it registers the name, so app-wide questions — "is
 * anything working right now?" (`anyBusy`, the busy registry) — include it without the asker
 * knowing the job exists. Everything a job then builds (a continued task, a notifier, a
 * coordinator, an executor) takes the job's identifiers as config: see README.md for the steps.
 *
 * Names are unique: defining one twice returns the first, unchanged — a module evaluated twice
 * (a Fast Refresh, a test registry reset) must not fork a job's state.
 */
import { announceBusy, isBusy, registerBusy } from './busy';

const jobs = new Map();

/**
 * @param {Object} spec
 * @param {string} spec.name  unique; also the busy source's name
 * @param {Object} [spec.identifiers]  the job's persisted identifiers (e.g. kept together in
 *   one module of the app's): BG task ids, kv keys, log files, App Group keys, notification namespace
 * @param {string} [spec.description]
 * @returns {{name: string, identifiers: Object, description: string,
 *            registerBusy: Function, announceBusy: Function, isBusy: Function}}
 */
export function defineBackgroundJob({ name, identifiers = {}, description = '' }) {
  if (typeof name !== 'string' || !name) throw new Error('defineBackgroundJob: a job needs a name');
  if (jobs.has(name)) return jobs.get(name);
  const job = Object.freeze({
    name,
    identifiers,
    description,
    /** What "busy" means for this job, once. Returns the unregister. */
    registerBusy: (fn) => registerBusy(name, fn),
    /** Something the answer depends on may have changed. */
    announceBusy: () => announceBusy(),
    isBusy: () => isBusy(name),
  });
  jobs.set(name, job);
  return job;
}

/** Every job declared so far, in the order they were. */
export function backgroundJobs() {
  return Array.from(jobs.values());
}

export function backgroundJob(name) {
  return jobs.get(name) || null;
}
