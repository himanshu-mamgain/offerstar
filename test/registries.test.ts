import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importAppStore, importCredly, importDocker, importMaven, importPypi } from '../src/importers/registries.ts';
import { EvidenceBlockSchema } from '../src/profile.ts';
import { selfCommand } from '../src/runtime.ts';

const routes = (table: Record<string, unknown>) =>
  (async (url: string | URL | Request) => {
    const key = Object.keys(table).find((k) => String(url).includes(k));
    return key ? Response.json(table[key]) : new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;

const valid = (blocks: unknown[]) => blocks.forEach((b) => EvidenceBlockSchema.parse(b));

test('pypi: named packages, with the source repo as extra evidence', async () => {
  const blocks = await importPypi(['Flask'], {
    fetch: routes({ 'pypi/Flask/json': { info: { name: 'Flask', summary: 'A web framework.', keywords: 'wsgi, web', project_urls: { Source: 'https://github.com/pallets/flask/' } } } }),
  });
  valid(blocks);
  assert.equal(blocks[0]!.id, 'pypi-flask');
  assert.deepEqual(blocks[0]!.skills, ['python', 'wsgi', 'web']);
  assert.deepEqual(blocks[0]!.evidence?.map((e) => e.kind), ['package', 'repo']);
  await assert.rejects(importPypi(['nope'], { fetch: routes({}) }), /pypi.org answered 404/);
});

test('maven, app store and docker hub', async () => {
  const maven = await importMaven('com.example', { fetch: routes({ 'g:com.example': { response: { docs: [{ g: 'com.example', a: 'http-kit', latestVersion: '1.0' }] } } }) });
  const apps = await importAppStore('42', {
    fetch: routes({ 'lookup?id=42': { results: [{ wrapperType: 'artist' }, { wrapperType: 'software', trackName: 'Budget Buddy', trackViewUrl: 'https://apps.apple.com/app/id1', description: 'Track spending. Lots more.' }] } }),
  });
  const docker = await importDocker('asha', { fetch: routes({ 'repositories/asha/': { results: [{ name: 'api', namespace: 'asha', description: 'API image' }] } }) });
  valid([...maven, ...apps, ...docker]);
  assert.equal(maven[0]!.title, 'com.example:http-kit');
  assert.deepEqual(apps.map((a) => [a.id, a.summary]), [['app-budget-buddy', 'Track spending.']]);
  assert.equal(docker[0]!.evidence![0]!.url, 'https://hub.docker.com/r/asha/api');
});

test('credly: issuer-signed certification blocks with dates', async () => {
  const blocks = await importCredly('asha', {
    fetch: routes({
      'users/asha/badges.json': {
        data: [{ id: 'b1', issued_at_date: '2025-03-14', expires_at_date: '2028-03-14', badge_template: { name: 'AWS Certified Developer', skills: [{ name: 'AWS' }] }, issuer: { entities: [{ entity: { name: 'Amazon Web Services' } }] } }],
      },
    }),
  });
  valid(blocks);
  assert.deepEqual(
    { ...blocks[0], updated: undefined },
    {
      id: 'cert-aws-certified-developer',
      type: 'certification',
      title: 'AWS Certified Developer',
      organization: 'Amazon Web Services',
      start: '2025-03',
      end: '2028-03',
      skills: ['aws'],
      evidence: [{ kind: 'certificate', url: 'https://www.credly.com/badges/b1' }],
      verified: 'issuer-signed',
      updated: undefined,
    },
  );
});

test('from source, offerstar runs itself through node and bin/offerstar.js', () => {
  const [node, cli] = selfCommand();
  assert.equal(node, process.execPath);
  assert.match(cli!, /bin[\\/]offerstar\.js$/);
});
