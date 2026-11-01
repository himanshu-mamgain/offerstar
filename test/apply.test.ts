import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveApplication, NeedsApproval, renderApplication } from '../src/apply/application.ts';
import { auditDraft, DraftSchema, draftResume } from '../src/apply/draft.ts';
import { ConfigSchema } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { initHome } from '../src/home.ts';
import { storeJobs } from '../src/jobs/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { EvidenceBlockSchema, loadProfile, removeBlock, writeBlock, type EvidenceBlockInput, type Profile } from '../src/profile.ts';
import { ensureTypst } from '../src/resume/typst.ts';
import { tempPaths } from './helpers.ts';

const config = ConfigSchema.parse({
  version: 1,
  role: 'Backend engineer',
  noticePeriodDays: 30,
  contact: { name: 'Asha Verma', email: 'asha@example.com', phone: '+91 98765 43210' },
});

const blocks = [
  { id: 'exp-acme', type: 'experience', title: 'Software Engineer', organization: 'Acme Payments', start: '2023-04', end: 'present', highlights: ['Built the refunds API in Node.js', 'Served 1,200 merchants'], skills: ['node.js', 'postgresql'], verified: 'self', updated: '2026-11-01' },
  { id: 'edu-btech', type: 'education', title: 'B.Tech, Computer Science', organization: 'Example Institute', start: '2019-08', end: '2023-05', verified: 'self', updated: '2026-11-01' },
] satisfies EvidenceBlockInput[];

const profile: Profile = { blocks: blocks.map((b) => EvidenceBlockSchema.parse(b)), problems: [], hash: 'h1' };

const draft = (d: object) =>
  DraftSchema.parse({
    jobId: 1,
    items: [{ blockId: 'exp-acme', bullets: [{ text: 'Built a refunds API in Node.js for 1200 merchants', cites: ['exp-acme'] }] }],
    ...d,
  });

test('audit accepts reworded, cited, number-faithful lines', () => {
  assert.deepEqual(auditDraft(draft({ skills: ['NodeJS', 'Postgres'], answers: [{ question: 'Notice?', answer: '30 days', fromConfig: ['noticePeriodDays'] }] }), profile, config), []);
});

test('audit rejects invented numbers, skills, citations and answers', () => {
  const problems = auditDraft(
    draft({
      summary: { text: 'Engineer with 5 years of experience', cites: ['exp-acme'] },
      items: [
        { blockId: 'exp-acme', bullets: [{ text: 'Cut costs by 30%', cites: ['exp-acme'] }, { text: 'Led a team', cites: ['edu-btech'] }] },
        { blockId: 'exp-ghost', bullets: [{ text: 'x', cites: ['exp-ghost'] }] },
      ],
      skills: ['kubernetes'],
      answers: [
        { question: 'Expected CTC?', answer: '20 LPA', fromConfig: ['expectedCtcLpa'] },
        { question: 'Relocate?', answer: 'Yes' },
      ],
    }),
    profile,
    config,
  );
  assert.deepEqual(problems, [
    'summary: the number 5 is not in exp-acme',
    'exp-acme bullet 1: the number 30 is not in exp-acme',
    'exp-acme bullet 2: must cite exp-acme, the block it sits under',
    'item 2: no evidence block exp-ghost',
    'skill "kubernetes" is not in any evidence block',
    'answer 1 ("Expected CTC?"): config.yaml has no expectedCtcLpa',
    'answer 1 ("Expected CTC?"): the number 20 is not in expectedCtcLpa',
    'answer 2 ("Relocate?"): cite an evidence block or a config.yaml field; otherwise leave it for the user',
  ]);
});

test('draftResume uses the draft wording and only the chosen blocks', () => {
  const data = draftResume(draft({ summary: { text: 'Backend engineer', cites: ['exp-acme'] }, skills: ['Node.js'] }), profile, config);
  assert.equal(data.summary, 'Backend engineer');
  assert.deepEqual(data.sections.map((s) => s.heading), ['Experience']);
  assert.deepEqual(data.sections[0]!.items[0]!.bullets, ['Built a refunds API in Node.js for 1200 merchants']);
  assert.deepEqual(data.skills, ['Node.js']);
});

test('profile add and remove', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  await writeBlock(paths.profile, blocks[1]!);
  assert.equal((await loadProfile(paths.profile)).blocks.length, 1);
  assert.equal(await removeBlock(paths.profile, 'edu-btech'), true);
  assert.equal(await removeBlock(paths.profile, 'edu-btech'), false);
});

test('render, then approval only through a person; decline keeps it a draft', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  paths.bin = resolvePaths(join(tmpdir(), 'offerstar-test-typst')).bin;
  await ensureTypst(paths);
  for (const b of blocks) await writeBlock(paths.profile, b);
  const prof = await loadProfile(paths.profile);

  const db = openDb(paths.db);
  storeJobs(db, { companyId: null, companyName: 'Fintech Co', source: 'paste' }, [
    { sourceId: 'p1', title: 'Backend Engineer', location: 'Bengaluru', url: 'https://example.com/jobs/1', postedAt: new Date().toISOString(), text: 'Node.js and PostgreSQL, 1-3 years.' },
  ]);
  db.close();

  const ok = await renderApplication(paths, config, prof, draft({ skills: ['Node.js'] }));
  assert.equal(ok.ok, true, ok.problems.join('\n'));
  assert.ok(existsSync(join(ok.folder!, 'resume.pdf')));
  assert.ok(existsSync(join(ok.folder!, 'draft.json')));

  await assert.rejects(approveApplication(paths, 1, undefined), NeedsApproval);
  assert.equal(await approveApplication(paths, 1, async () => false), 'declined');

  let shown: string[] = [];
  assert.equal(await approveApplication(paths, 1, async (view) => ((shown = view.answers.map((a) => a.question)), true)), 'applied');
  assert.deepEqual(shown, []);
  assert.ok(existsSync(join(ok.folder!, 'posting.txt')));
  await assert.rejects(approveApplication(paths, 1, async () => true), /already applied/);

  const again = await renderApplication(paths, config, prof, draft({}));
  assert.deepEqual(again.problems, ['job 1 is already applied; it cannot be redrafted']);

  const check = openDb(paths.db);
  const app = check.prepare('SELECT stage, applied_at, channel, role_match, skill_overlap FROM applications WHERE job_id = 1').get() as Record<string, unknown>;
  check.close();
  assert.equal(app.stage, 'applied');
  assert.ok(app.applied_at);
  assert.equal(app.channel, 'paste');
  assert.equal(app.role_match, 'strong');
});

test('a resume that fails the parse test cannot be approved', async () => {
  const paths = await tempPaths();
  await initHome(paths);
  const db = openDb(paths.db);
  storeJobs(db, { companyId: null, companyName: 'X', source: 'paste' }, [{ sourceId: 'p', title: 'Dev', text: 'Node.js' }]);
  db.prepare("INSERT INTO applications (job_id, stage, channel, folder, check_ok) VALUES (1, 'drafted', 'paste', ?, 0)").run(paths.applications);
  db.close();
  await writeFile(join(paths.applications, 'draft.json'), '{}');
  await assert.rejects(approveApplication(paths, 1, async () => true), /did not pass offerstar check/);
});
