import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { auditCited } from '../apply/draft.ts';
import type { Config } from '../config.ts';
import { storeJobs, type StoreResult } from '../jobs/store.ts';
import type { Paths } from '../paths.ts';
import type { Profile } from '../profile.ts';
import { recordOutcome } from '../track/tracker.ts';
import type { BridgeRunner } from './addon.ts';

interface NaukriJob {
  jobId: string;
  title: string;
  company: string;
  location: string;
  experience: string;
  posted: string;
  url: string;
  description: string;
  tags: string[];
}

// Naukri shows "Just now", "Today", "3 Days Ago" or "30+ Days Ago".
export function postedDate(label: string, now = Date.now()): string | undefined {
  if (/just now|today|hour|minute|few/i.test(label)) return new Date(now).toISOString();
  const days = label.match(/(\d+)\+?\s*days?/i);
  return days ? new Date(now - Number(days[1]) * 86_400_000).toISOString() : undefined;
}

export function naukriSearches(config: Config) {
  const searches = config.naukri.searches.length
    ? config.naukri.searches
    : config.role
      ? [{ keyword: config.role, location: config.locations.find((l) => !/remote/i.test(l)) ?? '', experience: Math.round(config.experienceYears ?? 2), jobAge: 7 }]
      : [];
  return searches.map((s) => ({ ...s, pages: config.naukri.pagesPerSearch }));
}

export async function naukriSearch(db: DatabaseSync, config: Config, run: BridgeRunner): Promise<StoreResult & { searched: number }> {
  const searches = naukriSearches(config);
  if (searches.length === 0) throw new Error('set role in config.yaml, or naukri.searches, before searching Naukri');
  const { jobs } = (await run('search', { searches })) as { jobs: NaukriJob[] };
  const stored = storeJobs(
    db,
    { companyId: null, companyName: 'Naukri', source: 'naukri' },
    jobs.map((j) => ({
      sourceId: j.jobId,
      title: j.title,
      company: j.company,
      location: j.location === 'N/A' ? undefined : j.location,
      url: j.url,
      postedAt: postedDate(j.posted),
      text: [j.description, j.experience !== 'N/A' ? `Experience: ${j.experience}` : '', j.tags.length ? `Skills: ${j.tags.join(', ')}` : ''].filter(Boolean).join('\n'),
    })),
  );
  return { ...stored, searched: searches.length };
}

// Profile variants: truthful wordings of the same evidence that a refresh
// rotates through. Approved once by the user; any edit voids the approval.
const cited = z.object({ text: z.string().trim().min(1), cites: z.array(z.string()).min(1) });
export const VariantsSchema = z.object({
  variants: z.array(z.object({ name: z.string().min(1), headline: cited, summary: cited.optional(), keySkills: z.array(z.string()).default([]) })).min(1).max(5),
  // A resume built by Offerstar for this role family, re-uploaded unchanged.
  resume: z.string().optional(),
});
export type Variants = z.infer<typeof VariantsSchema>;

interface VariantsFile extends Variants {
  approvedHash?: string;
  approvedAt?: string;
  next: number;
}

const variantsPath = (paths: Paths) => join(paths.home, 'naukri-variants.json');
const hashOf = (v: Variants) => createHash('sha256').update(JSON.stringify({ variants: v.variants, resume: v.resume ?? null })).digest('hex');

export async function readVariants(paths: Paths): Promise<VariantsFile | undefined> {
  return existsSync(variantsPath(paths)) ? (JSON.parse(await readFile(variantsPath(paths), 'utf8')) as VariantsFile) : undefined;
}

export function isApproved(file: VariantsFile | undefined): file is VariantsFile & { approvedHash: string } {
  return !!file?.approvedHash && file.approvedHash === hashOf(file);
}

// Audits the variants like resume bullets (cited blocks, no invented
// numbers) and saves them unapproved.
export async function setVariants(paths: Paths, profile: Profile, db: DatabaseSync, input: Variants): Promise<string[]> {
  const problems = input.variants.flatMap((v) => [
    ...auditCited(`${v.name} headline`, v.headline, profile),
    ...(v.summary ? auditCited(`${v.name} summary`, v.summary, profile) : []),
  ]);
  if (input.resume) {
    if (!existsSync(input.resume)) problems.push(`resume ${input.resume} does not exist`);
    else {
      const hash = createHash('sha256').update(await readFile(input.resume)).digest('hex');
      if (!db.prepare('SELECT 1 FROM resume_versions WHERE file_hash = ?').get(hash)) problems.push('the resume must be one built by offerstar resume build or apply render');
    }
  }
  if (problems.length) return problems;
  await writeFile(variantsPath(paths), JSON.stringify({ ...input, next: 0 } satisfies VariantsFile, null, 2));
  return [];
}

export async function approveVariants(paths: Paths, ask: ((v: Variants) => Promise<boolean>) | undefined): Promise<boolean> {
  const file = await readVariants(paths);
  if (!file) throw new Error('no Naukri variants yet; write them with the pack skill, then offerstar naukri variants set <file>');
  if (!ask) throw new Error('approving Naukri variants needs you at a terminal: run "offerstar naukri variants approve" yourself');
  if (!(await ask(file))) return false;
  await writeFile(variantsPath(paths), JSON.stringify({ ...file, approvedHash: hashOf(file), approvedAt: new Date().toISOString() }, null, 2));
  return true;
}

export type RefreshResult = { status: 'refreshed'; variant: string } | { status: 'skipped'; reason: string };

// Pushes the next approved variant to the Naukri profile, at most once every
// refreshEveryDays.
export async function refreshProfile(paths: Paths, config: Config, db: DatabaseSync, run: BridgeRunner, { force = false, now = Date.now() } = {}): Promise<RefreshResult> {
  if (!config.naukri.enabled) return { status: 'skipped', reason: 'the Naukri add-on is not enabled in config.yaml' };
  const file = await readVariants(paths);
  if (!isApproved(file)) return { status: 'skipped', reason: 'no approved Naukri variants; run offerstar naukri variants approve' };

  const last = db.prepare("SELECT at FROM events WHERE kind = 'naukri_refresh' ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined;
  const days = last ? (now - Date.parse(last.at)) / 86_400_000 : Infinity;
  if (!force && days < config.naukri.refreshEveryDays) {
    return { status: 'skipped', reason: `last refresh ${days.toFixed(1)} days ago; next after ${config.naukri.refreshEveryDays}` };
  }

  const index = file.next % file.variants.length;
  const variant = file.variants[index]!;
  await run('refresh', { headline: variant.headline.text, summary: variant.summary?.text, resume: file.resume });
  db.prepare("INSERT INTO events (kind, data) VALUES ('naukri_refresh', ?)").run(JSON.stringify({ variant: variant.name, index }));
  await writeFile(variantsPath(paths), JSON.stringify({ ...file, next: index + 1 }, null, 2));
  return { status: 'refreshed', variant: variant.name };
}

export type SignalKind = 'call' | 'view' | 'message';

// A recruiter reached you through Naukri (a call, a profile view, an InMail).
export function recordSignal(db: DatabaseSync, kind: SignalKind, note?: string): void {
  db.prepare("INSERT INTO events (kind, data) VALUES ('naukri_signal', ?)").run(JSON.stringify({ signal: kind, note: note ?? null }));
}

const CALL_STATUS = /shortlist|interview|recruiter (?:called|contacted)|selected for/i;
const REJECT_STATUS = /reject|not (?:selected|shortlisted)|regret|position (?:filled|closed)/i;
const VIEW_STATUS = /view/i;

interface HistoryItem {
  jobId: string;
  title: string;
  company: string;
  location: string;
  statuses: { value: string; at: string }[];
}

// Brings applications made on Naukri into the tracker and turns their
// statuses into outcomes: shortlisted counts as a call, viewed as a signal.
export async function syncHistory(db: DatabaseSync, run: BridgeRunner): Promise<{ applications: number; added: number; outcomes: number; views: number }> {
  const { applications } = (await run('history', { days: 90 })) as { applications: HistoryItem[] };
  const seen = new Set((db.prepare("SELECT json_extract(data, '$.key') AS k FROM events WHERE kind = 'naukri_status'").all() as { k: string }[]).map((r) => r.k));
  let added = 0;
  let outcomes = 0;
  let views = 0;

  for (const h of applications) {
    storeJobs(db, { companyId: null, companyName: h.company, source: 'naukri' }, [{ sourceId: h.jobId, title: h.title, company: h.company, location: h.location }]);
    const job = db.prepare("SELECT id FROM jobs WHERE source = 'naukri' AND source_id = ?").get(h.jobId) as { id: number } | undefined;
    if (!job) continue; // the same job is already stored from another source
    if (!db.prepare('SELECT 1 FROM applications WHERE job_id = ?').get(job.id)) {
      recordOutcome(db, job.id, { stage: 'applied' });
      db.prepare("UPDATE applications SET channel = 'naukri' WHERE job_id = ?").run(job.id);
      added++;
    }
    for (const s of h.statuses) {
      const key = `${h.jobId}|${s.value}|${s.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      db.prepare("INSERT INTO events (kind, job_id, data) VALUES ('naukri_status', ?, ?)").run(job.id, JSON.stringify({ key, ...s }));
      const app = db.prepare('SELECT stage FROM applications WHERE job_id = ?').get(job.id) as { stage: string };
      if (CALL_STATUS.test(s.value) && app.stage === 'applied') {
        recordOutcome(db, job.id, { stage: 'call' });
        outcomes++;
      } else if (REJECT_STATUS.test(s.value) && ['applied', 'call', 'screening'].includes(app.stage)) {
        recordOutcome(db, job.id, { stage: 'rejected' });
        outcomes++;
      } else if (VIEW_STATUS.test(s.value)) {
        recordSignal(db, 'view', `${h.company}: ${s.value}`);
        views++;
      }
    }
  }
  return { applications: applications.length, added, outcomes, views };
}

export interface VariantStats {
  variant: string;
  daysLive: number;
  calls: number;
  views: number;
  messages: number;
  callsPerWeek: number;
}

// How each profile variant did while it was live: recruiter signals per week.
export function variantInsights(db: DatabaseSync, now = Date.now()): VariantStats[] {
  const refreshes = db.prepare("SELECT at, json_extract(data, '$.variant') AS variant FROM events WHERE kind = 'naukri_refresh' ORDER BY id").all() as { at: string; variant: string }[];
  const signals = db.prepare("SELECT at, json_extract(data, '$.signal') AS signal FROM events WHERE kind = 'naukri_signal' ORDER BY id").all() as { at: string; signal: SignalKind }[];
  const stats = new Map<string, VariantStats>();

  refreshes.forEach((r, i) => {
    const start = Date.parse(r.at);
    const end = i + 1 < refreshes.length ? Date.parse(refreshes[i + 1]!.at) : now;
    const s = stats.get(r.variant) ?? { variant: r.variant, daysLive: 0, calls: 0, views: 0, messages: 0, callsPerWeek: 0 };
    s.daysLive += (end - start) / 86_400_000;
    for (const sig of signals) {
      const at = Date.parse(sig.at);
      if (at < start || at >= end) continue;
      if (sig.signal === 'call') s.calls++;
      else if (sig.signal === 'view') s.views++;
      else s.messages++;
    }
    stats.set(r.variant, s);
  });

  return [...stats.values()].map((s) => ({ ...s, daysLive: Math.round(s.daysLive * 10) / 10, callsPerWeek: s.daysLive > 0 ? Math.round((s.calls / s.daysLive) * 7 * 10) / 10 : 0 }));
}
