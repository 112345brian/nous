module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      // Node build/seed scripts run under Node, not React Native.
      files: ['scripts/**/*.js'],
      env: { node: true },
    },
    {
      // Hermes standalone spike scripts run under the `hermes` CLI, which provides `print`.
      files: ['scripts/hermes-spike/**/*.js'],
      globals: { print: 'readonly', performance: 'readonly', globalThis: 'readonly' },
    },
  ],
};
