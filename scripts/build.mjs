// Builds Offerstar for release.
//   node scripts/build.mjs          bundle src/ into dist/offerstar.mjs
//   node scripts/build.mjs sea      also build the single executable for this
//                                   OS with Node's --build-sea (Node 25.5+)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const exe = process.platform === 'win32' ? 'dist/offerstar.exe' : 'dist/offerstar';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/offerstar.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.18',
  // Bundled CommonJS dependencies call require(); give them one.
  banner: {
    js: "import { createRequire as __offerstarRequire } from 'node:module'; if (typeof globalThis.require === 'undefined') globalThis.require = __offerstarRequire(import.meta.url);",
  },
  legalComments: 'linked',
  logLevel: 'info',
});

if (process.argv[2] === 'sea') {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 25 || (major === 25 && minor < 5)) throw new Error(`--build-sea needs Node 25.5 or newer; this is ${process.version}`);
  mkdirSync('dist', { recursive: true });
  writeFileSync(
    'dist/sea-config.json',
    JSON.stringify(
      {
        main: 'dist/offerstar.mjs',
        mainFormat: 'module',
        output: exe,
        disableExperimentalSEAWarning: true,
        // Files that are read at runtime, embedded in the executable.
        assets: { 'addons/naukri/bridge.py': 'addons/naukri/bridge.py' },
      },
      null,
      2,
    ),
  );
  execFileSync(process.execPath, ['--build-sea', 'dist/sea-config.json'], { stdio: 'inherit' });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
  console.log(`built ${exe}`);
}
