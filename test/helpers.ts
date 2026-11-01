import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { resolvePaths, type Paths } from '../src/paths.ts';

// A fresh Offerstar home in the temp folder, removed after the test file.
export async function tempPaths(): Promise<Paths> {
  const home = await mkdtemp(join(tmpdir(), 'offerstar-test-'));
  after(() => rm(home, { recursive: true, force: true }));
  return resolvePaths(home);
}
