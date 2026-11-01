import * as cheerio from 'cheerio';
import { getJson, type Fetch } from '../importers/http.ts';
import pkg from '../../package.json' with { type: 'json' };

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'jsonld';

export interface FetchedJob {
  sourceId: string;
  title: string;
  company?: string;
  location?: string;
  url?: string;
  postedAt?: string;
  html?: string;
  text?: string;
}

export interface SourceOptions {
  fetch?: Fetch;
}

async function greenhouse(token: string, opts: SourceOptions): Promise<FetchedJob[]> {
  const data = await getJson<{ jobs: { id: number; title: string; absolute_url: string; first_published?: string; updated_at: string; company_name?: string; location?: { name?: string }; content?: string }[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
    opts,
  );
  return data.jobs.map((j) => ({
    sourceId: String(j.id),
    title: j.title.trim(),
    company: j.company_name,
    location: j.location?.name,
    url: j.absolute_url,
    postedAt: j.first_published ?? j.updated_at,
    // Greenhouse sends the HTML entity-escaped.
    html: j.content ? cheerio.load(j.content).text() : undefined,
  }));
}

async function lever(token: string, opts: SourceOptions): Promise<FetchedJob[]> {
  const data = await getJson<{ id: string; text: string; hostedUrl: string; createdAt: number; workplaceType?: string; categories?: { location?: string }; description?: string; lists?: { text: string; content: string }[]; additional?: string }[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
    opts,
  );
  return data.map((j) => ({
    sourceId: j.id,
    title: j.text.trim(),
    location: [j.categories?.location, j.workplaceType === 'remote' ? 'Remote' : undefined].filter(Boolean).join(', ') || undefined,
    url: j.hostedUrl,
    postedAt: new Date(j.createdAt).toISOString(),
    html: [j.description ?? '', ...(j.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`), j.additional ?? ''].join('\n'),
  }));
}

async function ashby(token: string, opts: SourceOptions): Promise<FetchedJob[]> {
  const data = await getJson<{ jobs: { id: string; title: string; location?: string; isRemote?: boolean; jobUrl: string; publishedAt?: string; descriptionHtml?: string; descriptionPlain?: string; isListed?: boolean }[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
    opts,
  );
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      sourceId: j.id,
      title: j.title.trim(),
      location: [j.location, j.isRemote ? 'Remote' : undefined].filter(Boolean).join(', ') || undefined,
      url: j.jobUrl,
      postedAt: j.publishedAt,
      html: j.descriptionHtml,
      text: j.descriptionHtml ? undefined : j.descriptionPlain,
    }));
}

// Minimal robots.txt reading: the rules under "User-agent: *".
export async function robotsAllows(pageUrl: string, f: Fetch = fetch): Promise<boolean> {
  const url = new URL(pageUrl);
  const res = await f(`${url.origin}/robots.txt`, { headers: { 'user-agent': `offerstar/${pkg.version}` } }).catch(() => undefined);
  if (!res?.ok) return true;
  let applies = false;
  const disallowed: string[] = [];
  for (const line of (await res.text()).split(/\r?\n/)) {
    const [key = '', ...rest] = line.replace(/#.*/, '').split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(key.trim())) applies = value === '*';
    else if (applies && /^disallow$/i.test(key.trim()) && value) disallowed.push(value);
  }
  return !disallowed.some((prefix) => url.pathname.startsWith(prefix));
}

interface JsonLdPosting {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  url?: string;
  identifier?: string | { value?: string };
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } } } | { address?: { addressLocality?: string } }[];
  jobLocationType?: string;
}

function findPostings(node: unknown, out: JsonLdPosting[] = []): JsonLdPosting[] {
  if (Array.isArray(node)) node.forEach((n) => findPostings(n, out));
  else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(obj as JsonLdPosting);
    if (obj['@graph']) findPostings(obj['@graph'], out);
  }
  return out;
}

// schema.org JobPosting data embedded in a careers page, which is what
// search engines read; respects robots.txt.
async function jsonld(pageUrl: string, opts: SourceOptions): Promise<FetchedJob[]> {
  const f = opts.fetch ?? fetch;
  if (!(await robotsAllows(pageUrl, f))) throw new Error(`robots.txt of ${new URL(pageUrl).host} disallows ${pageUrl}`);
  const res = await f(pageUrl, { headers: { 'user-agent': `offerstar/${pkg.version}`, accept: 'text/html' } });
  if (!res.ok) throw new Error(`${new URL(pageUrl).host} answered ${res.status}`);
  const $ = cheerio.load(await res.text());
  const postings: JsonLdPosting[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      findPostings(JSON.parse($(el).text()), postings);
    } catch {
      // A broken block elsewhere on the page should not hide the others.
    }
  });
  return postings
    .filter((p) => p.title)
    .map((p) => {
      const loc = Array.isArray(p.jobLocation) ? p.jobLocation[0] : p.jobLocation;
      const address = loc?.address as { addressLocality?: string; addressRegion?: string } | undefined;
      const id = typeof p.identifier === 'object' ? p.identifier?.value : p.identifier;
      const url = p.url ? new URL(p.url, pageUrl).toString() : pageUrl;
      return {
        sourceId: id ?? url + (p.url ? '' : `#${p.title}`),
        title: p.title!.trim(),
        company: p.hiringOrganization?.name,
        location: [address?.addressLocality, p.jobLocationType === 'TELECOMMUTE' ? 'Remote' : undefined].filter(Boolean).join(', ') || undefined,
        url,
        postedAt: p.datePosted,
        html: p.description,
      };
    });
}

export const SOURCES: Record<Ats, (token: string, opts: SourceOptions) => Promise<FetchedJob[]>> = { greenhouse, lever, ashby, jsonld };

// Board URL patterns for the ATS platforms with public job APIs.
const BOARD_PATTERNS: [Ats, RegExp][] = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i],
  ['lever', /jobs(?:\.eu)?\.lever\.co\/([\w.-]+)/i],
  ['ashby', /jobs\.ashbyhq\.com\/([\w.%-]+)/i],
];

export function detectBoard(text: string): { ats: Ats; token: string } | undefined {
  for (const [ats, re] of BOARD_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) return { ats, token: decodeURIComponent(m[1]) };
  }
  return undefined;
}
