import type { DatabaseSync } from 'node:sqlite';
import { extractExperience, fingerprint } from './extract.ts';
import { guardPosting } from './guard.ts';
import type { FetchedJob } from './sources.ts';
import { extractSkills } from './terms.ts';

export interface StoreResult {
  added: number;
  updated: number;
  duplicates: number;
  closed: number;
  flagged: number;
}

// Cleans each posting through the guard, then inserts it, refreshes it if
// already known, or skips it when the same job came in from another source.
// With `closeMissing`, jobs from this board that are no longer listed are closed.
export function storeJobs(
  db: DatabaseSync,
  board: { companyId: number | null; companyName: string; source: string },
  jobs: FetchedJob[],
  { now = new Date().toISOString(), closeMissing = false } = {},
): StoreResult {
  const result: StoreResult = { added: 0, updated: 0, duplicates: 0, closed: 0, flagged: 0 };
  const bySource = db.prepare('SELECT id FROM jobs WHERE source = ? AND source_id = ?');
  const byPrint = db.prepare("SELECT id FROM jobs WHERE fingerprint = ? AND status = 'open'");
  const touch = db.prepare("UPDATE jobs SET last_seen_at = ?, status = 'open' WHERE id = ?");
  const update = db.prepare(
    `UPDATE jobs SET title = ?, location = ?, description = ?, skills = ?, experience_min = ?, experience_max = ?,
       url = ?, posted_at = ?, guard_flags = ?, fingerprint = ?, last_seen_at = ?, status = 'open' WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO jobs (source, source_id, company_id, company_name, title, location, description, skills,
       experience_min, experience_max, url, posted_at, guard_flags, fingerprint, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    for (const job of jobs) {
      const guarded = guardPosting({ html: job.html, text: job.text });
      if (guarded.flags.length > 0) result.flagged++;
      const company = job.company ?? board.companyName;
      const skills = JSON.stringify(extractSkills(`${job.title}\n${guarded.text}`));
      const exp = extractExperience(guarded.text);
      const print = fingerprint(company, job.title, job.location);
      const flags = JSON.stringify(guarded.flags);

      const known = bySource.get(board.source, job.sourceId) as { id: number } | undefined;
      if (known) {
        update.run(job.title, job.location ?? null, guarded.text, skills, exp.min ?? null, exp.max ?? null, job.url ?? null, job.postedAt ?? null, flags, print, now, known.id);
        result.updated++;
        continue;
      }
      const twin = byPrint.get(print) as { id: number } | undefined;
      if (twin) {
        touch.run(now, twin.id);
        result.duplicates++;
        continue;
      }
      insert.run(board.source, job.sourceId, board.companyId, company, job.title, job.location ?? null, guarded.text, skills, exp.min ?? null, exp.max ?? null, job.url ?? null, job.postedAt ?? null, flags, print, now, now);
      result.added++;
    }

    if (closeMissing && board.companyId !== null) {
      const { changes } = db
        .prepare("UPDATE jobs SET status = 'closed' WHERE company_id = ? AND source = ? AND status = 'open' AND last_seen_at < ?")
        .run(board.companyId, board.source, now);
      result.closed = Number(changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}
