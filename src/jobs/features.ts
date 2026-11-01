import type { Config } from '../config.ts';

// The features the learning loop groups applications by. The same function
// labels a job when it is ranked and when it is applied to, so a lesson
// learned from applications applies to new jobs in the same way.

export interface JobFeatures {
  role_match: 'strong' | 'partial' | 'weak';
  seniority_match: 'match' | 'above' | 'below' | null;
  company_type: string | null;
  skill_overlap: number;
  days_since_posting: number | null;
  location: string | null;
}

export function seniority(title: string): 'senior' | 'junior' | 'mid' {
  if (/\b(senior|sr\.?|lead|staff|principal|architect|manager|head|director)\b/i.test(title)) return 'senior';
  if (/\b(junior|jr\.?|associate|intern|graduate|trainee|fresher)\b/i.test(title)) return 'junior';
  return 'mid';
}

export function jobFeatures(
  job: { title: string; posted_at: string | null; location: string | null },
  config: Config,
  parts: { title: number; skills: number },
  companyType: string | null,
  now = Date.now(),
): JobFeatures {
  const mine = config.experienceYears === undefined ? undefined : config.experienceYears >= 5 ? 'senior' : config.experienceYears <= 2 ? 'junior' : 'mid';
  const order = { junior: 0, mid: 1, senior: 2 };
  const theirs = seniority(job.title);
  return {
    role_match: parts.title >= 0.75 ? 'strong' : parts.title >= 0.25 ? 'partial' : 'weak',
    seniority_match: mine === undefined ? null : order[theirs] === order[mine] ? 'match' : order[theirs] > order[mine] ? 'above' : 'below',
    company_type: companyType,
    skill_overlap: Math.round(parts.skills * 100) / 100,
    days_since_posting: job.posted_at ? Math.max(0, Math.floor((now - Date.parse(job.posted_at)) / 86_400_000)) : null,
    location: job.location,
  };
}

// Posting age in the buckets insights reports.
export function daysBucket(days: number | null): string | null {
  if (days === null) return null;
  return days <= 3 ? '0-3 days' : days <= 7 ? '4-7 days' : days <= 14 ? '8-14 days' : '15+ days';
}
