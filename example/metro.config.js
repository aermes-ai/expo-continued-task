// Metro, set up to run the package from source: `@aermes/expo-continued-task` is `file:..`, so
// Metro watches the package root, and resolves every dependency (react, react-native, expo, …)
// from this example's own node_modules. The package's node_modules, if you ran `npm install`
// there for its tests, is blocked so there is exactly one copy of React and React Native.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const packageRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [packageRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

const escape = (p) => p.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
const parentModules = new RegExp(`^${escape(path.join(packageRoot, 'node_modules'))}[/\\\\].*`);
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  parentModules,
];

module.exports = config;
