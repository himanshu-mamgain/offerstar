// Entry point for the bundle and the single executable. Hides only Node's
// "experimental feature" warnings (SQLite, SEA), then loads the CLI, so the
// filter is in place before node:sqlite is first imported.
const [print] = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') print?.(warning);
});

await import('./cli.ts');
