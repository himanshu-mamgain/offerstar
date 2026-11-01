import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConfigSchema } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { initHome } from '../src/home.ts';
import { planShortlist } from '../src/jobs/score.ts';
import { saveCompany } from '../src/jobs/companies.ts';
import { storeJobs } from '../src/jobs/store.ts';
import {
  approveProposals,
  learnedAdjustment,
  learnGroups,
  prepList,
  progress,
  propose,
  readLearned,
  saveProposals,
  startAngleTest,
  suggestAngle,
  writeLearnings,
} from '../src/learn/learn.ts';
import { EvidenceBlockSchema, type Profile } from '../src/profile.ts';
import { tempPaths } from './helpers.ts';

async function setup() {
  const paths = await tempPaths();
  await initHome(paths);
  return { paths, db: openDb(paths.db) };
}

let next = 0;
// Adds sent applications with the given features; `calls` of them got a call.
function addApplications(db: DatabaseSync, n: number, calls: number, f: { company?: string; channel?: string; role_match?: string; days?: number; angle?: string } = {}) {
  for (let i = 0; i < n; i++) {
    const id = `j${next++}`;
    storeJobs(db, { companyId: null, companyName: f.company ?? 'Acme', source: f.channel ?? 'greenhouse' }, [{ sourceId: id, title: `Engineer ${id}`, location: `City ${id}`, text: 'Node.js' }]);
    const job = db.prepare('SELECT id FROM jobs WHERE source_id = ?').get(id) as { id: number };
    db.prepare("INSERT INTO applications (job_id, stage, channel, role_match, days_since_posting, resume_angle, applied_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))").run(
      job.id,
      i < calls ? 'call' : 'applied',
      f.channel ?? 'greenhouse',
      f.role_match ?? 'partial',
      f.days ?? 10,
      f.angle ?? null,
      `+${next} seconds`,
    );
  }
}

test('small groups are pulled toward the overall rate', async () => {
  const { db } = await setup();
  addApplications(db, 20, 4);
  addApplications(db, 3, 2, { channel: 'lever' });
  const { base, groups } = learnGroups(db);
  const lever = groups.find((g) => g.dimension === 'channel' && g.value === 'lever')!;
  assert.equal(base.applied, 23);
  assert.ok(Math.abs(lever.rate - 2 / 3) < 1e-9);
  assert.ok(lever.smoothed < lever.rate - 0.2, `smoothed ${lever.smoothed} should be far below 67%`);
  assert.ok(lever.smoothed > base.rate);
  assert.deepEqual(propose(db).proposals, [], 'three applications are not enough to act on');
  db.close();
});

test('proposals: rank up a strong group, rank down a weak one, drop a silent company', async () => {
  const { db } = await setup();
  saveCompany(db, { name: 'Silent Co', ats: 'lever', token: 'silent', openJobs: 0 });
  addApplications(db, 12, 6, { days: 2 });
  addApplications(db, 20, 1, { days: 20 });
  addApplications(db, 6, 0, { company: 'Silent Co', days: 9 });

  const ids = propose(db).proposals.map((p) => p.id);
  assert.ok(ids.includes('rank:posting_age=0-3 days'), ids.join());
  assert.ok(ids.includes('rank:posting_age=15+ days'), ids.join());
  assert.ok(ids.includes('drop:Silent Co'), ids.join());
  db.close();
});

test('an angle wins only when its likely range clears the others', async () => {
  const { db } = await setup();
  addApplications(db, 12, 4, { angle: 'backend' });
  addApplications(db, 12, 3, { angle: 'payments' });
  assert.equal(propose(db).proposals.some((p) => p.kind === 'keep-angle'), false);

  addApplications(db, 30, 24, { angle: 'backend' });
  addApplications(db, 30, 2, { angle: 'payments' });
  assert.ok(propose(db).proposals.some((p) => p.id === 'angle:backend'));
  db.close();
});

test('only a person can adopt proposals; adopted lessons re-rank jobs and drop companies', async () => {
  const { paths, db } = await setup();
  saveCompany(db, { name: 'Silent Co', ats: 'lever', token: 'silent', openJobs: 0 });
  addApplications(db, 12, 6, { days: 2 });
  addApplications(db, 20, 1, { days: 20 });
  addApplications(db, 6, 0, { company: 'Silent Co' });
  await saveProposals(paths, propose(db).proposals);

  await assert.rejects(approveProposals(paths, db, undefined), /needs you at a terminal/);
  const adopted = await approveProposals(paths, db, async (p) => p.id !== 'rank:posting_age=15+ days');
  assert.ok(adopted.some((p) => p.id === 'drop:Silent Co'));
  assert.equal((db.prepare("SELECT ats FROM companies WHERE name = 'Silent Co'").get() as { ats: string | null }).ats, null);

  const learned = await readLearned(paths);
  assert.deepEqual(learned.adjustments.map((a) => `${a.dimension}=${a.value}`), ['posting_age=0-3 days']);

  const config = ConfigSchema.parse({ version: 1, role: 'Node.js engineer' });
  const fresh = learnedAdjustment(learned, { role_match: 'strong', seniority_match: null, company_type: null, skill_overlap: 1, days_since_posting: 1, location: null, channel: 'lever' });
  assert.ok(fresh.factor > 1);
  assert.match(fresh.reasons[0]!, /applying "0-3 days": calls from 6 of 12/);

  storeJobs(db, { companyId: null, companyName: 'New Co', source: 'paste' }, [
    { sourceId: 'old', title: 'Node.js Engineer', location: 'Pune', text: 'Node.js', postedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
    { sourceId: 'new', title: 'Node.js Engineer', location: 'Chennai', text: 'Node.js', postedAt: new Date().toISOString() },
  ]);
  const profile: Profile = { blocks: [EvidenceBlockSchema.parse({ id: 'p', type: 'project', title: 'P', skills: ['node.js'], verified: 'self', updated: '2026-11-01' })], problems: [], hash: 'h' };
  const top = planShortlist(db, config, profile, { learned, limit: 50 }).filter((s) => s.job.company_name === 'New Co');
  assert.equal(top[0]!.job.posted_at !== null && Date.now() - Date.parse(top[0]!.job.posted_at) < 86_400_000, true);
  assert.equal(top[0]!.learned.length, 1);
  db.close();
});

test('an angle test alternates angles among similar jobs, until one is adopted', async () => {
  const { paths, db } = await setup();
  await assert.rejects(startAngleTest(paths, ['backend']), /at least two/);
  await startAngleTest(paths, ['backend', 'payments']);
  let learned = await readLearned(paths);
  addApplications(db, 2, 0, { angle: 'backend', role_match: 'strong' });
  addApplications(db, 1, 0, { angle: 'payments', role_match: 'strong' });
  assert.equal(suggestAngle(db, learned, 'strong'), 'payments');
  addApplications(db, 2, 0, { angle: 'payments', role_match: 'strong' });
  assert.equal(suggestAngle(db, learned, 'strong'), 'backend');
  learned = { ...learned, preferredAngle: 'payments' };
  assert.equal(suggestAngle(db, learned, 'strong'), 'payments');
  assert.equal(suggestAngle(db, { adjustments: [] }, 'strong'), undefined);
  db.close();
});

test('progress compares the first 30 applications with everything since', async () => {
  const { db } = await setup();
  addApplications(db, 30, 3);
  addApplications(db, 15, 6);
  const p = progress(db);
  assert.deepEqual([p.first.applied, p.first.calls, p.since.applied, p.since.calls], [30, 3, 15, 6]);
  db.close();
});

test('prep lists repeated questions and low-rated rounds', async () => {
  const { db } = await setup();
  addApplications(db, 2, 2);
  const round = db.prepare('INSERT INTO interviews (application_id, held_on, round_type, questions, rating) VALUES (?, ?, ?, ?, ?)');
  round.run(1, '2026-11-01', 'technical 1', JSON.stringify(['Explain the event loop?', 'Design a URL shortener']), 2);
  round.run(2, '2026-11-03', 'technical 1', JSON.stringify(['explain the event loop']), 4);
  const list = prepList(db);
  // Grouped despite case and punctuation; the most recent wording is kept.
  assert.deepEqual(list.repeated, [{ question: 'explain the event loop', count: 2 }]);
  assert.deepEqual(list.lowRated.map((r) => [r.round, r.rating]), [['technical 1', 2]]);
  db.close();
});

test('learnings.md keeps the retro notes and replaces only the numbers', async () => {
  const { paths, db } = await setup();
  db.close();
  await writeLearnings(paths, '## Numbers\n- Sent: 1');
  await writeFile(paths.learnings, `${await readFile(paths.learnings, 'utf8')}\n## Retro, week 1\nFintech roles answer faster.\n`);
  await writeLearnings(paths, '## Numbers\n- Sent: 9');
  const text = await readFile(paths.learnings, 'utf8');
  assert.match(text, /Sent: 9/);
  assert.doesNotMatch(text, /Sent: 1\n/);
  assert.match(text, /Fintech roles answer faster/);
});
