import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG_YAML } from './config.ts';
import { openDb } from './db.ts';
import { PROFILE_FOLDERS, type Paths } from './paths.ts';
import { isOwnerOnly, restrictToOwner } from './secure.ts';

// Creates whatever is missing in the Offerstar folder and never overwrites
// existing files. Returns the paths it created.
export async function initHome(paths: Paths): Promise<string[]> {
  const created: string[] = [];

  const dirs = [paths.home, paths.profile, paths.applications, paths.resumes, ...Object.values(PROFILE_FOLDERS).map((f) => join(paths.profile, f))];
  for (const dir of dirs) {
    if (await mkdir(dir, { recursive: true })) created.push(dir);
  }

  try {
    await writeFile(paths.config, DEFAULT_CONFIG_YAML, { flag: 'wx' });
    created.push(paths.config);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const existed = existsSync(paths.db);
  openDb(paths.db).close();
  if (!existed) created.push(paths.db);

  if (existsSync(paths.env) && !(await isOwnerOnly(paths.env))) await restrictToOwner(paths.env);

  return created;
}
