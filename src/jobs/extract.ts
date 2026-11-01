import { createHash } from 'node:crypto';

// "3-5 years", "3 to 5 yrs", "2+ years", "minimum 4 years".
export function extractExperience(text: string): { min?: number; max?: number } {
  const range = text.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const atLeast = text.match(/(?:minimum|min\.?|at least)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i);
  return atLeast ? { min: Number(atLeast[1]) } : {};
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(sr|senior)\b\.?/g, 'senior')
    .replace(/\b(jr|junior)\b\.?/g, 'junior')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Same company, title and city = the same job, whichever source it came from.
export function fingerprint(company: string, title: string, location: string | undefined): string {
  const city = norm(location ?? '').split(' ')[0] ?? '';
  return createHash('sha256').update(`${norm(company)}|${norm(title)}|${city}`).digest('hex').slice(0, 16);
}
