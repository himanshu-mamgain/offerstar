import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runDoctor } from '../src/doctor.ts';
import { initHome } from '../src/home.ts';
import { resolvePaths } from '../src/paths.ts';
import { tempPaths } from './helpers.ts';

const status = (report: Awaited<ReturnType<typeof runDoctor>>, id: string) => report.checks.find((c) => c.id === id)?.status;

test('fails before init and points to it', async () => {
  const paths = resolvePaths(`${(await tempPaths()).home}-missing`);

  const report = await runDoctor(paths);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === 'home')?.fix, 'run offerstar init');
});

test('passes after init, warning about the empty role and profile', async () => {
  const paths = await tempPaths();
  await initHome(paths);

  const report = await runDoctor(paths);
  assert.equal(report.ok, true);
  assert.equal(status(report, 'database'), 'ok');
  assert.equal(status(report, 'config'), 'warn');
  assert.equal(status(report, 'profile'), 'warn');
  assert.equal(status(report, 'secrets'), 'skip');
});

test('fails on an invalid config', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeFile(paths.config, 'version: 1\nschedule:\n  morning: "8.30am"\n');

  const report = await runDoctor(paths);
  assert.equal(report.ok, false);
  assert.equal(status(report, 'config'), 'fail');
});
