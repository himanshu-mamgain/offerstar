import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { initHome } from '../src/home.ts';
import { importGithub } from '../src/importers/github.ts';
import { importNpm } from '../src/importers/npm.ts';
import { loadProfile, writeBlock } from '../src/profile.ts';
import { tempPaths } from './helpers.ts';

const fakeFetch = (pages: Record<string, unknown>) =>
  (async (url: string | URL | Request) => {
    const key = Object.keys(pages).find((k) => String(url).endsWith(k) || String(url).includes(`${k}&`));
    return key ? Response.json(pages[key]) : new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;

const repo = (name: string, extra: object = {}) => ({
  name,
  description: `${name} description`,
  html_url: `https://github.com/example/${name}`,
  homepage: null,
  language: 'TypeScript',
  topics: ['cli'],
  fork: false,
  archived: false,
  ...extra,
});

test('github: one linked project block per owned repo, forks and archives skipped', async () => {
  const blocks = await importGithub('example', {
    fetch: fakeFetch({
      'page=1': [repo('Taskboard', { homepage: 'https://taskboard.example.com' }), repo('fork', { fork: true }), repo('old', { archived: true })],
    }),
  });

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    id: 'gh-taskboard',
    type: 'project',
    title: 'Taskboard',
    summary: 'Taskboard description',
    skills: ['typescript', 'cli'],
    evidence: [
      { kind: 'repo', url: 'https://github.com/example/Taskboard' },
      { kind: 'link', url: 'https://taskboard.example.com' },
    ],
    verified: 'linked',
    updated: blocks[0]!.updated,
  });
});

test('github: follows pages and reports API errors', async () => {
  const full = Array.from({ length: 100 }, (_, i) => repo(`r${i}`));
  const blocks = await importGithub('example', { fetch: fakeFetch({ 'page=1': full, 'page=2': [repo('last')] }) });
  assert.equal(blocks.length, 101);

  await assert.rejects(importGithub('nobody', { fetch: fakeFetch({}) }), /api.github.com answered 404/);
});

test('npm: package blocks with package and repo evidence', async () => {
  const blocks = await importNpm('example', {
    fetch: fakeFetch({
      'maintainer:example': {
        objects: [
          {
            package: {
              name: '@example/diagrams',
              description: 'Render diagrams',
              keywords: ['mcp', 'mermaid'],
              links: { npm: 'https://www.npmjs.com/package/@example/diagrams', repository: 'https://github.com/example/diagrams' },
            },
          },
        ],
      },
    }),
  });

  assert.equal(blocks[0]!.id, 'npm-example-diagrams');
  assert.deepEqual(blocks[0]!.skills, ['npm', 'mcp', 'mermaid']);
  assert.equal(blocks[0]!.evidence?.length, 2);
});

test('imported blocks are valid and never overwrite an edited file', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  const [block] = await importGithub('example', { fetch: fakeFetch({ 'page=1': [repo('taskboard')] }) });

  const path = await writeBlock(paths.profile, block!);
  assert.equal(path, join(paths.profile, 'projects', 'gh-taskboard.yaml'));
  const edited = (await readFile(path!, 'utf8')).replace('taskboard description', 'my own words');
  await (await import('node:fs/promises')).writeFile(path!, edited);

  assert.equal(await writeBlock(paths.profile, block!), undefined);
  assert.match(await readFile(path!, 'utf8'), /my own words/);
  assert.deepEqual((await loadProfile(paths.profile)).problems, []);
});
