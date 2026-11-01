import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigSchema, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { initHome } from '../src/home.ts';
import { resolvePaths } from '../src/paths.ts';
import { EvidenceBlockSchema, loadProfile, type EvidenceBlock } from '../src/profile.ts';
import { buildResume } from '../src/resume/build.ts';
import { checkResume } from '../src/resume/check.ts';
import { formatDates, resumeData } from '../src/resume/data.ts';
import { ensureTypst } from '../src/resume/typst.ts';
import { tempPaths } from './helpers.ts';

const config: Config = ConfigSchema.parse({
  version: 1,
  contact: { name: 'Asha Verma', email: 'asha@example.com', phone: '+91 98765 43210', location: 'Bengaluru' },
});

const block = (b: object): EvidenceBlock => EvidenceBlockSchema.parse({ verified: 'self', updated: '2026-11-01', ...b });

const blocks = [
  block({ id: 'exp-old', type: 'experience', title: 'Intern', organization: 'Startup', start: '2022-01', end: '2022-06' }),
  block({
    id: 'exp-acme',
    type: 'experience',
    title: 'Software Engineer',
    organization: 'Acme Payments',
    start: '2023-04',
    end: 'present',
    highlights: ['Built the refunds API in Node.js and PostgreSQL', 'Cut refund processing time to minutes'],
  }),
  block({ id: 'proj-taskboard', type: 'project', title: 'Taskboard', summary: 'Open-source kanban board', skills: ['typescript'] }),
  block({ id: 'edu-btech', type: 'education', title: 'B.Tech, Computer Science', organization: 'Example Institute', start: '2018-08', end: '2022-05' }),
];

test('formatDates writes dates as text', () => {
  assert.equal(formatDates('2023-04', 'present'), 'Apr 2023 – Present');
  assert.equal(formatDates('2022-01', '2022-06'), 'Jan 2022 – Jun 2022');
  assert.equal(formatDates(undefined, '2022-05'), 'May 2022');
  assert.equal(formatDates(), '');
});

test('resumeData orders sections and items and keeps each bullet tied to its block', () => {
  const data = resumeData(config, blocks);

  assert.deepEqual(data.sections.map((s) => s.heading), ['Experience', 'Projects', 'Education']);
  assert.deepEqual(data.sections[0]!.items.map((i) => i.blockId), ['exp-acme', 'exp-old']);
  assert.equal(data.sections[0]!.items[0]!.title, 'Software Engineer, Acme Payments');
  assert.deepEqual(data.sections[1]!.items[0]!.bullets, ['Open-source kanban board']);
  assert.deepEqual(data.contact.details, ['asha@example.com', '+91 98765 43210', 'Bengaluru']);
});

test('resumeData uses only the chosen blocks and rejects unknown ids', () => {
  const data = resumeData(config, blocks, ['edu-btech', 'exp-acme']);
  assert.deepEqual(data.sections.flatMap((s) => s.items.map((i) => i.blockId)), ['exp-acme', 'edu-btech']);
  assert.throws(() => resumeData(config, blocks, ['exp-missing']), /no evidence block with id exp-missing/);
  assert.throws(() => resumeData(ConfigSchema.parse({ version: 1 }), blocks), /contact.name/);
});

test('check fails a PDF with no text layer', async () => {
  // A one-page PDF with no text at all, as a scanned resume would look to an ATS.
  const empty = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
  const report = await checkResume(new Uint8Array(empty), { config });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === 'text')?.status, 'fail');
});

// Builds a real PDF with Typst, downloading it once into a shared cache.
test('a resume built from blocks passes check, and the version is recorded', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  const cache = resolvePaths(join(tmpdir(), 'offerstar-test-typst'));
  const typst = await ensureTypst(cache);
  paths.bin = cache.bin;

  for (const b of blocks) {
    const folder = { experience: 'experience', project: 'projects', education: 'education' }[b.type as 'experience' | 'project' | 'education'];
    await writeFile(join(paths.profile, folder, `${b.id}.yaml`), JSON.stringify(b));
  }
  const profile = await loadProfile(paths.profile);
  assert.deepEqual(profile.problems, []);
  assert.ok(typst);

  const built = await buildResume(paths, config, profile);
  const report = await checkResume(new Uint8Array(await readFile(built.path)), { config, blocks: profile.blocks, keywords: ['Node.js', 'Kubernetes'] });

  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.deepEqual(report.fields?.missing, []);
  assert.deepEqual(report.keywords, { covered: ['Node.js'], missing: ['Kubernetes'] });

  const db = openDb(paths.db);
  const row = db.prepare('SELECT profile_hash, block_ids FROM resume_versions WHERE file_hash = ?').get(built.fileHash) as { profile_hash: string; block_ids: string };
  db.close();
  assert.equal(row.profile_hash, profile.hash);
  assert.deepEqual(JSON.parse(row.block_ids), ['exp-acme', 'exp-old', 'proj-taskboard', 'edu-btech']);
});
