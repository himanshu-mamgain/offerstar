import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadConfig, updateConfig } from '../src/config.ts';
import { initHome } from '../src/home.ts';
import { tempPaths } from './helpers.ts';

test('updateConfig sets values and keeps the comments', async () => {
  const paths = await tempPaths();
  await initHome(paths);

  await updateConfig(paths.config, [
    [['role'], 'Backend engineer'],
    [['contact', 'email'], 'asha@example.com'],
  ]);

  const text = await readFile(paths.config, 'utf8');
  assert.match(text, /# Printed at the top of every resume/);
  const config = await loadConfig(paths.config);
  assert.equal(config.role, 'Backend engineer');
  assert.equal(config.contact.email, 'asha@example.com');
});

test('updateConfig refuses an invalid value and leaves the file alone', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  const before = await readFile(paths.config, 'utf8');

  await assert.rejects(updateConfig(paths.config, [[['contact', 'email'], 'not-an-email']]));
  assert.equal(await readFile(paths.config, 'utf8'), before);
});

test('a config from an older version, without contact, still loads', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await (await import('node:fs/promises')).writeFile(paths.config, 'version: 1\nrole: "QA engineer"\n');

  const config = await loadConfig(paths.config);
  assert.equal(config.contact.name, '');
  assert.equal(config.resume.paper, 'a4');
});
