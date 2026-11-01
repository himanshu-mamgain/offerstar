import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { openDb } from '../db.ts';
import { profileSkills, scoreJob, type JobRow, type Score } from '../jobs/score.ts';
import type { Paths } from '../paths.ts';
import { slugify, type Profile } from '../profile.ts';
import { buildResume } from '../resume/build.ts';
import { checkResume, type CheckReport } from '../resume/check.ts';
import { auditDraft, draftResume, type Draft } from './draft.ts';

export interface StoredJob extends JobRow {
  source: string;
  status: string;
  company_id: number | null;
}

export function getJob(db: DatabaseSync, jobId: number): StoredJob {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as StoredJob | undefined;
  if (!job) throw new Error(`no job with id ${jobId}`);
  return job;
}

const folderName = (job: JobRow) => `${job.id}-${slugify(`${job.company_name} ${job.title}`).slice(0, 60)}`;

// Everything the apply skill needs in one read: the cleaned posting with its
// guard flags, the score and gaps, the evidence blocks, and the config fields
// screening answers may use.
export function prepareApply(db: DatabaseSync, config: Config, profile: Profile, jobId: number) {
  const job = getJob(db, jobId);
  const score = scoreJob(job, config, profileSkills(profile));
  return {
    job: { ...job, skills: JSON.parse(job.skills) as string[], guard_flags: JSON.parse(job.guard_flags) as string[] },
    score,
    blocks: profile.blocks,
    screening: {
      experienceYears: config.experienceYears,
      noticePeriodDays: config.noticePeriodDays,
      currentCtcLpa: config.currentCtcLpa,
      expectedCtcLpa: config.expectedCtcLpa,
      locations: config.locations,
    },
    rules: [
      'Every bullet cites the evidence block ids it comes from and sits under a block it cites.',
      'Numbers must appear in the cited blocks; emphasis may change, facts may not.',
      "Use the posting's exact term only where the profile supports it; list the rest as gaps.",
      'Answer a screening question only from a cited block or a config.yaml field; otherwise leave it for the user.',
    ],
  };
}

function seniority(title: string): 'senior' | 'junior' | 'mid' {
  if (/\b(senior|sr\.?|lead|staff|principal|architect|manager|head|director)\b/i.test(title)) return 'senior';
  if (/\b(junior|jr\.?|associate|intern|graduate|trainee|fresher)\b/i.test(title)) return 'junior';
  return 'mid';
}

// The features the learning loop groups by, saved when the application is drafted.
function features(job: StoredJob, config: Config, score: Score, db: DatabaseSync) {
  const title = score.parts.title;
  const mine = config.experienceYears === undefined ? undefined : config.experienceYears >= 5 ? 'senior' : config.experienceYears <= 2 ? 'junior' : 'mid';
  const order = { junior: 0, mid: 1, senior: 2 };
  const theirs = seniority(job.title);
  const company = job.company_id ? (db.prepare('SELECT company_type FROM companies WHERE id = ?').get(job.company_id) as { company_type: string | null } | undefined) : undefined;
  return {
    role_match: title >= 0.75 ? 'strong' : title >= 0.25 ? 'partial' : 'weak',
    seniority_match: mine === undefined ? null : order[theirs] === order[mine] ? 'match' : order[theirs] > order[mine] ? 'above' : 'below',
    company_type: company?.company_type ?? null,
    skill_overlap: Math.round(score.parts.skills * 100) / 100,
    days_since_posting: job.posted_at ? Math.max(0, Math.floor((Date.now() - Date.parse(job.posted_at)) / 86_400_000)) : null,
    location: job.location,
  };
}

export interface RenderResult {
  ok: boolean;
  problems: string[];
  folder?: string;
  resume?: string;
  check?: CheckReport;
}

// Audits the draft, renders the tailored resume into the application folder,
// runs the parse test against the posting's skills, and records the draft.
// Rendering again replaces the files until the application is approved.
export async function renderApplication(paths: Paths, config: Config, profile: Profile, draft: Draft, log?: (line: string) => void): Promise<RenderResult> {
  const problems = auditDraft(draft, profile, config);
  if (problems.length) return { ok: false, problems };

  const db = openDb(paths.db);
  try {
    const job = getJob(db, draft.jobId);
    const existing = db.prepare('SELECT stage FROM applications WHERE job_id = ?').get(job.id) as { stage: string } | undefined;
    if (existing && existing.stage !== 'drafted') return { ok: false, problems: [`job ${job.id} is already ${existing.stage}; it cannot be redrafted`] };

    const folder = join(paths.applications, folderName(job));
    await mkdir(folder, { recursive: true });
    const resumePath = join(folder, 'resume.pdf');
    const built = await buildResume(paths, config, profile, { data: draftResume(draft, profile, config), out: resumePath, model: draft.model, promptVersion: draft.promptVersion, log });
    const blocks = profile.blocks.filter((b) => built.blockIds.includes(b.id));
    const check = await checkResume(new Uint8Array(await readFile(resumePath)), { config, blocks, keywords: (JSON.parse(job.skills) as string[]).slice(0, 15) });

    await writeFile(join(folder, 'draft.json'), JSON.stringify(draft, null, 2));
    await writeFile(join(folder, 'check.json'), JSON.stringify(check, null, 2));
    if (draft.coverNote) await writeFile(join(folder, 'cover-note.txt'), `${draft.coverNote.text}\n`);
    if (draft.answers.length) await writeFile(join(folder, 'answers.md'), draft.answers.map((a) => `**${a.question}**\n${a.answer}\n`).join('\n'));

    const version = db.prepare('SELECT id FROM resume_versions WHERE file_hash = ?').get(built.fileHash) as { id: number };
    const f = features(job, config, scoreJob(job, config, profileSkills(profile)), db);
    db.prepare(
      `INSERT INTO applications (job_id, stage, channel, resume_version_id, folder, check_ok, role_match, seniority_match, company_type, skill_overlap, days_since_posting, location)
       VALUES (?, 'drafted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET resume_version_id = excluded.resume_version_id, folder = excluded.folder, check_ok = excluded.check_ok,
         role_match = excluded.role_match, seniority_match = excluded.seniority_match, company_type = excluded.company_type,
         skill_overlap = excluded.skill_overlap, days_since_posting = excluded.days_since_posting, location = excluded.location,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(job.id, job.source, version.id, folder, check.ok ? 1 : 0, f.role_match, f.seniority_match, f.company_type, f.skill_overlap, f.days_since_posting, f.location);
    db.prepare("INSERT INTO events (kind, job_id, data) VALUES ('drafted', ?, ?)").run(job.id, JSON.stringify({ fileHash: built.fileHash, checkOk: check.ok }));

    return { ok: check.ok, problems: check.ok ? [] : check.checks.filter((c) => c.status === 'fail').map((c) => `check ${c.id}: ${c.detail}`), folder, resume: resumePath, check };
  } finally {
    db.close();
  }
}

export interface ApprovalView {
  job: StoredJob;
  folder: string;
  resume: string;
  gaps: string[];
  coverNote?: string;
  answers: Draft['answers'];
  guardFlags: string[];
}

export class NeedsApproval extends Error {}

// The only way an application becomes "applied": a person at a terminal says
// yes. Callers without a person (Claude, scripts) get NeedsApproval.
export async function approveApplication(paths: Paths, jobId: number, ask: ((view: ApprovalView) => Promise<boolean>) | undefined): Promise<'applied' | 'declined'> {
  const db = openDb(paths.db);
  try {
    const job = getJob(db, jobId);
    const app = db.prepare('SELECT * FROM applications WHERE job_id = ?').get(jobId) as { stage: string; folder: string; check_ok: number } | undefined;
    if (!app) throw new Error(`job ${jobId} has no drafted application; draft it with the apply skill first`);
    if (app.stage !== 'drafted') throw new Error(`job ${jobId} is already ${app.stage}`);
    if (!app.check_ok) throw new Error(`the resume for job ${jobId} did not pass offerstar check; redraft it first`);
    if (!ask) throw new NeedsApproval(`job ${jobId} needs your approval: run "offerstar apply approve ${jobId}" in your own terminal`);

    const draft = JSON.parse(await readFile(join(app.folder, 'draft.json'), 'utf8')) as Draft;
    const score = db.prepare('SELECT gaps FROM scores WHERE job_id = ? ORDER BY scored_at DESC LIMIT 1').get(jobId) as { gaps: string } | undefined;
    const view: ApprovalView = {
      job,
      folder: app.folder,
      resume: join(app.folder, 'resume.pdf'),
      gaps: score ? (JSON.parse(score.gaps) as string[]) : [],
      coverNote: draft.coverNote?.text,
      answers: draft.answers,
      guardFlags: JSON.parse(job.guard_flags) as string[],
    };
    if (!(await ask(view))) {
      db.prepare("INSERT INTO events (kind, job_id) VALUES ('declined', ?)").run(jobId);
      return 'declined';
    }

    // Keep the exact posting that was applied to.
    await writeFile(join(app.folder, 'posting.txt'), `${job.title}\n${job.company_name}${job.location ? `, ${job.location}` : ''}\n${job.url ?? ''}\n\n${job.description ?? ''}\n`);
    db.prepare("UPDATE applications SET stage = 'applied', applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE job_id = ?").run(jobId);
    db.prepare("INSERT INTO events (kind, job_id, data) VALUES ('applied', ?, ?)").run(jobId, JSON.stringify({ folder: app.folder }));
    return 'applied';
  } finally {
    db.close();
  }
}
