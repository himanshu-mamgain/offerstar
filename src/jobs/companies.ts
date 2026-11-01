import type { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import type { Fetch } from '../importers/http.ts';
import { slugify } from '../profile.ts';
import { detectBoard, SOURCES, type Ats } from './sources.ts';
import pkg from '../../package.json' with { type: 'json' };

export interface Company {
  id: number;
  name: string;
  careers_url: string | null;
  ats: Ats;
  board_token: string;
  last_checked_at: string | null;
}

export interface FoundBoard {
  name: string;
  ats: Ats;
  token: string;
  careersUrl?: string;
  openJobs: number;
}

// Finds where a company publishes its jobs: a job-board URL directly, a
// careers page that links to one or carries JobPosting data, or, for a bare
// name, the board token each ATS would most likely use.
export async function findBoard(input: string, opts: { name?: string; fetch?: Fetch } = {}): Promise<FoundBoard> {
  const f = opts.fetch ?? fetch;
  const isUrl = /^https?:\/\//i.test(input);

  if (isUrl) {
    const direct = detectBoard(input);
    if (direct) {
      const jobs = await SOURCES[direct.ats](direct.token, { fetch: f });
      return { name: opts.name ?? jobs[0]?.company ?? direct.token, ...direct, careersUrl: input, openJobs: jobs.length };
    }

    const res = await f(input, { headers: { 'user-agent': `offerstar/${pkg.version}`, accept: 'text/html' } });
    if (!res.ok) throw new Error(`${new URL(input).host} answered ${res.status}`);
    const html = await res.text();
    const linked = detectBoard(html);
    const name = opts.name ?? (cheerio.load(html)('meta[property="og:site_name"]').attr('content') || new URL(input).hostname.replace(/^www\./, '').split('.')[0]!);
    if (linked) {
      const jobs = await SOURCES[linked.ats](linked.token, { fetch: f });
      return { name, ...linked, careersUrl: input, openJobs: jobs.length };
    }
    const jobs = await SOURCES.jsonld(input, { fetch: f });
    if (jobs.length > 0) return { name: opts.name ?? jobs[0]?.company ?? name, ats: 'jsonld', token: input, careersUrl: input, openJobs: jobs.length };
    throw new Error(`no job board or JobPosting data found on ${input}; try the page that lists the jobs`);
  }

  const candidates = [...new Set([slugify(input).replace(/-/g, ''), slugify(input)])];
  for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
    for (const token of candidates) {
      try {
        const jobs = await SOURCES[ats](token, { fetch: f });
        return { name: opts.name ?? input, ats, token, openJobs: jobs.length };
      } catch {
        // Not on this ATS under this token; try the next.
      }
    }
  }
  throw new Error(`could not find a Greenhouse, Lever or Ashby board for "${input}"; pass its careers page URL instead`);
}

export function saveCompany(db: DatabaseSync, board: FoundBoard): Company {
  db.prepare(
    `INSERT INTO companies (name, careers_url, ats, board_token) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET careers_url = excluded.careers_url, ats = excluded.ats, board_token = excluded.board_token`,
  ).run(board.name, board.careersUrl ?? null, board.ats, board.token);
  return db.prepare('SELECT * FROM companies WHERE name = ?').get(board.name) as unknown as Company;
}

export function listCompanies(db: DatabaseSync): Company[] {
  return db.prepare('SELECT * FROM companies WHERE ats IS NOT NULL ORDER BY name').all() as unknown as Company[];
}
