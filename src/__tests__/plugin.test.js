/**
 * The config plugin's Info.plist: a new app gets neutral names; an app that already shipped
 * identifiers keeps them, in the order it shipped them.
 */
const { applyPlist } = require('../../app.plugin');

test('a new app: its own prefix, processing mode, and the module config', () => {
  const plist = applyPlist({}, { taskIdentifierPrefix: 'com.example.app.work' }, 'com.example.app');
  expect(plist.BGTaskSchedulerPermittedIdentifiers).toEqual(['com.example.app.work.*']);
  expect(plist.UIBackgroundModes).toEqual(['processing']);
  expect(plist.ExpoContinuedTask).toEqual({ taskIdentifierPrefix: 'com.example.app.work' });
});

test('no prefix: <bundleId>.continued.*', () => {
  expect(applyPlist({}, {}, 'com.example.app').BGTaskSchedulerPermittedIdentifiers)
    .toEqual(['com.example.app.continued.*']);
});

test('an app that already lists its ids keeps them, in order, with nothing doubled', () => {
  const shipped = [
    'com.example.app.bench', 'com.example.app.refresh',
    'com.example.app.scan.*', 'com.example.app.work.*',
  ];
  const plist = applyPlist(
    { BGTaskSchedulerPermittedIdentifiers: shipped, UIBackgroundModes: ['location', 'remote-notification', 'processing'] },
    { taskIdentifierPrefix: 'com.example.app.scan', extraTaskIdentifierPrefixes: ['com.example.app.work'] },
  );
  expect(plist.BGTaskSchedulerPermittedIdentifiers).toEqual(shipped);
  expect(plist.UIBackgroundModes).toEqual(['location', 'remote-notification', 'processing']);
});
