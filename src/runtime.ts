import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offerstar runs three ways: from source (npm link), as the bundled npm
// package, and as a single executable (SEA) with files embedded as assets.
const require = createRequire(import.meta.url);
const sea = require('node:sea') as { isSea(): boolean; getAsset(key: string, encoding: string): string };

export const isSea = (): boolean => sea.isSea();

// The folder holding package.json: the repo, or the installed npm package.
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('could not find the offerstar package folder');
    dir = up;
  }
  return dir;
}

// A file shipped with Offerstar, e.g. "addons/naukri/bridge.py".
export async function packageFile(path: string): Promise<string> {
  return isSea() ? sea.getAsset(path, 'utf8') : readFile(join(packageRoot(), path), 'utf8');
}

// The command that runs this same Offerstar: the executable itself, or
// node plus the CLI entry point.
export function selfCommand(): string[] {
  return isSea() ? [process.execPath] : [process.execPath, join(packageRoot(), 'bin', 'offerstar.js')];
}
