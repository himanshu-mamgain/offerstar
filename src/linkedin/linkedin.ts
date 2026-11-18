import type { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import type { Config } from '../config.ts';
import type { Fetch } from '../importers/http.ts';
import type { FetchedJob } from '../jobs/sources.ts';
import { storeJobs, type StoreResult } from '../jobs/store.ts';
import pkg from '../../package.json' with { type: 'json' };

// LinkedIn's public job pages, the ones it shows visitors who are not signed
// in: the search results list and each posting's page. No login, cookie or
// account is used, and no third-party scraping service. The endpoints and
// page structure follow what open-source scrapers such as JobSpy (MIT) read.
// LinkedIn's terms forbid automated access, so this is opt-in and low volume
// by design, and it identifies itself honestly instead of posing as a browser.
const SITE = 'https://www.linkedin.com';
const SEARCH = `${SITE}/jobs-guest/jobs/api/seeMoreJobPostings/search`;
// LinkedIn returns ten cards per request.
const PAGE_SIZE = 10;
const MAX_PAGES = 3;

export interface LinkedinCard {
  id: string;
  title: string;
  company?: string;
  location?: string;
  url: string;
  postedAt?: string;
}

export interface LinkedinOptions {
  fetch?: Fetch;
  // Waits between requests; replaced in tests.
  pause?: () => Promise<void>;
  now?: number;
}

const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() || undefined;
const jobUrl = (id: string) => `${SITE}/jobs/view/${id}/`;
const defaultPause = () => new Promise<void>((resolve) => setTimeout(resolve, 3000 + Math.random() * 4000));

// A job id from a bare id or any LinkedIn job link:
// /jobs/view/4480758639/, /jobs/view/some-title-at-company-4480758639, ?currentJobId=4480758639.
export function linkedinJobId(input: string): string | undefined {
  const text = input.trim();
  if (/^\d{6,}$/.test(text)) return text;
  if (!/linkedin\.com/i.test(text)) return undefined;
  return text.match(/[?&]currentJobId=(\d{6,})/)?.[1] ?? text.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/)?.[1];
}

// "Just now", "3 hours ago", "2 days ago", "1 week ago", "2 months ago".
export function postedAgo(label: string, now = Date.now()): string | undefined {
  if (/just now|moments? ago/i.test(label)) return new Date(now).toISOString();
  const m = label.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return undefined;
  const days = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2]!.toLowerCase() as 'day'];
  return new Date(now - Number(m[1]) * days * 86_400_000).toISOString();
}

// The job cards in one page of search results.
export function parseSearchCards(html: string, now = Date.now()): LinkedinCard[] {
  const $ = cheerio.load(html);
  const cards: LinkedinCard[] = [];
  const seen = new Set<string>();
  $('.base-search-card[data-entity-urn], [data-entity-urn*="jobPosting:"]').each((_, el) => {
    const card = $(el);
    const id = card.attr('data-entity-urn')?.match(/(\d+)$/)?.[1];
    const title = clean(card.find('.base-search-card__title, h3').first().text());
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    const time = card.find('time').first();
    const listed = time.attr('datetime');
    cards.push({
      id,
      title,
      company: clean(card.find('.base-search-card__subtitle, h4').first().text()),
      location: clean(card.find('.job-search-card__location').first().text()),
      url: jobUrl(id),
      postedAt: listed && !Number.isNaN(Date.parse(listed)) ? new Date(listed).toISOString() : postedAgo(time.text(), now),
    });
  });
  return cards;
}

// One posting page. Fields missing from the page fall back to the search card.
export function parsePosting(html: string, id: string, card?: Partial<LinkedinCard>, now = Date.now()): FetchedJob | undefined {
  const $ = cheerio.load(html);
  const title = clean($('.top-card-layout__title, .topcard__title').first().text()) ?? card?.title;
  if (!title) return undefined;
  const description = $('.show-more-less-html__markup, .description__text').first();
  const criteria = $('.description__job-criteria-item')
    .map((_, el) => {
      const label = clean($(el).find('.description__job-criteria-subheader, h3').first().text());
      const value = clean($(el).find('.description__job-criteria-text, span').first().text());
      return label && value ? `<p>${label}: ${value}</p>` : '';
    })
    .get()
    .join('');
  const body = description.html() ?? '';
  return {
    sourceId: id,
    title,
    company: clean($('.topcard__org-name-link, .topcard__flavor a').first().text()) ?? card?.company,
    location: clean($('.topcard__flavor--bullet').first().text()) ?? card?.location,
    url: jobUrl(id),
    postedAt: postedAgo($('.posted-time-ago__text').first().text(), now) ?? card?.postedAt,
    html: body || criteria ? `${body}${criteria}` : undefined,
  };
}

async function getPage(url: string, f: Fetch): Promise<string> {
  const res = await f(url, { headers: { 'user-agent': `offerstar/${pkg.version}`, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' } });
  if (res.status === 429 || res.status === 999) throw new Error('LinkedIn is refusing requests right now; wait a few hours, or copy the posting and use offerstar paste');
  if (res.status === 404) throw new Error('LinkedIn has no such posting; it may be closed');
  if (!res.ok) throw new Error(`linkedin.com answered ${res.status}`);
  return res.text();
}

// A posting's public page. LinkedIn sends visitors it will not show a posting
// to on to a sign-in or search page instead.
async function getPosting(id: string, f: Fetch): Promise<string> {
  const res = await f(jobUrl(id), { headers: { 'user-agent': `offerstar/${pkg.version}`, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' } });
  if (res.status === 429 || res.status === 999) throw new Error('LinkedIn is refusing requests right now; wait a few hours, or copy the posting and use offerstar paste');
  if (res.status === 404) throw new Error('LinkedIn has no such posting; it may be closed');
  if (!res.ok) throw new Error(`linkedin.com answered ${res.status}`);
  if (res.url && !new URL(res.url).pathname.startsWith('/jobs/view/')) throw new Error('LinkedIn asked for a sign-in instead of showing the posting; copy the posting and use offerstar paste');
  return res.text();
}

export function linkedinSearches(config: Config) {
  if (config.linkedin.searches.length) return config.linkedin.searches;
  if (!config.role) return [];
  const location = config.locations.find((l) => !/remote/i.test(l)) ?? '';
  return [{ keyword: config.role, location, postedWithinDays: 7, remote: !location && config.locations.some((l) => /remote/i.test(l)) }];
}

export function searchUrl(search: { keyword: string; location: string; postedWithinDays: number; remote: boolean }, start: number): string {
  const params = new URLSearchParams({ keywords: search.keyword, f_TPR: `r${search.postedWithinDays * 86_400}`, start: String(start) });
  if (search.location) params.set('location', search.location);
  if (search.remote) params.set('f_WT', '2');
  return `${SEARCH}?${params}`;
}

// Fetches one posting and stores it. Returns the stored job's id.
export async function linkedinAdd(db: DatabaseSync, input: string, opts: LinkedinOptions = {}): Promise<StoreResult & { jobId: number | null; title: string; company: string }> {
  const id = linkedinJobId(input);
  if (!id) throw new Error('expected a LinkedIn job link (linkedin.com/jobs/view/...) or a job id');
  const job = parsePosting(await getPosting(id, opts.fetch ?? fetch), id, undefined, opts.now);
  if (!job) throw new Error('could not read that posting; it may be closed, or LinkedIn changed its page. Copy the posting and use offerstar paste');
  const stored = storeJobs(db, { companyId: null, companyName: job.company ?? 'LinkedIn', source: 'linkedin' }, [job]);
  const row = db.prepare("SELECT id FROM jobs WHERE source = 'linkedin' AND source_id = ?").get(id) as { id: number } | undefined;
  return { ...stored, jobId: row?.id ?? null, title: job.title, company: job.company ?? 'LinkedIn' };
}

// Runs the configured searches, then reads each posting not already stored.
// Bounded: a few result pages per search and maxPostingsPerRun postings.
export async function linkedinSearch(db: DatabaseSync, config: Config, opts: LinkedinOptions = {}): Promise<StoreResult & { searched: number; found: number; skipped: number }> {
  const searches = linkedinSearches(config);
  if (searches.length === 0) throw new Error('set role in config.yaml, or linkedin.searches, before searching LinkedIn');
  const f = opts.fetch ?? fetch;
  const pause = opts.pause ?? defaultPause;
  const now = opts.now ?? Date.now();

  const cards = new Map<string, LinkedinCard>();
  let first = true;
  for (const search of searches) {
    let taken = 0;
    for (let page = 0; page < MAX_PAGES && taken < config.linkedin.resultsPerSearch; page++) {
      if (!first) await pause();
      first = false;
      const html = await getPage(searchUrl(search, page * PAGE_SIZE), f);
      const found = parseSearchCards(html, now);
      // The end of the results is an almost empty page; anything else with no jobs is a block or a changed layout.
      if (found.length === 0) {
        if (page === 0 && cheerio.load(html).text().trim().length > 200) throw new Error('LinkedIn returned a page with no jobs in it (blocked, or its layout changed); use offerstar paste for now');
        break;
      }
      for (const card of found.slice(0, config.linkedin.resultsPerSearch - taken)) cards.set(card.id, cards.get(card.id) ?? card);
      taken += found.length;
      if (found.length < PAGE_SIZE) break;
    }
  }

  const known = db.prepare("SELECT id FROM jobs WHERE source = 'linkedin' AND source_id = ?");
  const touch = db.prepare("UPDATE jobs SET last_seen_at = ?, status = 'open' WHERE id = ?");
  const seenAt = new Date(now).toISOString();
  const fresh: LinkedinCard[] = [];
  let updated = 0;
  for (const card of cards.values()) {
    const row = known.get(card.id) as { id: number } | undefined;
    if (row) {
      touch.run(seenAt, row.id);
      updated++;
    } else fresh.push(card);
  }

  const jobs: FetchedJob[] = [];
  const reading = fresh.slice(0, config.linkedin.maxPostingsPerRun);
  for (const card of reading) {
    await pause();
    const job = parsePosting(await getPosting(card.id, f), card.id, card, now);
    if (job) jobs.push(job);
  }
  const stored = storeJobs(db, { companyId: null, companyName: 'LinkedIn', source: 'linkedin' }, jobs, { now: seenAt });
  return { ...stored, updated: stored.updated + updated, searched: searches.length, found: cards.size, skipped: fresh.length - reading.length  };
}
