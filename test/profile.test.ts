import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { initHome } from '../src/home.ts';
import { loadProfile } from '../src/profile.ts';
import { tempPaths } from './helpers.ts';

// A fictional profile; the repo never holds real personal data.
const block = `id: proj-taskboard
type: project
title: Taskboard, a kanban app
summary: Open-source kanban board with real-time sync
skills: [typescript, node.js, websockets]
evidence:
  - kind: repo
    url: https://github.com/example/taskboard
verified: linked
metrics: []
updated: 2026-11-01
`;

test('loads valid blocks and hashes the profile', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeFile(join(paths.profile, 'projects', 'taskboard.yaml'), block);

  const profile = await loadProfile(paths.profile);
  assert.deepEqual(profile.problems, []);
  assert.equal(profile.blocks.length, 1);
  assert.equal(profile.blocks[0]!.id, 'proj-taskboard');
  assert.match(profile.hash, /^[0-9a-f]{16}$/);
});

test('the profile hash changes when a block changes', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  const file = join(paths.profile, 'projects', 'taskboard.yaml');
  await writeFile(file, block);
  const before = (await loadProfile(paths.profile)).hash;

  await writeFile(file, block.replace('real-time sync', 'offline sync'));
  assert.notEqual((await loadProfile(paths.profile)).hash, before);
});

test('rejects a linked claim with no evidence', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeFile(join(paths.profile, 'projects', 'taskboard.yaml'), block.replace(/evidence:\n(.*\n){2}/, 'evidence: []\n'));

  const { blocks, problems } = await loadProfile(paths.profile);
  assert.equal(blocks.length, 0);
  assert.match(problems[0]!.message, /needs at least one evidence link/);
});

test('rejects a block in the wrong folder and duplicate ids', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeFile(join(paths.profile, 'skills', 'taskboard.yaml'), block);
  await writeFile(join(paths.profile, 'projects', 'a.yaml'), block);
  await writeFile(join(paths.profile, 'projects', 'b.yaml'), block);

  const { blocks, problems } = await loadProfile(paths.profile);
  assert.equal(blocks.length, 1);
  assert.deepEqual(
    problems.map((p) => p.file),
    ['projects/b.yaml', 'skills/taskboard.yaml'],
  );
});
