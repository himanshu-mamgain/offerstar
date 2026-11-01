import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { Profile } from '../profile.ts';
import { canonicalSkill, extractSkills } from './terms.ts';

export const WEIGHTS = { skills: 0.45, title: 0.25, location: 0.15, experience: 0.1, freshness: 0.05 } as const;

export interface JobRow {
  id: number;
  title: string;
  company_name: string;
  location: string | null;
  description: string | null;
  skills: string;
  experience_min: number | null;
  experience_max: number | null;
  posted_at: string | null;
  url: string | null;
  guard_flags: string;
}

export interface Score {
  total: number;
  parts: Record<keyof typeof WEIGHTS, number> & { dealBreaker?: string };
  matched: string[];
  gaps: string[];
}

// Knowing the left skill means knowing the right ones.
const IMPLIES: Record<string, string[]> = {
  'typescript': ['javascript'],
  'node.js': ['javascript'],
  'react': ['javascript'],
  'next.js': ['react', 'javascript'],
  'nestjs': ['node.js', 'typescript', 'javascript'],
  'express.js': ['node.js', 'javascript'],
  'spring boot': ['spring', 'java'],
  'kotlin': ['java'],
  'django': ['python'],
  'flask': ['python'],
  'fastapi': ['python'],
  'postgresql': ['sql'],
  'mysql': ['sql'],
  'swiftui': ['swift', 'ios'],
  'kubernetes': ['docker'],
};

export function profileSkills(profile: Profile): Set<string> {
  const skills = new Set(profile.blocks.flatMap((b) => [...b.skills, ...(b.type === 'skill' ? [b.title] : [])]).map(canonicalSkill));
  for (const skill of [...skills]) for (const implied of IMPLIES[skill] ?? []) skills.add(implied);
  return skills;
}

// Job families: a role and a title in the same family are the same kind of job.
const FAMILIES = [
  /\b(?:developer|engineer|engineering|sde|programmer|swe|architect)\b/i,
  /\b(?:qa|sdet|tester|testing|quality)\b/i,
  /\b(?:devops|sre|reliability|platform|infrastructure|cloud)\b/i,
  /\b(?:designer|design)\b/i,
  /\b(?:data scientist|data analyst|analyst|analytics)\b/i,
];

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'in', 'role', 'i', 'ii', 'iii']);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(full|back|front)[\s-]+(stack|end)\b/g, '$1$2')
    .split(/[^a-z0-9.+#]+/)
    .filter((w) => w && !STOP.has(w));

const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function scoreJob(job: JobRow, config: Config, skills: Set<string>, now = Date.now()): Score {
  const haystack = `${job.title}\n${job.description ?? ''}`.toLowerCase();
  const dealBreaker = config.dealBreakers.find((d) => d.trim() && haystack.includes(d.toLowerCase().trim()));

  // The ten skills the posting mentions most carry the score.
  const jobSkills = (JSON.parse(job.skills) as string[]).slice(0, 10);
  const matched = jobSkills.filter((s) => skills.has(s));
  const gaps = jobSkills.filter((s) => !skills.has(s));
  // A posting that names no skill we know is rarely a technical role, and
  // one that names a single skill (often "SQL" in a finance role) is weak evidence.
  const skillPart = matched.length / Math.max(jobSkills.length, 4);

  // Half for the same kind of job (engineer, designer, QA...), half for the
  // specific words of the role, with skill aliases unified ("NodeJS" = "node.js").
  const roleFamilies = FAMILIES.filter((f) => f.test(config.role));
  const roleWords = [...new Set([...words(config.role), ...extractSkills(config.role)])].filter((w) => !FAMILIES.some((f) => f.test(w)));
  const titleWords = new Set([...words(job.title), ...extractSkills(job.title)]);
  const family = roleFamilies.length === 0 ? 0.5 : roleFamilies.some((f) => f.test(job.title)) ? 1 : 0;
  const specific = roleWords.length === 0 ? family : roleWords.filter((w) => titleWords.has(w)).length / roleWords.length;
  const titlePart = config.role ? (family + specific) / 2 : 0.5;

  const loc = (job.location ?? '').toLowerCase();
  const wanted = config.locations.map((l) => l.toLowerCase());
  const locationPart =
    wanted.length === 0 ? 1 : !loc ? 0.5 : wanted.some((w) => loc.includes(w) || (w === 'remote' && /remote|anywhere/.test(loc))) ? 1 : 0;

  let experiencePart = 0.5;
  if (config.experienceYears !== undefined && job.experience_min !== null) {
    const years = config.experienceYears;
    const max = job.experience_max ?? job.experience_min + 3;
    experiencePart = years >= job.experience_min && years <= max ? 1 : years >= job.experience_min - 1 && years <= max + 2 ? 0.5 : 0;
  } else if (config.experienceYears !== undefined) {
    experiencePart = 0.7;
  }

  const days = job.posted_at ? (now - Date.parse(job.posted_at)) / 86_400_000 : NaN;
  const freshnessPart = Number.isNaN(days) ? 0.5 : clamp(1 - (days - 7) / 23);

  const parts = { skills: skillPart, title: titlePart, location: locationPart, experience: experiencePart, freshness: freshnessPart };
  const total = dealBreaker ? 0 : Math.round(100 * Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * parts[k as keyof typeof WEIGHTS], 0));
  return { total, parts: dealBreaker ? { ...parts, dealBreaker } : parts, matched, gaps };
}

export interface ShortlistItem extends Score {
  job: JobRow;
}

// Scores every open job against the current profile and returns the best.
export function planShortlist(db: DatabaseSync, config: Config, profile: Profile, { limit = 20, minScore = 0 } = {}): ShortlistItem[] {
  const skills = profileSkills(profile);
  const jobs = db.prepare("SELECT * FROM jobs WHERE status = 'open'").all() as unknown as JobRow[];
  const save = db.prepare(
    `INSERT INTO scores (job_id, profile_hash, total, parts, gaps) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (job_id, profile_hash) DO UPDATE SET total = excluded.total, parts = excluded.parts, gaps = excluded.gaps,
       scored_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );

  const scored: ShortlistItem[] = [];
  db.exec('BEGIN');
  try {
    for (const job of jobs) {
      const score = scoreJob(job, config, skills);
      save.run(job.id, profile.hash, score.total, JSON.stringify({ ...score.parts, matched: score.matched }), JSON.stringify(score.gaps));
      if (!score.parts.dealBreaker && score.total >= minScore) scored.push({ job, ...score });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return scored.sort((a, b) => b.total - a.total).slice(0, limit);
}
