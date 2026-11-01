import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { daysBucket, type JobFeatures } from '../jobs/features.ts';
import type { Paths } from '../paths.ts';
import { CALLED_SQL, SENT_SQL, wilson } from '../track/tracker.ts';

// The learning loop: which kinds of jobs, channels and resume angles get
// calls. It only ever proposes; the user approves each change, and nothing
// here touches the facts in the profile.

// A group needs this many sent applications before it is acted on.
export const MIN_GROUP = 10;
// Small groups are pulled toward the overall rate by this many
// pseudo-applications, so 2 calls out of 3 does not look like 67%.
const PRIOR = 5;
const MAX_LIFT = 1.5;
const MIN_LIFT = 0.6;

const DIMENSIONS: Record<string, string> = {
  role_match: 'a.role_match',
  seniority_match: 'a.seniority_match',
  company_type: 'a.company_type',
  channel: 'a.channel',
  posting_age:
    "CASE WHEN a.days_since_posting IS NULL THEN NULL WHEN a.days_since_posting <= 3 THEN '0-3 days' WHEN a.days_since_posting <= 7 THEN '4-7 days' WHEN a.days_since_posting <= 14 THEN '8-14 days' ELSE '15+ days' END",
  company: 'j.company_name',
  resume_angle: 'a.resume_angle',
};

// Dimensions whose lessons can re-rank new jobs.
const RANKING_DIMENSIONS = ['role_match', 'seniority_match', 'company_type', 'channel', 'posting_age'];

export interface LearnGroup {
  dimension: string;
  value: string;
  applied: number;
  calls: number;
  rate: number;
  smoothed: number;
  lift: number;
  low: number;
  high: number;
}

export interface Base {
  applied: number;
  calls: number;
  rate: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const clamp = (n: number) => Math.min(MAX_LIFT, Math.max(MIN_LIFT, n));

export function learnGroups(db: DatabaseSync): { base: Base; groups: LearnGroup[] } {
  const b = db.prepare(`SELECT COUNT(*) AS applied, SUM(${CALLED_SQL}) AS calls FROM applications a WHERE ${SENT_SQL}`).get() as { applied: number; calls: number | null };
  const base = { applied: b.applied, calls: b.calls ?? 0, rate: b.applied ? (b.calls ?? 0) / b.applied : 0 };
  const groups: LearnGroup[] = [];
  for (const [dimension, expr] of Object.entries(DIMENSIONS)) {
    const rows = db
      .prepare(`SELECT ${expr} AS value, COUNT(*) AS applied, SUM(${CALLED_SQL}) AS calls FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${SENT_SQL} AND ${expr} IS NOT NULL GROUP BY 1`)
      .all() as { value: string; applied: number; calls: number }[];
    for (const r of rows) {
      const smoothed = (r.calls + PRIOR * base.rate) / (r.applied + PRIOR);
      const [low, high] = wilson(r.calls, r.applied);
      groups.push({ dimension, value: String(r.value), applied: r.applied, calls: r.calls, rate: r.calls / r.applied, smoothed, lift: base.rate > 0 ? smoothed / base.rate : 1, low, high });
    }
  }
  return { base, groups };
}

export type Proposal =
  | { id: string; kind: 'ranking'; dimension: string; value: string; lift: number; evidence: string }
  | { id: string; kind: 'drop-company'; company: string; evidence: string }
  | { id: string; kind: 'keep-angle'; angle: string; evidence: string };

const LABELS: Record<string, string> = {
  role_match: 'role match',
  seniority_match: 'seniority',
  company_type: 'company type',
  channel: 'channel',
  posting_age: 'applying',
};

export function describe(p: Proposal): string {
  if (p.kind === 'ranking') return `${p.lift > 1 ? 'Rank up' : 'Rank down'} jobs where ${LABELS[p.dimension] ?? p.dimension} is "${p.value}" (x${p.lift}): ${p.evidence}`;
  if (p.kind === 'drop-company') return `Stop tracking ${p.company}: ${p.evidence}`;
  return `Use the "${p.angle}" resume angle from now on: ${p.evidence}`;
}

export function propose(db: DatabaseSync): { base: Base; proposals: Proposal[] } {
  const { base, groups } = learnGroups(db);
  const proposals: Proposal[] = [];
  const vs = (g: LearnGroup) => `calls from ${g.calls} of ${g.applied} (${pct(g.rate)}, likely ${pct(g.low)}-${pct(g.high)}) vs ${pct(base.rate)} overall`;

  for (const g of groups) {
    if (RANKING_DIMENSIONS.includes(g.dimension) && g.applied >= MIN_GROUP && (g.lift >= 1.25 || g.lift <= 0.8)) {
      proposals.push({ id: `rank:${g.dimension}=${g.value}`, kind: 'ranking', dimension: g.dimension, value: g.value, lift: Math.round(clamp(g.lift) * 100) / 100, evidence: vs(g) });
    }
  }

  // A tracked company that has ignored five applications.
  const tracked = new Set((db.prepare('SELECT name FROM companies WHERE ats IS NOT NULL').all() as { name: string }[]).map((r) => r.name));
  for (const g of groups.filter((g) => g.dimension === 'company' && g.applied >= 5 && g.calls === 0 && tracked.has(g.value))) {
    proposals.push({ id: `drop:${g.value}`, kind: 'drop-company', company: g.value, evidence: `no calls from ${g.applied} applications` });
  }

  // An angle wins only when its likely range sits above every other's.
  const angles = groups.filter((g) => g.dimension === 'resume_angle' && g.applied >= MIN_GROUP).sort((a, b) => b.rate - a.rate);
  const [best, ...rest] = angles;
  if (best && rest.length > 0 && rest.every((r) => best.low > r.high)) {
    proposals.push({ id: `angle:${best.value}`, kind: 'keep-angle', angle: best.value, evidence: `${vs(best)}; ${rest.map((r) => `"${r.value}" ${r.calls} of ${r.applied}`).join(', ')}` });
  }
  return { base, proposals };
}

// What the user has approved, applied to future ranking and drafts.
export interface Learned {
  adjustments: { dimension: string; value: string; lift: number; evidence: string }[];
  preferredAngle?: string;
  experiment?: { angles: string[] };
  updatedAt?: string;
}

const learnedPath = (paths: Paths) => join(paths.home, 'learned.json');
const proposalsPath = (paths: Paths) => join(paths.home, 'proposals.json');

export async function readLearned(paths: Paths): Promise<Learned> {
  return existsSync(learnedPath(paths)) ? (JSON.parse(await readFile(learnedPath(paths), 'utf8')) as Learned) : { adjustments: [] };
}

async function saveLearned(paths: Paths, learned: Learned): Promise<void> {
  await writeFile(learnedPath(paths), JSON.stringify({ ...learned, updatedAt: new Date().toISOString() }, null, 2));
}

export async function saveProposals(paths: Paths, proposals: Proposal[]): Promise<void> {
  await writeFile(proposalsPath(paths), JSON.stringify({ createdAt: new Date().toISOString(), proposals }, null, 2));
}

export async function readProposals(paths: Paths): Promise<Proposal[]> {
  return existsSync(proposalsPath(paths)) ? (JSON.parse(await readFile(proposalsPath(paths), 'utf8')) as { proposals: Proposal[] }).proposals : [];
}

// Adopts the proposals the user says yes to, one by one. Needs a person.
export async function approveProposals(paths: Paths, db: DatabaseSync, ask: ((p: Proposal) => Promise<boolean>) | undefined): Promise<Proposal[]> {
  const proposals = await readProposals(paths);
  if (proposals.length === 0) return [];
  if (!ask) throw new Error('approving learning changes needs you at a terminal: run "offerstar learn approve" yourself');
  const learned = await readLearned(paths);
  const adopted: Proposal[] = [];
  for (const p of proposals) {
    if (!(await ask(p))) continue;
    if (p.kind === 'ranking') {
      learned.adjustments = learned.adjustments.filter((a) => !(a.dimension === p.dimension && a.value === p.value));
      learned.adjustments.push({ dimension: p.dimension, value: p.value, lift: p.lift, evidence: p.evidence });
    } else if (p.kind === 'drop-company') {
      db.prepare('UPDATE companies SET ats = NULL WHERE name = ?').run(p.company);
    } else {
      learned.preferredAngle = p.angle;
      delete learned.experiment;
    }
    db.prepare("INSERT INTO events (kind, data) VALUES ('learning_adopted', ?)").run(JSON.stringify(p));
    adopted.push(p);
  }
  await saveLearned(paths, learned);
  await saveProposals(paths, proposals.filter((p) => !adopted.includes(p)));
  return adopted;
}

// Starts a comparison of two or more truthful resume angles.
export async function startAngleTest(paths: Paths, angles: string[]): Promise<void> {
  if (angles.length < 2) throw new Error('name at least two angles, e.g. backend payments');
  const learned = await readLearned(paths);
  delete learned.preferredAngle;
  await saveLearned(paths, { ...learned, experiment: { angles } });
}

// The angle the next draft should take: the adopted one, or in a running
// test the one with the fewest applications among similar jobs.
export function suggestAngle(db: DatabaseSync, learned: Learned, roleMatch: string): string | undefined {
  if (learned.preferredAngle) return learned.preferredAngle;
  const angles = learned.experiment?.angles;
  if (!angles?.length) return undefined;
  const count = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE resume_angle = ? AND role_match = ? AND stage <> 'withdrawn'");
  return angles.map((a) => ({ a, n: (count.get(a, roleMatch) as { n: number }).n })).sort((x, y) => x.n - y.n)[0]!.a;
}

// How an adopted lesson changes a new job's score, and why.
export function learnedAdjustment(learned: Learned, features: JobFeatures & { channel: string }): { factor: number; reasons: string[] } {
  const values: Record<string, string | null> = {
    role_match: features.role_match,
    seniority_match: features.seniority_match,
    company_type: features.company_type,
    channel: features.channel,
    posting_age: daysBucket(features.days_since_posting),
  };
  let factor = 1;
  const reasons: string[] = [];
  for (const a of learned.adjustments) {
    if (values[a.dimension] !== a.value) continue;
    factor *= a.lift;
    reasons.push(`${LABELS[a.dimension] ?? a.dimension} "${a.value}": ${a.evidence}`);
  }
  return { factor: clamp(factor), reasons };
}

// The M6 gate: is the call rate after the first 30 applications better?
export function progress(db: DatabaseSync, first = 30) {
  const rows = db.prepare(`SELECT ${CALLED_SQL} AS called FROM applications a WHERE ${SENT_SQL} ORDER BY coalesce(a.applied_at, a.updated_at), a.id`).all() as { called: number }[];
  const summarise = (part: { called: number }[]) => {
    const calls = part.filter((r) => r.called).length;
    const [low, high] = wilson(calls, part.length);
    return { applied: part.length, calls, rate: part.length ? calls / part.length : 0, low, high };
  };
  return { first: summarise(rows.slice(0, first)), since: summarise(rows.slice(first)) };
}

// Interview prep: questions that keep coming up, and rounds that went badly.
export function prepList(db: DatabaseSync) {
  const rounds = db
    .prepare('SELECT i.round_type, i.questions, i.rating, i.held_on, j.title, j.company_name FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id ORDER BY i.held_on DESC')
    .all() as { round_type: string; questions: string; rating: number | null; held_on: string; title: string; company_name: string }[];
  const counts = new Map<string, { question: string; count: number }>();
  for (const r of rounds) {
    for (const q of JSON.parse(r.questions) as string[]) {
      const key = q.toLowerCase().replace(/[?.!\s]+$/, '').replace(/\s+/g, ' ').trim();
      const entry = counts.get(key) ?? { question: q.trim(), count: 0 };
      counts.set(key, { ...entry, count: entry.count + 1 });
    }
  }
  return {
    rounds: rounds.length,
    repeated: [...counts.values()].filter((c) => c.count >= 2).sort((a, b) => b.count - a.count),
    lowRated: rounds.filter((r) => r.rating !== null && r.rating <= 2).map((r) => ({ round: r.round_type, company: r.company_name, title: r.title, rating: r.rating, heldOn: r.held_on, questions: JSON.parse(r.questions) as string[] })),
  };
}

const START = '<!-- offerstar:numbers:start -->';
const END = '<!-- offerstar:numbers:end -->';

// learnings.md: the retro skill writes its notes freely; Offerstar keeps the
// numbers between its markers up to date and never touches the rest.
export async function writeLearnings(paths: Paths, numbers: string): Promise<void> {
  const block = `${START}\n${numbers.trim()}\n${END}`;
  const existing = existsSync(paths.learnings) ? await readFile(paths.learnings, 'utf8') : '# What Offerstar has learned\n\nThe weekly retro adds its notes below the numbers. Nothing here changes the facts in your profile.\n\n';
  const next = existing.includes(START) && existing.includes(END) ? existing.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block) : `${existing.trimEnd()}\n\n${block}\n`;
  await writeFile(paths.learnings, next);
}

export function numbersMarkdown(base: Base, prog: ReturnType<typeof progress>, proposals: Proposal[], learned: Learned): string {
  const lines = [
    `## Numbers (${new Date().toISOString().slice(0, 10)})`,
    '',
    `- Sent: ${base.applied}, calls: ${base.calls} (${pct(base.rate)})`,
    `- First ${prog.first.applied}: ${prog.first.calls} calls (${pct(prog.first.rate)}); since then: ${prog.since.calls} of ${prog.since.applied} (${pct(prog.since.rate)})`,
    '',
    '### Proposed, waiting for your approval',
    ...(proposals.length ? proposals.map((p) => `- ${describe(p)}`) : [`- Nothing yet; groups need ${MIN_GROUP} applications before Offerstar acts on them.`]),
    '',
    '### Adopted',
    ...(learned.adjustments.length ? learned.adjustments.map((a) => `- ${LABELS[a.dimension] ?? a.dimension} "${a.value}": x${a.lift} (${a.evidence})`) : ['- Nothing adopted yet.']),
    ...(learned.preferredAngle ? [`- Resume angle: "${learned.preferredAngle}"`] : []),
    ...(learned.experiment ? [`- Testing resume angles: ${learned.experiment.angles.join(' vs ')}`] : []),
  ];
  return lines.join('\n');
}
