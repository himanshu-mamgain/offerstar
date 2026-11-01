import type { DatabaseSync } from 'node:sqlite';
import { getJob } from '../apply/application.ts';

export const STAGES = ['applied', 'call', 'screening', 'interview', 'offer', 'rejected', 'no_reply', 'withdrawn'] as const;
export type Stage = (typeof STAGES)[number];

// Stages that mean an employer responded positively.
const CALL_STAGES = new Set(['call', 'screening', 'interview', 'offer']);

export interface OutcomeInput {
  stage: Stage;
  offeredCtcLpa?: number;
  round?: { type: string; questions: string[]; rating?: number; heldOn?: string; notes?: string };
}

// Records what happened to an application. A job applied to outside
// Offerstar (Naukri, a referral) gets an application row the first time.
export function recordOutcome(db: DatabaseSync, jobId: number, input: OutcomeInput): void {
  const job = getJob(db, jobId);
  db.exec('BEGIN');
  try {
    const app = db.prepare('SELECT id, stage FROM applications WHERE job_id = ?').get(jobId) as { id: number; stage: string } | undefined;
    if (!app) {
      db.prepare("INSERT INTO applications (job_id, stage, channel, applied_at, location) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)").run(jobId, input.stage, job.source, job.location);
    } else if (app.stage === 'drafted' && input.stage !== 'withdrawn') {
      throw new Error(`job ${jobId} is still a draft; approve it with "offerstar apply approve ${jobId}" first`);
    } else {
      db.prepare("UPDATE applications SET stage = ?, offered_ctc_lpa = coalesce(?, offered_ctc_lpa), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(input.stage, input.offeredCtcLpa ?? null, app.id);
    }
    const appId = (db.prepare('SELECT id FROM applications WHERE job_id = ?').get(jobId) as { id: number }).id;
    if (input.round) {
      const r = input.round;
      db.prepare('INSERT INTO interviews (application_id, held_on, round_type, questions, rating, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
        appId,
        r.heldOn ?? new Date().toISOString().slice(0, 10),
        r.type,
        JSON.stringify(r.questions),
        r.rating ?? null,
        r.notes ?? null,
      );
    }
    db.prepare("INSERT INTO events (kind, job_id, application_id, data) VALUES ('outcome', ?, ?, ?)").run(jobId, appId, JSON.stringify(input));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function rateJob(db: DatabaseSync, jobId: number, verdict: 'good' | 'bad'): void {
  getJob(db, jobId);
  db.prepare('INSERT INTO ratings (job_id, verdict) VALUES (?, ?)').run(jobId, verdict);
  db.prepare("INSERT INTO events (kind, job_id, data) VALUES ('rated', ?, ?)").run(jobId, JSON.stringify({ verdict }));
}

export interface StatusRow {
  job_id: number;
  title: string;
  company_name: string;
  stage: string;
  applied_at: string | null;
  updated_at: string;
  job_status: string;
}

export interface Status {
  byStage: Record<string, number>;
  followUps: StatusRow[];
  noReply: StatusRow[];
  closedWhileOpen: StatusRow[];
  drafts: StatusRow[];
}

const days = (iso: string | null, now: number) => (iso ? (now - Date.parse(iso)) / 86_400_000 : 0);

// Where every application stands and what needs doing: follow up after a
// week of silence, call it "no reply" after 21 days.
export function applicationStatus(db: DatabaseSync, now = Date.now()): Status {
  const rows = db
    .prepare('SELECT a.job_id, j.title, j.company_name, a.stage, a.applied_at, a.updated_at, j.status AS job_status FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.updated_at DESC')
    .all() as unknown as StatusRow[];
  const byStage: Record<string, number> = {};
  for (const r of rows) byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
  const waiting = rows.filter((r) => r.stage === 'applied');
  return {
    byStage,
    followUps: waiting.filter((r) => days(r.updated_at, now) >= 7 && days(r.updated_at, now) < 21),
    noReply: waiting.filter((r) => days(r.updated_at, now) >= 21),
    closedWhileOpen: rows.filter((r) => r.job_status === 'closed' && ['applied', 'call', 'screening', 'interview'].includes(r.stage)),
    drafts: rows.filter((r) => r.stage === 'drafted'),
  };
}

// 95% Wilson interval: honest about how little a handful of applications says.
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denom = 1 + (z * z) / n;
  return [Math.max(0, (centre - spread) / denom), Math.min(1, (centre + spread) / denom)];
}

export interface Group {
  value: string;
  applied: number;
  calls: number;
  rate: number;
  low: number;
  high: number;
}

export interface Insights {
  funnel: { applied: number; calls: number; interviews: number; offers: number };
  groups: Record<string, Group[]>;
  ratings: { good: number; bad: number };
  // Groups below this size are shown but not acted on.
  minGroupSize: number;
}

const DIMENSIONS: Record<string, string> = {
  channel: 'a.channel',
  role_match: 'a.role_match',
  seniority_match: 'a.seniority_match',
  company_type: 'a.company_type',
  resume_variant: 'a.resume_version_id',
  resume_angle: 'a.resume_angle',
  days_since_posting: "CASE WHEN a.days_since_posting IS NULL THEN NULL WHEN a.days_since_posting <= 3 THEN '0-3 days' WHEN a.days_since_posting <= 7 THEN '4-7 days' WHEN a.days_since_posting <= 14 THEN '8-14 days' ELSE '15+ days' END",
};

// SQL over applications aliased "a": did it ever reach one of these stages?
const reached = (stages: string[]) =>
  `EXISTS (SELECT 1 FROM events e WHERE e.application_id = a.id AND e.kind = 'outcome' AND json_extract(e.data, '$.stage') IN (${stages.map((s) => `'${s}'`).join(',')}))`;
// An application "got a call" if any outcome ever reached a call stage,
// even if it was rejected later.
export const CALLED_SQL = `(${reached([...CALL_STAGES])} OR a.stage IN ('call', 'screening', 'interview', 'offer'))`;
// Applications that were actually sent.
export const SENT_SQL = "a.stage NOT IN ('drafted', 'withdrawn')";

export function insights(db: DatabaseSync): Insights {
  const called = CALLED_SQL;
  const sent = SENT_SQL;

  const funnel = db
    .prepare(
      `SELECT COUNT(*) AS applied, SUM(${called}) AS calls,
         SUM(${reached(['interview', 'offer'])} OR a.stage IN ('interview', 'offer')) AS interviews,
         SUM(${reached(['offer'])} OR a.stage = 'offer') AS offers
       FROM applications a WHERE ${sent}`,
    )
    .get() as { applied: number; calls: number | null; interviews: number | null; offers: number | null };

  const groups: Record<string, Group[]> = {};
  for (const [name, expr] of Object.entries(DIMENSIONS)) {
    const rows = db
      .prepare(`SELECT ${expr} AS value, COUNT(*) AS applied, SUM(${called}) AS calls FROM applications a WHERE ${sent} AND ${expr} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)
      .all() as { value: string | number; applied: number; calls: number }[];
    groups[name] = rows.map((r) => {
      const [low, high] = wilson(r.calls, r.applied);
      return { value: String(r.value), applied: r.applied, calls: r.calls, rate: r.calls / r.applied, low, high };
    });
  }

  const ratings = db.prepare("SELECT SUM(verdict = 'good') AS good, SUM(verdict = 'bad') AS bad FROM ratings").get() as { good: number | null; bad: number | null };
  return {
    funnel: { applied: funnel.applied, calls: funnel.calls ?? 0, interviews: funnel.interviews ?? 0, offers: funnel.offers ?? 0 },
    groups,
    ratings: { good: ratings.good ?? 0, bad: ratings.bad ?? 0 },
    minGroupSize: 10,
  };
}
