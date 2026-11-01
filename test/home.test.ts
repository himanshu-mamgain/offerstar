import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { initHome } from '../src/home.ts';
import { aclPrincipals, isOwnerOnly } from '../src/secure.ts';
import { tempPaths } from './helpers.ts';

test('init creates the folder layout, config and database', async () => {
  const paths = await tempPaths();
  const created = await initHome(paths);

  assert.ok(created.includes(paths.config));
  assert.ok(created.includes(paths.db));
  assert.ok(created.includes(join(paths.profile, 'projects')));
  const config = await loadConfig(paths.config);
  assert.equal(config.version, 1);
  assert.equal(config.schedule.morning, '08:30');
});

test('init is safe to run again and keeps edited files', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeFile(paths.config, 'version: 1\nrole: "Backend engineer"\n');

  assert.deepEqual(await initHome(paths), []);
  assert.match(await readFile(paths.config, 'utf8'), /Backend engineer/);
});

test('init locks an existing .env to the current user', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeFile(paths.env, 'USERNAME=me@example.com\n', { mode: 0o644 });

  await initHome(paths);
  assert.equal(await isOwnerOnly(paths.env), true, process.platform === 'win32' ? `access list: ${aclPrincipals(paths.env).join(', ')}` : undefined);
});
