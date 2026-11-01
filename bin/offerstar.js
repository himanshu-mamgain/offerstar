#!/usr/bin/env node
// Entry point for `npm link` and the npm package: hides only Node's
// "SQLite is experimental" warning, then runs the CLI.
const [print] = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') print?.(warning);
});
await import('../src/cli.ts');
