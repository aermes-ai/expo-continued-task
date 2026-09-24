/**
 * The config plugin: everything a continued task needs in Info.plist, from app config.
 *
 *   plugins: [["@aermes/expo-continued-task", {
 *     taskIdentifierPrefix: "com.example.app.work",   // tasks are <prefix>.<uuid>
 *     extraTaskIdentifierPrefixes: [],                // more prefixes JS may submit under
 *     logDirectory, logFileName,                      // Documents/<dir>/<file> lifecycle log
 *     pausedTitle, pausedSubtitle,                    // an ending iOS forced says this, never "Failed"
 *     etaDefaultsKey, grantName,
 *     debugLog: { directory, fileName, source, appGroup, enabledKey, overrideKey },  // optional
 *   }]]
 *
 * It writes the options into the `ExpoContinuedTask` Info.plist dictionary the module reads, and
 * adds `<prefix>.*` for every prefix to BGTaskSchedulerPermittedIdentifiers and `processing` to
 * UIBackgroundModes — each only if absent, so identifiers an app already lists keep their order.
 */
const KEYS = [
  'taskIdentifierPrefix', 'logDirectory', 'logFileName', 'pausedTitle', 'pausedSubtitle',
  'etaDefaultsKey', 'grantName', 'debugLog',
];

function applyPlist(plist, options = {}, bundleIdentifier = 'app') {
  const config = {};
  KEYS.forEach((key) => {
    if (options[key] != null) config[key] = options[key];
  });
  const prefix = options.taskIdentifierPrefix || `${bundleIdentifier}.continued`;
  const prefixes = [prefix, ...(options.extraTaskIdentifierPrefixes || [])];
  const permitted = Array.isArray(plist.BGTaskSchedulerPermittedIdentifiers)
    ? [...plist.BGTaskSchedulerPermittedIdentifiers] : [];
  prefixes.forEach((p) => {
    const id = `${p}.*`;
    if (!permitted.includes(id)) permitted.push(id);
  });
  const modes = Array.isArray(plist.UIBackgroundModes) ? [...plist.UIBackgroundModes] : [];
  if (!modes.includes('processing')) modes.push('processing');
  return {
    ...plist,
    BGTaskSchedulerPermittedIdentifiers: permitted,
    UIBackgroundModes: modes,
    ExpoContinuedTask: config,
  };
}

function withContinuedTask(config, options = {}) {
  // Required here, not at the top: `expo` is a peer, and applyPlist is pure (and tested) without it.
  const { withInfoPlist } = require('expo/config-plugins');
  return withInfoPlist(config, (next) => {
    // eslint-disable-next-line no-param-reassign
    next.modResults = applyPlist(next.modResults, options, next.ios?.bundleIdentifier);
    return next;
  });
}

module.exports = withContinuedTask;
module.exports.applyPlist = applyPlist;
