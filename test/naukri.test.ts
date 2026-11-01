import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigSchema } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { initHome } from '../src/home.ts';
import { readEnv, writeEnv, type BridgeRunner } from '../src/naukri/addon.ts';
import {
  approveVariants,
  isApproved,
  naukriSearch,
  naukriSearches,
  postedDate,
  readVariants,
  refreshProfile,
  setVariants,
  syncHistory,
  variantInsights,
} from '../src/naukri/naukri.ts';
import { EvidenceBlockSchema, type Profile } from '../src/profile.ts';
import { dailyScript } from '../src/schedule.ts';
import { isOwnerOnly } from '../src/secure.ts';
import { markNoReplies } from '../src/track/track.ts';
import { recordOutcome } from '../src/track/tracker.ts';
import { tempPaths } from './helpers.ts';

const config = ConfigSchema.parse({ version: 1, role: 'Node.js developer', locations: ['Remote', 'Pune'], experienceYears: 3, naukri: { enabled: true } });
const profile: Profile = {
  blocks: [EvidenceBlockSchema.parse({ id: 'exp-acme', type: 'experience', title: 'Software Engineer', organization: 'Acme', highlights: ['Built the refunds API in Node.js'], skills: ['node.js'], verified: 'self', updated: '2026-11-01' })],
  problems: [],
  hash: 'h',
};

// A stand-in for the Python bridge that records what it was asked.
function fakeBridge(answers: Record<string, unknown>) {
  const calls: [string, unknown][] = [];
  const run: BridgeRunner = async (command, payload) => {
    calls.push([command, payload]);
    if (!(command in answers)) throw new Error(`unexpected ${command}`);
    return answers[command];
  };
  return { run, calls };
}

async function setup() {
  const paths = await tempPaths();
  await initHome(paths);
  return { paths, db: openDb(paths.db) };
}

const variants = {
  variants: [
    { name: 'backend', headline: { text: 'Node.js engineer building refunds APIs', cites: ['exp-acme'] } },
    { name: 'payments', headline: { text: 'Payments engineer at Acme', cites: ['exp-acme'] } },
  ],
};

test('posted labels become dates', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(postedDate('Just now', now), '2026-11-10T00:00:00.000Z');
  assert.equal(postedDate('3 Days Ago', now), '2026-11-07T00:00:00.000Z');
  assert.equal(postedDate('30+ Days Ago', now), '2026-10-11T00:00:00.000Z');
  assert.equal(postedDate('N/A', now), undefined);
});

test('default search uses the role and the first non-remote city', () => {
  assert.deepEqual(naukriSearches(config), [{ keyword: 'Node.js developer', location: 'Pune', experience: 3, jobAge: 7, pages: 1 }]);
});

test('search stores Naukri jobs through the posting guard', async () => {
  const { db } = await setup();
  const { run, calls } = fakeBridge({
    search: { jobs: [{ jobId: '123', title: 'Node.js Developer', company: 'Fintech Co', location: 'Pune', experience: '2-5 Yrs', posted: '2 Days Ago', url: 'https://www.naukri.com/job-listings-123', description: 'APIs <b>daily</b>', tags: ['Node.js', 'MongoDB'] }] },
  });
  const r = await naukriSearch(db, config, run);
  assert.equal(r.added, 1);
  assert.equal(calls[0]![0], 'search');
  const job = db.prepare("SELECT skills, experience_min, experience_max, company_name FROM jobs WHERE source = 'naukri'").get() as Record<string, unknown>;
  assert.deepEqual({ ...job }, { skills: '["node.js","mongodb"]', experience_min: 2, experience_max: 5, company_name: 'Fintech Co' });
  db.close();
});

test('variants are audited, approved only by a person, and voided by any edit', async () => {
  const { paths, db } = await setup();
  const bad = { variants: [{ name: 'x', headline: { text: 'Node.js engineer with 7 years', cites: ['exp-acme'] } }], resume: join(paths.home, 'config.yaml') };
  assert.deepEqual(await setVariants(paths, profile, db, bad), [
    'x headline: the number 7 is not in exp-acme',
    'the resume must be one built by offerstar resume build or apply render',
  ]);

  assert.deepEqual(await setVariants(paths, profile, db, variants), []);
  assert.equal(isApproved(await readVariants(paths)), false);
  await assert.rejects(approveVariants(paths, undefined), /needs you at a terminal/);
  assert.equal(await approveVariants(paths, async () => true), true);
  assert.equal(isApproved(await readVariants(paths)), true);

  const file = join(paths.home, 'naukri-variants.json');
  await writeFile(file, (await readFile(file, 'utf8')).replace('Payments engineer', 'Lead payments engineer'));
  assert.equal(isApproved(await readVariants(paths)), false);
  db.close();
});

test('refresh rotates approved variants at most every 3 days', async () => {
  const { paths, db } = await setup();
  const { run, calls } = fakeBridge({ refresh: { profile: 200 } });
  assert.equal((await refreshProfile(paths, config, db, run)).status, 'skipped');

  await setVariants(paths, profile, db, variants);
  await approveVariants(paths, async () => true);
  assert.deepEqual(await refreshProfile(paths, config, db, run), { status: 'refreshed', variant: 'backend' });
  const soon = await refreshProfile(paths, config, db, run, { now: Date.now() + 2 * 86_400_000 });
  assert.equal(soon.status, 'skipped');
  assert.deepEqual(await refreshProfile(paths, config, db, run, { now: Date.now() + 4 * 86_400_000 }), { status: 'refreshed', variant: 'payments' });
  assert.deepEqual(await refreshProfile(paths, config, db, run, { force: true }), { status: 'refreshed', variant: 'backend' });
  assert.deepEqual(calls[0], ['refresh', { headline: 'Node.js engineer building refunds APIs', summary: undefined, resume: undefined }]);

  const off = ConfigSchema.parse({ version: 1, naukri: { enabled: false } });
  assert.equal((await refreshProfile(paths, off, db, run, { force: true })).status, 'skipped');
  db.close();
});

test('history sync adds Naukri applications and maps statuses once', async () => {
  const { db } = await setup();
  const history = {
    applications: [
      { jobId: 'n1', title: 'Backend Developer', company: 'Acme', location: 'Pune', isOpen: true, statuses: [{ value: 'Applied', at: '2026-11-01' }, { value: 'Application Viewed', at: '2026-11-02' }] },
      { jobId: 'n2', title: 'SDE II', company: 'Beta', location: 'Pune', isOpen: true, statuses: [{ value: 'Shortlisted', at: '2026-11-03' }] },
    ],
  };
  const { run } = fakeBridge({ history });

  assert.deepEqual(await syncHistory(db, run), { applications: 2, added: 2, outcomes: 1, views: 1 });
  assert.deepEqual(await syncHistory(db, run), { applications: 2, added: 0, outcomes: 0, views: 0 });
  const stages = db.prepare('SELECT j.source_id, a.stage, a.channel FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY j.source_id').all();
  assert.deepEqual(stages.map((r) => ({ ...r })), [
    { source_id: 'n1', stage: 'applied', channel: 'naukri' },
    { source_id: 'n2', stage: 'call', channel: 'naukri' },
  ]);
  db.close();
});

test('variant insights count signals while each variant was live', async () => {
  const { db } = await setup();
  // Events are append-only, so each is written with its time up front.
  const event = (kind: string, at: string, data: object) => db.prepare('INSERT INTO events (kind, at, data) VALUES (?, ?, ?)').run(kind, at, JSON.stringify(data));
  event('naukri_refresh', '2026-11-01T00:00:00.000Z', { variant: 'backend' });
  event('naukri_signal', '2026-11-02T00:00:00.000Z', { signal: 'call' });
  event('naukri_refresh', '2026-11-08T00:00:00.000Z', { variant: 'payments' });
  event('naukri_signal', '2026-11-09T00:00:00.000Z', { signal: 'view' });

  const stats = variantInsights(db, Date.parse('2026-11-15T00:00:00.000Z'));
  assert.deepEqual(stats, [
    { variant: 'backend', daysLive: 7, calls: 1, views: 0, messages: 0, callsPerWeek: 1 },
    { variant: 'payments', daysLive: 7, calls: 0, views: 1, messages: 0, callsPerWeek: 0 },
  ]);
  db.close();
});

test('track marks 21-day silences as no reply', async () => {
  const { db } = await setup();
  const { run } = fakeBridge({ history: { applications: [{ jobId: 'n1', title: 'Dev', company: 'A', location: 'Pune', isOpen: true, statuses: [] }] } });
  await syncHistory(db, run);
  db.prepare('UPDATE applications SET updated_at = ?').run(new Date(Date.now() - 22 * 86_400_000).toISOString());
  assert.deepEqual(markNoReplies(db), [1]);
  assert.deepEqual(markNoReplies(db), []);
  recordOutcome(db, 1, { stage: 'call' });
  db.close();
});

test('the Naukri login is kept in an owner-only .env alongside other keys', async () => {
  const { paths, db } = await setup();
  db.close();
  await writeFile(paths.env, 'ANTHROPIC_API_KEY="sk-test"\n');
  await writeEnv(paths, { NAUKRI_USERNAME: 'me@example.com', NAUKRI_PASSWORD: 'p"w' });
  assert.deepEqual(await readEnv(paths), { ANTHROPIC_API_KEY: 'sk-test', NAUKRI_USERNAME: 'me@example.com', NAUKRI_PASSWORD: 'pw' });
  assert.equal(await isOwnerOnly(paths.env), true);
});

test('the daily script runs scan, track and the refresh, logging to daily.log', async () => {
  const paths = await tempPaths();
  const win = dailyScript(paths, 'win32');
  assert.match(win.file, /daily\.cmd$/);
  assert.match(win.text, /set "OFFERSTAR_HOME=/);
  assert.match(win.text, /" scan >> ".*daily\.log" 2>&1/);
  assert.match(win.text, /naukri refresh --scheduled/);
  const sh = dailyScript(paths, 'linux');
  assert.match(sh.text, /^#!\/bin\/sh/);
  assert.match(sh.text, /' track >> '/);
});
