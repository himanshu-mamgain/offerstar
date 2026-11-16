import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { initHome } from '../src/home.ts';
import type { Fetch } from '../src/importers/http.ts';
import { linkedinAdd, linkedinJobId, linkedinSearch, linkedinSearches, parsePosting, parseSearchCards, postedAgo, searchUrl } from '../src/linkedin/linkedin.ts';
import { tempPaths } from './helpers.ts';

const NOW = Date.parse('2026-11-16T00:00:00Z');

const card = (id: string, title: string, company: string, location: string, date: string) => `
<li><div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
  <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/x-${id}?trk=abc"><span class="sr-only">${title}</span></a>
  <div class="base-search-card__info">
    <h3 class="base-search-card__title"> ${title} </h3>
    <h4 class="base-search-card__subtitle"><a href="#"> ${company} </a></h4>
    <div><span class="job-search-card__location"> ${location} </span>
    <time class="job-search-card__listdate" datetime="${date}">3 days ago</time></div>
  </div></div></li>`;

const posting = (title: string, company: string, body: string) => `
<section class="top-card-layout"><h2 class="top-card-layout__title">${title}</h2>
  <h4><span class="topcard__flavor"><a class="topcard__org-name-link" href="#"> ${company} </a></span>
  <span class="topcard__flavor topcard__flavor--bullet"> Gurugram, Haryana, India </span></h4>
  <span class="posted-time-ago__text"> 2 days ago </span></section>
<div class="description__text"><div class="show-more-less-html__markup">${body}</div></div>
<ul><li class="description__job-criteria-item"><h3>Seniority level</h3><span> Mid-Senior level </span></li></ul>`;

// A stand-in for linkedin.com that records the URLs it was asked for.
function fakeLinkedin(pages: Record<string, string | number>) {
  const urls: string[] = [];
  const f: Fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(pages).find((k) => url.includes(k));
    const page = key === undefined ? 404 : pages[key]!;
    return typeof page === 'number' ? new Response('', { status: page }) : new Response(page, { status: 200 });
  };
  return { fetch: f, urls };
}

async function setup() {
  const paths = await tempPaths();
  await initHome(paths);
  return openDb(paths.db);
}

const config = ConfigSchema.parse({ version: 1, role: 'Node.js developer', locations: ['Remote', 'Gurugram'], linkedin: { enabled: true } });
const pause = async () => {};

test('job ids are read from links and bare ids', () => {
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/view/4480758639/'), '4480758639');
  assert.equal(linkedinJobId('https://in.linkedin.com/jobs/view/backend-engineer-at-acme-4480758639?trk=x'), '4480758639');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/search/?currentJobId=4480758639&keywords=node'), '4480758639');
  assert.equal(linkedinJobId('4480758639'), '4480758639');
  assert.equal(linkedinJobId('https://example.com/jobs/view/4480758639'), undefined);
  assert.equal(linkedinJobId('not a job'), undefined);
});

test('posted labels become dates', () => {
  assert.equal(postedAgo('2 days ago', NOW), '2026-11-14T00:00:00.000Z');
  assert.equal(postedAgo('1 week ago', NOW), '2026-11-09T00:00:00.000Z');
  assert.equal(postedAgo('5 hours ago', NOW), '2026-11-16T00:00:00.000Z');
  assert.equal(postedAgo('Just now', NOW), '2026-11-16T00:00:00.000Z');
  assert.equal(postedAgo('', NOW), undefined);
});

test('search cards are parsed and deduped', () => {
  const cards = parseSearchCards(card('111111', 'Backend Engineer', 'Acme', 'Gurugram, India', '2026-11-13') + card('111111', 'Backend Engineer', 'Acme', 'Gurugram, India', '2026-11-13') + card('222222', 'SDE II', 'Beta', 'Remote', '2026-11-10'), NOW);
  assert.deepEqual(cards.map((c) => [c.id, c.title, c.company, c.location]), [
    ['111111', 'Backend Engineer', 'Acme', 'Gurugram, India'],
    ['222222', 'SDE II', 'Beta', 'Remote'],
  ]);
  assert.equal(cards[0]!.url, 'https://www.linkedin.com/jobs/view/111111/');
  assert.equal(cards[0]!.postedAt, '2026-11-13T00:00:00.000Z');
  assert.deepEqual(parseSearchCards('<html><body>Sign in</body></html>'), []);
});

test('a posting is parsed, falling back to its search card', () => {
  const job = parsePosting(posting('Backend Engineer', 'Acme', '<p>Node.js and PostgreSQL, 2-4 years.</p>'), '111111', undefined, NOW)!;
  assert.equal(job.title, 'Backend Engineer');
  assert.equal(job.company, 'Acme');
  assert.equal(job.location, 'Gurugram, Haryana, India');
  assert.equal(job.postedAt, '2026-11-14T00:00:00.000Z');
  assert.match(job.html!, /Node\.js and PostgreSQL/);
  assert.match(job.html!, /Seniority level: Mid-Senior level/);

  const bare = parsePosting('<div class="show-more-less-html__markup"><p>React</p></div>', '222222', { title: 'SDE II', company: 'Beta', location: 'Remote' }, NOW)!;
  assert.deepEqual([bare.title, bare.company, bare.location], ['SDE II', 'Beta', 'Remote']);
  assert.equal(parsePosting('<html></html>', '333333'), undefined);
});

test('default search comes from the role and first city; configured searches win', () => {
  assert.deepEqual(linkedinSearches(config), [{ keyword: 'Node.js developer', location: 'Gurugram', postedWithinDays: 7, remote: false }]);
  const url = new URL(searchUrl({ keyword: 'Node.js developer', location: 'Gurugram', postedWithinDays: 7, remote: true }, 10));
  assert.equal(url.pathname, '/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.deepEqual([url.searchParams.get('keywords'), url.searchParams.get('location'), url.searchParams.get('f_TPR'), url.searchParams.get('f_WT'), url.searchParams.get('start')], ['Node.js developer', 'Gurugram', 'r604800', '2', '10']);
  const custom = ConfigSchema.parse({ version: 1, role: 'x', linkedin: { searches: [{ keyword: 'nestjs' }] } });
  assert.deepEqual(linkedinSearches(custom), [{ keyword: 'nestjs', location: '', postedWithinDays: 7, remote: false }]);
  assert.throws(() => ConfigSchema.parse({ version: 1, linkedin: { searches: Array(6).fill({ keyword: 'a' }) } }));
});

test('search stores new postings, skips known ones and respects the per-run cap', async () => {
  const db = await setup();
  const site = fakeLinkedin({
    'start=0': card('111111', 'Backend Engineer', 'Acme', 'Gurugram, India', '2026-11-13') + card('222222', 'SDE II', 'Beta', 'Remote', '2026-11-10'),
    'jobs/view/111111': posting('Backend Engineer', 'Acme', '<p>Node.js, NestJS and PostgreSQL. 2-4 years.</p>'),
    'jobs/view/222222': posting('SDE II', 'Beta', '<p>React and TypeScript.</p>'),
  });
  const first = await linkedinSearch(db, config, { fetch: site.fetch, pause, now: NOW });
  assert.deepEqual([first.searched, first.found, first.added, first.updated, first.skipped], [1, 2, 2, 0, 0]);
  const row = db.prepare("SELECT title, company_name, location, skills, experience_min, url FROM jobs WHERE source = 'linkedin' AND source_id = '111111'").get() as Record<string, unknown>;
  assert.equal(row.company_name, 'Acme');
  assert.equal(row.url, 'https://www.linkedin.com/jobs/view/111111/');
  assert.equal(row.experience_min, 2);
  assert.ok((JSON.parse(row.skills as string) as string[]).includes('nestjs'));

  // A second run re-reads the results but not the postings it already has.
  site.urls.length = 0;
  const second = await linkedinSearch(db, config, { fetch: site.fetch, pause, now: NOW });
  assert.deepEqual([second.added, second.updated], [0, 2]);
  assert.ok(!site.urls.some((u) => u.includes('jobs/view/')));

  const capped = ConfigSchema.parse({ version: 1, role: 'Node.js developer', linkedin: { maxPostingsPerRun: 1 } });
  const db2 = await setup();
  const third = await linkedinSearch(db2, capped, { fetch: site.fetch, pause, now: NOW });
  assert.deepEqual([third.added, third.skipped], [1, 1]);
  db.close();
  db2.close();
});

test('add stores one posting from its link and explains refusals', async () => {
  const db = await setup();
  const site = fakeLinkedin({ 'jobs/view/4480758639': posting('Full Stack Developer', 'Gamma', '<p>Node.js and React.</p>'), 'jobs/view/555555': 429 });
  const added = await linkedinAdd(db, 'https://www.linkedin.com/jobs/view/4480758639/', { fetch: site.fetch, now: NOW });
  assert.deepEqual([added.added, added.title, added.company], [1, 'Full Stack Developer', 'Gamma']);
  assert.equal(typeof added.jobId, 'number');
  await assert.rejects(linkedinAdd(db, '555555', { fetch: site.fetch }), /refusing requests/);
  await assert.rejects(linkedinAdd(db, '666666', { fetch: site.fetch }), /may be closed/);
  await assert.rejects(linkedinAdd(db, 'https://example.com/x', { fetch: site.fetch }), /expected a LinkedIn job link/);
  db.close();
});

test('a block page or a sign-in redirect is reported, not stored as no results', async () => {
  const db = await setup();
  const wall = fakeLinkedin({ 'start=0': `<html><body><h1>Sign in to LinkedIn</h1><p>${'Join now to see who is hiring. '.repeat(20)}</p></body></html>` });
  await assert.rejects(linkedinSearch(db, config, { fetch: wall.fetch, pause, now: NOW }), /no jobs in it/);
  const empty = fakeLinkedin({ 'start=0': '<!DOCTYPE html>\n\n<!---->' });
  assert.equal((await linkedinSearch(db, config, { fetch: empty.fetch, pause, now: NOW })).found, 0);

  const redirected: typeof fetch = async () => {
    const res = new Response('<html></html>', { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://www.linkedin.com/authwall?trk=x' });
    return res;
  };
  await assert.rejects(linkedinAdd(db, '4480758639', { fetch: redirected }), /sign-in/);
  db.close();
});
