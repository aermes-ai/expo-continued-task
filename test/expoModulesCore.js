// expo-modules-core under Node: there is no native module, so requireNativeModule throws, the
// same as on a platform or binary without ExpoContinuedTask.
module.exports = {
  requireNativeModule(name) {
    throw new Error(`Cannot find native module '${name}'`);
  },
};
