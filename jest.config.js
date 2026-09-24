// The package's own tests, run standalone (`npm test`): pure JS against doubles of the native
// module and of AppState, so a plain Node environment is enough. The native side is covered by
// harness/ (Swift, on a Mac) and on a device.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  transform: { '^.+\\.js$': 'babel-jest' },
  moduleNameMapper: {
    // No native module under Node: the JS falls back to its no-ops, as it does on Android.
    '^expo-modules-core$': '<rootDir>/test/expoModulesCore.js',
    '^@aermes/expo-continued-task$': '<rootDir>/src/index.js',
    '^@aermes/expo-continued-task/(.*)$': '<rootDir>/src/$1',
  },
};
