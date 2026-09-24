/**
 * Is background work in flight right now? A tiny, app-wide question.
 *
 * First asked by an OTA update gate while it still reloaded into a downloaded update — which it
 * used to do the moment one had downloaded, mid-job, on every foreground. In testing a long job
 * lost its UI and its pass twice in five minutes (runtime restarts ~5 s after each
 * `app.active`). Such a gate should not reload mid-job at all; the bit stays for the next thing
 * that must not interrupt one.
 *
 * Each job registers its own answer under its name (`registerBusy`) and says when it may have
 * moved (`announceBusy`); nothing registered — the feature off, a test, a screen outside the
 * provider — is never busy. `anyBusy()` is the question an app-wide gate asks. An app may keep
 * older feature-specific names as thin aliases over its own source.
 */
const sources = new Map();
const listeners = new Set();

/** True while `name`'s work is live (e.g. a pass of the job, a background window or a continued task). */
export function isBusy(name) {
  const source = sources.get(name) || null;
  try {
    return source ? source() === true : false;
  } catch (e) {
    return false;
  }
}

/** True while any registered job is busy. */
export function anyBusy() {
  return Array.from(sources.keys()).some((name) => isBusy(name));
}

export function subscribeBusy(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A job's side: what "busy" means for `name`, once. Returns the unregister. */
export function registerBusy(name, fn) {
  if (typeof fn === 'function') sources.set(name, fn);
  else sources.delete(name);
  announceBusy();
  return () => {
    if (sources.get(name) === fn) sources.delete(name);
    announceBusy();
  };
}

/**
 * What must happen before the JS runtime is replaced. `Updates.reloadAsync()`
 * keeps the process and its native SQLite connection; a reload that lands mid-transaction leaves
 * that connection holding the write lock, and every write the new runtime makes fails "database
 * is locked" — eight "Failed" banners in one run in testing. The app registers its queue's
 * drain; e.g. an error boundary's "Restart app" awaits `beforeAppReload` before reloading. (An
 * OTA gate is better off not reloading at all: a downloaded update applies on the next cold launch.)
 */
let reloadHook = null;

export function registerBeforeReload(fn) {
  reloadHook = typeof fn === 'function' ? fn : null;
  return () => {
    if (reloadHook === fn) reloadHook = null;
  };
}

/** Run the registered hook, bounded; never throws, never holds a reload past `timeoutMs`. */
export async function beforeAppReload({ timeoutMs = 4000 } = {}) {
  if (!reloadHook) return null;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => reloadHook()),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }),
    ]);
  } catch (e) {
    return { error: e?.message || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Something the answer depends on may have changed; listeners re-ask. */
export function announceBusy() {
  Array.from(listeners).forEach((fn) => {
    try { fn(); } catch (e) { /* a listener's failure is its own */ }
  });
}
