import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { storeJobs } from '../src/jobs/store.ts';
import { applicationStatus, insights, rateJob, recordOutcome, wilson } from '../src/track/tracker.ts';
import { tempPaths } from './helpers.ts';

async function dbWithJobs(n: number) {
  const db = openDb((await tempPaths()).db);
  storeJobs(
    db,
    { companyId: null, companyName: 'Acme', source: 'paste' },
    Array.from({ length: n }, (_, i) => ({ sourceId: `j${i}`, title: `Engineer ${i}`, location: `City ${i}`, text: 'Node.js' })),
  );
  return db;
}

test('wilson intervals are wide for small samples and narrow for large ones', () => {
  const [lowSmall, highSmall] = wilson(1, 3);
  const [lowBig, highBig] = wilson(100, 300);
  assert.ok(highSmall - lowSmall > 0.6);
  assert.ok(highBig - lowBig < 0.12);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('outcomes move an application along and record interview rounds', async () => {
  const db = await dbWithJobs(1);
  recordOutcome(db, 1, { stage: 'applied' });
  recordOutcome(db, 1, { stage: 'interview', round: { type: 'technical 1', questions: ['Explain the event loop'], rating: 4 } });
  recordOutcome(db, 1, { stage: 'offer', offeredCtcLpa: 22 });

  const app = db.prepare('SELECT stage, offered_ctc_lpa, channel FROM applications WHERE job_id = 1').get() as Record<string, unknown>;
  assert.deepEqual({ ...app }, { stage: 'offer', offered_ctc_lpa: 22, channel: 'paste' });
  const round = db.prepare('SELECT round_type, questions, rating FROM interviews').get() as Record<string, unknown>;
  assert.deepEqual({ ...round }, { round_type: 'technical 1', questions: '["Explain the event loop"]', rating: 4 });
  db.close();
});

test('a draft cannot jump to an outcome before approval', async () => {
  const db = await dbWithJobs(1);
  db.prepare("INSERT INTO applications (job_id, stage, channel) VALUES (1, 'drafted', 'paste')").run();
  assert.throws(() => recordOutcome(db, 1, { stage: 'call' }), /still a draft/);
  db.close();
});

test('status lists follow-ups after a week and no-replies after 21 days', async () => {
  const db = await dbWithJobs(3);
  for (const id of [1, 2, 3]) recordOutcome(db, id, { stage: 'applied' });
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  db.prepare('UPDATE applications SET updated_at = ? WHERE job_id = 2').run(daysAgo(10));
  db.prepare('UPDATE applications SET updated_at = ? WHERE job_id = 3').run(daysAgo(25));

  const s = applicationStatus(db);
  assert.deepEqual(s.byStage, { applied: 3 });
  assert.deepEqual(s.followUps.map((r) => r.job_id), [2]);
  assert.deepEqual(s.noReply.map((r) => r.job_id), [3]);
  db.close();
});

test('insights count a call even after a later rejection', async () => {
  const db = await dbWithJobs(4);
  for (const id of [1, 2, 3, 4]) recordOutcome(db, id, { stage: 'applied' });
  recordOutcome(db, 1, { stage: 'call' });
  recordOutcome(db, 1, { stage: 'rejected' });
  recordOutcome(db, 2, { stage: 'interview' });
  recordOutcome(db, 3, { stage: 'no_reply' });
  rateJob(db, 4, 'good');

  const report = insights(db);
  assert.deepEqual(report.funnel, { applied: 4, calls: 2, interviews: 1, offers: 0 });
  assert.deepEqual(report.groups.channel!.map((g) => [g.value, g.calls, g.applied]), [['paste', 2, 4]]);
  assert.deepEqual(report.ratings, { good: 1, bad: 0 });
  db.close();
});
