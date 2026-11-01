import type { DatabaseSync } from 'node:sqlite';
import { recordOutcome } from './tracker.ts';

export const NO_REPLY_DAYS = 21;

// Applications with no news for 21 days become "no reply", which the
// learning loop counts; a later reply can still move them on.
export function markNoReplies(db: DatabaseSync, now = Date.now()): number[] {
  const cutoff = new Date(now - NO_REPLY_DAYS * 86_400_000).toISOString();
  const stale = db.prepare("SELECT job_id FROM applications WHERE stage = 'applied' AND updated_at < ?").all(cutoff) as { job_id: number }[];
  for (const { job_id } of stale) recordOutcome(db, job_id, { stage: 'no_reply' });
  return stale.map((r) => r.job_id);
}

// Applied jobs whose posting has since closed.
export function closedApplications(db: DatabaseSync): { job_id: number; title: string; company_name: string; stage: string }[] {
  return db
    .prepare("SELECT a.job_id, j.title, j.company_name, a.stage FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.status = 'closed' AND a.stage IN ('applied', 'call', 'screening', 'interview')")
    .all() as { job_id: number; title: string; company_name: string; stage: string }[];
}
