#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { approveApplication, NeedsApproval, prepareApply, renderApplication, type ApprovalView } from './apply/application.ts';
import { DraftSchema } from './apply/draft.ts';
import { applicationStatus, insights, rateJob, recordOutcome, STAGES, type Stage } from './track/tracker.ts';
import { loadConfig, updateConfig } from './config.ts';
import { openDb } from './db.ts';
import { formatDoctor, runDoctor } from './doctor.ts';
import { initHome } from './home.ts';
import { importGithub } from './importers/github.ts';
import { importNpm } from './importers/npm.ts';
import { findBoard, listCompanies, saveCompany } from './jobs/companies.ts';
import { planShortlist, type JobRow } from './jobs/score.ts';
import { SOURCES } from './jobs/sources.ts';
import { storeJobs } from './jobs/store.ts';
import { resolvePaths } from './paths.ts';
import { EvidenceBlockSchema, loadProfile, removeBlock, writeBlock, type EvidenceBlockInput } from './profile.ts';
import { parse as parseYaml } from 'yaml';
import { buildResume } from './resume/build.ts';
import { checkResume, formatCheck, pdfText } from './resume/check.ts';

const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);
const collect = (value: string, previous: string[] = []) => [...previous, value];

const program = new Command()
  .name('offerstar')
  .description(pkg.description)
  .version(pkg.version);

program
  .command('init')
  .description('Create the Offerstar folder, default config and database, and set your details; safe to run again')
  .option('--role <role>', 'the role you are searching for')
  .option('--name <name>', 'your name, as printed on resumes')
  .option('--email <email>', 'contact email')
  .option('--phone <phone>', 'contact phone')
  .option('--location <location>', 'your city, as printed on resumes')
  .option('--link <url>', 'a profile link such as GitHub or LinkedIn (repeatable)', collect)
  .option('--json', 'print machine-readable output')
  .action(async (opts: { role?: string; name?: string; email?: string; phone?: string; location?: string; link?: string[]; json?: boolean }) => {
    const paths = resolvePaths();
    const created = await initHome(paths);
    const updates: [string[], unknown][] = [];
    if (opts.role !== undefined) updates.push([['role'], opts.role]);
    for (const key of ['name', 'email', 'phone', 'location'] as const) {
      if (opts[key] !== undefined) updates.push([['contact', key], opts[key]]);
    }
    if (opts.link) updates.push([['contact', 'links'], opts.link]);
    if (updates.length > 0) await updateConfig(paths.config, updates);

    if (opts.json) {
      console.log(JSON.stringify({ home: paths.home, created, updated: updates.map(([key]) => key.join('.')) }));
      return;
    }
    if (created.length > 0) {
      console.log(`Set up ${paths.home}:`);
      for (const path of created) console.log(`  created ${path}`);
    } else {
      console.log(`${paths.home} is already set up.`);
    }
    if (updates.length > 0) console.log(`Updated ${updates.map(([key]) => key.join('.')).join(', ')} in ${paths.config}.`);
    console.log('\nNext: run offerstar doctor.');
  });

program
  .command('config')
  .description('Read or change config.yaml')
  .command('set <key> <value>')
  .description('Set a value by dotted key, e.g. experienceYears 3 or contact.phone "+91 ..."; refuses invalid values')
  .action(async (key: string, value: string) => {
    const paths = resolvePaths();
    await updateConfig(paths.config, [[key.split('.'), parseYaml(value)]]);
    console.log(`Set ${key} in ${paths.config}.`);
  });

const profileCmd = program.command('profile').description('Your evidence blocks');

profileCmd
  .command('list')
  .description('List evidence blocks, and any that fail validation')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const profile = await loadProfile(resolvePaths().profile);
    if (opts.json) return console.log(JSON.stringify(profile));
    for (const b of profile.blocks) console.log(`${b.id.padEnd(32)} ${b.type.padEnd(13)} ${b.title}${b.organization ? `, ${b.organization}` : ''}`);
    for (const p of profile.problems) console.log(`problem: ${p.file}: ${p.message}`);
    console.log(`\n${profile.blocks.length} blocks, profile ${profile.hash}`);
  });

profileCmd
  .command('add <file>')
  .description('Validate an evidence block (YAML or JSON) and save it; use it only for facts the user confirmed')
  .option('--replace', 'overwrite an existing block with the same id')
  .action(async (file: string, opts: { replace?: boolean }) => {
    const paths = resolvePaths();
    const block = EvidenceBlockSchema.parse(parseYaml(await readFile(file, 'utf8')));
    if (opts.replace) await removeBlock(paths.profile, block.id);
    const path = await writeBlock(paths.profile, block);
    if (!path) throw new Error(`a block with id ${block.id} already exists; pass --replace to overwrite it`);
    console.log(`Saved ${block.id} to ${path}.`);
  });

profileCmd
  .command('remove <id>')
  .description('Delete an evidence block')
  .action(async (id: string) => {
    if (!(await removeBlock(resolvePaths().profile, id))) throw new Error(`no block with id ${id}`);
    console.log(`Removed ${id}.`);
  });

const importer = program.command('import').description('Pull evidence into your profile from public sources');

async function saveBlocks(blocks: EvidenceBlockInput[], opts: { dryRun?: boolean; json?: boolean }) {
  const paths = resolvePaths();
  const written: string[] = [];
  const skipped: string[] = [];
  for (const block of blocks) {
    if (opts.dryRun) continue;
    const path = await writeBlock(paths.profile, block);
    (path ? written : skipped).push(block.id);
  }
  if (opts.json) {
    console.log(JSON.stringify(opts.dryRun ? { blocks } : { written, skipped }));
  } else if (opts.dryRun) {
    for (const b of blocks) console.log(`${b.id}  ${b.summary || b.title}`);
    console.log(`\n${blocks.length} blocks found; nothing written (dry run).`);
  } else {
    console.log(`Wrote ${written.length} new blocks to ${paths.profile}; kept ${skipped.length} that already existed.`);
    if (written.length > 0) console.log('Review them: delete any project you would not put on a resume, and add highlights you can back up.');
  }
}

importer
  .command('github <user>')
  .description('One project block per public repository you own (set GITHUB_TOKEN to raise the rate limit)')
  .option('--include-forks', 'also import forked repositories')
  .option('--include-archived', 'also import archived repositories')
  .option('--dry-run', 'show the blocks without writing them')
  .option('--json', 'print machine-readable output')
  .action(async (user: string, opts: { includeForks?: boolean; includeArchived?: boolean; dryRun?: boolean; json?: boolean }) => {
    const blocks = await importGithub(user, { ...opts, token: process.env.GITHUB_TOKEN });
    await saveBlocks(blocks, opts);
  });

importer
  .command('npm <user>')
  .description('One project block per npm package you maintain')
  .option('--dry-run', 'show the blocks without writing them')
  .option('--json', 'print machine-readable output')
  .action(async (user: string, opts: { dryRun?: boolean; json?: boolean }) => {
    await saveBlocks(await importNpm(user), opts);
  });

importer
  .command('cv <pdf>')
  .description('Print the text of an existing CV, for the setup skill to turn into evidence blocks')
  .option('--json', 'print machine-readable output')
  .action(async (file: string, opts: { json?: boolean }) => {
    const { pages, text } = await pdfText(new Uint8Array(await readFile(file)));
    console.log(opts.json ? JSON.stringify({ pages, text }) : text);
  });

const resume = program.command('resume').description('Build resumes from your evidence blocks');

resume
  .command('build')
  .description('Render a resume PDF from your evidence blocks (all of them unless --blocks is given)')
  .option('--blocks <ids>', 'comma-separated block ids, in the order to consider them', list)
  .option('--out <file>', 'where to write the PDF (default: resumes/ in the Offerstar folder)')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { blocks?: string[]; out?: string; json?: boolean }) => {
    const paths = resolvePaths();
    const [config, profile] = await Promise.all([loadConfig(paths.config), loadProfile(paths.profile)]);
    if (profile.problems.length > 0) throw new Error('fix the evidence blocks offerstar doctor lists first');
    const built = await buildResume(paths, config, profile, {
      blockIds: opts.blocks,
      out: opts.out,
      log: (line) => console.error(line),
    });
    console.log(opts.json ? JSON.stringify(built) : `Built ${built.path} from ${built.blockIds.length} blocks.\nNext: offerstar check "${built.path}"`);
  });

program
  .command('check <pdf>')
  .description('Round-trip parse test: what an ATS reads from the PDF, compared with your evidence')
  .option('--keywords <terms>', 'comma-separated terms from a posting, to report coverage', list)
  .option('--blocks <ids>', 'blocks the resume should contain (default: the ones recorded when it was built)', list)
  .option('--json', 'print machine-readable output')
  .action(async (file: string, opts: { keywords?: string[]; blocks?: string[]; json?: boolean }) => {
    const paths = resolvePaths();
    const bytes = new Uint8Array(await readFile(file));
    const config = await loadConfig(paths.config).catch(() => undefined);
    const profile = await loadProfile(paths.profile);

    let blockIds = opts.blocks;
    if (!blockIds) {
      const db = openDb(paths.db);
      const fileHash = createHash('sha256').update(bytes).digest('hex');
      const row = db.prepare('SELECT block_ids FROM resume_versions WHERE file_hash = ?').get(fileHash) as { block_ids: string } | undefined;
      db.close();
      if (row) blockIds = JSON.parse(row.block_ids) as string[];
    }
    const blocks = blockIds ? profile.blocks.filter((b) => blockIds.includes(b.id)) : undefined;

    const report = await checkResume(bytes, { config, blocks, keywords: opts.keywords });
    console.log(opts.json ? JSON.stringify(report) : formatCheck(report));
    if (!report.ok) process.exitCode = 1;
  });

const companies = program.command('companies').description('The companies whose job boards Offerstar tracks');

companies
  .command('add <nameOrUrl>')
  .description("Find a company's job board (Greenhouse, Lever, Ashby or JobPosting data on its careers page) and track it")
  .option('--name <name>', 'the company name to store, if different from what was found')
  .option('--json', 'print machine-readable output')
  .action(async (input: string, opts: { name?: string; json?: boolean }) => {
    const board = await findBoard(input, { name: opts.name });
    const db = openDb(resolvePaths().db);
    const company = saveCompany(db, board);
    db.close();
    console.log(opts.json ? JSON.stringify({ ...company, openJobs: board.openJobs }) : `Tracking ${company.name}: ${board.ats} board "${board.token}", ${board.openJobs} open jobs.`);
  });

companies
  .command('list')
  .description('List tracked companies')
  .option('--json', 'print machine-readable output')
  .action((opts: { json?: boolean }) => {
    const db = openDb(resolvePaths().db);
    const rows = listCompanies(db);
    db.close();
    if (opts.json) return console.log(JSON.stringify(rows));
    for (const c of rows) console.log(`${c.name.padEnd(28)} ${c.ats.padEnd(10)} ${c.board_token}  last checked ${c.last_checked_at ?? 'never'}`);
    if (rows.length === 0) console.log('No companies yet. Add one with: offerstar companies add <name or careers URL>');
  });

program
  .command('scan')
  .description('Fetch new jobs from every tracked company, clean them through the posting guard and dedupe them')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const db = openDb(resolvePaths().db);
    const results: Record<string, unknown>[] = [];
    try {
      for (const company of listCompanies(db)) {
        const now = new Date().toISOString();
        try {
          const jobs = await SOURCES[company.ats](company.board_token, {});
          const stored = storeJobs(db, { companyId: company.id, companyName: company.name, source: company.ats }, jobs, { now, closeMissing: true });
          db.prepare('UPDATE companies SET last_checked_at = ? WHERE id = ?').run(now, company.id);
          results.push({ company: company.name, ...stored });
          if (!opts.json) {
            const flagged = stored.flagged ? `, ${stored.flagged} flagged by the posting guard` : '';
            console.log(`${company.name}: ${stored.added} new, ${stored.updated} updated, ${stored.duplicates} duplicates, ${stored.closed} closed${flagged}`);
          }
        } catch (err) {
          results.push({ company: company.name, error: (err as Error).message });
          if (!opts.json) console.log(`${company.name}: failed, ${(err as Error).message}`);
        }
      }
      db.prepare("INSERT INTO events (kind, data) VALUES ('scan', ?)").run(JSON.stringify(results));
    } finally {
      db.close();
    }
    if (opts.json) console.log(JSON.stringify(results));
    else if (results.length === 0) console.log('No companies to scan. Add one with: offerstar companies add <name or careers URL>');
  });

program
  .command('paste [file]')
  .description('Add a posting you copied from Naukri, LinkedIn, email or WhatsApp (reads stdin without a file)')
  .requiredOption('--title <title>', 'job title')
  .requiredOption('--company <company>', 'company name')
  .option('--location <location>', 'job location')
  .option('--url <url>', 'where the posting came from')
  .option('--json', 'print machine-readable output')
  .action(async (file: string | undefined, opts: { title: string; company: string; location?: string; url?: string; json?: boolean }) => {
    const text = file ? await readFile(file, 'utf8') : await new Response(Readable.toWeb(process.stdin) as ReadableStream).text();
    if (!text.trim()) throw new Error('the posting is empty');
    const sourceId = createHash('sha256').update(`${opts.company}\n${opts.title}\n${text}`).digest('hex').slice(0, 16);
    const db = openDb(resolvePaths().db);
    const stored = storeJobs(db, { companyId: null, companyName: opts.company, source: 'paste' }, [
      { sourceId, title: opts.title, company: opts.company, location: opts.location, url: opts.url, postedAt: new Date().toISOString(), text },
    ]);
    const job = db.prepare("SELECT id, guard_flags FROM jobs WHERE source = 'paste' AND source_id = ?").get(sourceId) as { id: number; guard_flags: string } | undefined;
    db.close();
    const flags = job ? (JSON.parse(job.guard_flags) as string[]) : [];
    if (opts.json) return console.log(JSON.stringify({ jobId: job?.id ?? null, ...stored, flags }));
    console.log(stored.duplicates ? 'Already known from another source; nothing added.' : `Saved as job ${job?.id}.`);
    for (const f of flags) console.log(`  posting guard: instruction-like line: "${f}"`);
  });

program
  .command('plan')
  .description('Score open jobs against your profile and print the shortlist')
  .option('--limit <n>', 'how many jobs to show', (v) => Number.parseInt(v, 10), 20)
  .option('--min-score <n>', 'hide jobs scoring below this (0-100)', (v) => Number.parseInt(v, 10), 0)
  .option('--json', 'print machine-readable output')
  .action(async (opts: { limit: number; minScore: number; json?: boolean }) => {
    const paths = resolvePaths();
    const [config, profile] = await Promise.all([loadConfig(paths.config), loadProfile(paths.profile)]);
    const db = openDb(paths.db);
    const shortlist = planShortlist(db, config, profile, { limit: opts.limit, minScore: opts.minScore });
    db.close();

    if (opts.json) {
      return console.log(
        JSON.stringify(shortlist.map(({ job, total, parts, matched, gaps }) => ({ jobId: job.id, title: job.title, company: job.company_name, location: job.location, url: job.url, score: total, parts, matched, gaps, guardFlags: JSON.parse(job.guard_flags) }))),
      );
    }
    if (shortlist.length === 0) return console.log('No open jobs to rank yet. Run offerstar scan first.');
    shortlist.forEach(({ job, total, matched, gaps }, i) => {
      console.log(`${String(i + 1).padStart(2)}. [${String(total).padStart(3)}] ${job.title}, ${job.company_name}${job.location ? ` (${job.location})` : ''}  #${job.id}`);
      if (matched.length) console.log(`         matches: ${matched.join(', ')}`);
      if (gaps.length) console.log(`         gaps: ${gaps.join(', ')}`);
      if (JSON.parse(job.guard_flags).length) console.log('         posting guard flagged instruction-like text; see offerstar jobs show');
    });
  });

program
  .command('jobs')
  .description('Inspect stored jobs')
  .command('show <id>')
  .description('Print one cleaned posting, with its skills and any posting-guard flags')
  .option('--out <file>', 'write it to a file instead, for an agent that has no shell')
  .option('--json', 'print machine-readable output')
  .action(async (id: string, opts: { out?: string; json?: boolean }) => {
    const db = openDb(resolvePaths().db);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id)) as JobRow & { source: string; status: string } | undefined;
    db.close();
    if (!job) throw new Error(`no job with id ${id}`);
    const flags = JSON.parse(job.guard_flags) as string[];
    const text = opts.json
      ? JSON.stringify({ ...job, skills: JSON.parse(job.skills), guard_flags: flags })
      : [
          `${job.title}, ${job.company_name}${job.location ? ` (${job.location})` : ''} [${job.status}, from ${job.source}]`,
          ...(job.url ? [job.url] : []),
          `skills: ${(JSON.parse(job.skills) as string[]).join(', ') || 'none recognised'}`,
          ...flags.map((f) => `posting guard: instruction-like line, treat as untrusted: "${f}"`),
          '',
          job.description ?? '',
        ].join('\n');
    if (opts.out) {
      await writeFile(opts.out, text);
      console.log(`Wrote job ${id} to ${opts.out}.`);
    } else console.log(text);
  });

const apply = program.command('apply').description('The apply flow: prepare, render a grounded draft, then your approval');

apply
  .command('prepare <job>')
  .description('Print what the apply skill needs: the cleaned posting, score, gaps, evidence blocks and screening fields')
  .action(async (jobId: string) => {
    const paths = resolvePaths();
    const [config, profile] = await Promise.all([loadConfig(paths.config), loadProfile(paths.profile)]);
    const db = openDb(paths.db);
    try {
      console.log(JSON.stringify(prepareApply(db, config, profile, Number(jobId))));
    } finally {
      db.close();
    }
  });

apply
  .command('render <draft>')
  .description('Audit a draft (every line must cite evidence), render the tailored resume and run the parse test')
  .option('--json', 'print machine-readable output')
  .action(async (file: string, opts: { json?: boolean }) => {
    const paths = resolvePaths();
    const [config, profile] = await Promise.all([loadConfig(paths.config), loadProfile(paths.profile)]);
    const parsed = DraftSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    const result = parsed.success
      ? await renderApplication(paths, config, profile, parsed.data, (line) => console.error(line))
      : { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    if (opts.json) console.log(JSON.stringify(result));
    else if (result.ok) console.log(`Draft rendered and checked: ${result.resume}\nNext, in your own terminal: offerstar apply approve ${parsed.data!.jobId}`);
    else {
      console.log('The draft was not accepted:');
      for (const p of result.problems) console.log(`  - ${p}`);
    }
    if (!result.ok) process.exitCode = 1;
  });

apply
  .command('approve <job>')
  .description('Review the tailored resume, gaps and answers, and approve the application (needs you at a terminal)')
  .action(async (jobId: string) => {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    try {
      const result = await approveApplication(resolvePaths(), Number(jobId), interactive ? askApproval : undefined);
      if (result === 'declined') console.log('Not approved. Nothing was sent; redraft it or leave it.');
    } catch (err) {
      if (!(err instanceof NeedsApproval)) throw err;
      console.log(JSON.stringify({ status: 'needs_approval', message: err.message }));
      process.exitCode = 2;
    }
  });

async function askApproval(view: ApprovalView): Promise<boolean> {
  const { job } = view;
  console.log(`\n${job.title}, ${job.company_name}${job.location ? ` (${job.location})` : ''}`);
  if (job.url) console.log(job.url);
  console.log(`\nResume:      ${view.resume}`);
  if (view.coverNote) console.log(`Cover note:  ${join(view.folder, 'cover-note.txt')}`);
  if (view.gaps.length) console.log(`Gaps (not claimed): ${view.gaps.join(', ')}`);
  for (const f of view.guardFlags) console.log(`Posting guard flagged: "${f}"`);
  if (view.answers.length) {
    console.log('\nScreening answers:');
    for (const a of view.answers) console.log(`  ${a.question}\n    -> ${a.answer}`);
  }
  console.log('\nOpen the resume and read it before you answer.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Approve, and submit it yourself on the page above now? [y/N] ');
  rl.close();
  const yes = /^y(es)?$/i.test(answer.trim());
  if (yes) console.log(`\nApproved and recorded as applied. Submit ${view.resume} at ${job.url ?? 'the company careers page'}.`);
  return yes;
}

program
  .command('fit-notes <file>')
  .description("Save the scorer agent's fit notes: a JSON list of { jobId, notes }")
  .action(async (file: string) => {
    const paths = resolvePaths();
    const notes = z.array(z.object({ jobId: z.number().int(), notes: z.string().min(1) })).parse(JSON.parse(await readFile(file, 'utf8')));
    const profile = await loadProfile(paths.profile);
    const db = openDb(paths.db);
    const save = db.prepare('UPDATE scores SET fit_notes = ? WHERE job_id = ? AND profile_hash = ?');
    const saved = notes.filter((n) => Number(save.run(n.notes, n.jobId, profile.hash).changes) > 0).length;
    db.close();
    console.log(`Saved fit notes for ${saved} of ${notes.length} jobs${saved < notes.length ? '; run offerstar plan first for the rest' : ''}.`);
  });

program
  .command('status')
  .description('Applications by stage, follow-ups due, and applied jobs that have closed')
  .option('--json', 'print machine-readable output')
  .action((opts: { json?: boolean }) => {
    const db = openDb(resolvePaths().db);
    const s = applicationStatus(db);
    db.close();
    if (opts.json) return console.log(JSON.stringify(s));
    const stages = Object.entries(s.byStage);
    if (stages.length === 0) return console.log('No applications yet.');
    console.log(stages.map(([stage, n]) => `${stage}: ${n}`).join('  |  '));
    const show = (label: string, rows: typeof s.drafts) => {
      if (!rows.length) return;
      console.log(`\n${label}:`);
      for (const r of rows) console.log(`  #${r.job_id} ${r.title}, ${r.company_name} (${r.stage} since ${r.updated_at.slice(0, 10)})`);
    };
    show('Drafts waiting for your approval', s.drafts);
    show('Follow up (a week without news)', s.followUps);
    show('No reply for 21+ days; record it with offerstar outcome <job> no_reply', s.noReply);
    show('The posting has closed', s.closedWhileOpen);
  });

program
  .command('outcome <job> <stage>')
  .description(`Record what happened: ${STAGES.join(', ')}`)
  .option('--ctc <lpa>', 'offered CTC in lakh per annum', Number.parseFloat)
  .option('--round <type>', 'interview round, e.g. "technical 1" (records the round)')
  .option('--question <text>', 'a question you were asked (repeatable)', collect)
  .option('--rating <1-5>', 'your own rating of the round', (v) => Number.parseInt(v, 10))
  .option('--notes <text>', 'notes on the round')
  .action((jobId: string, stage: string, opts: { ctc?: number; round?: string; question?: string[]; rating?: number; notes?: string }) => {
    if (!(STAGES as readonly string[]).includes(stage)) throw new Error(`stage must be one of ${STAGES.join(', ')}`);
    if (opts.rating !== undefined && !(opts.rating >= 1 && opts.rating <= 5)) throw new Error('rating must be 1 to 5');
    const db = openDb(resolvePaths().db);
    try {
      recordOutcome(db, Number(jobId), {
        stage: stage as Stage,
        offeredCtcLpa: opts.ctc,
        round: opts.round ? { type: opts.round, questions: opts.question ?? [], rating: opts.rating, notes: opts.notes } : undefined,
      });
    } finally {
      db.close();
    }
    console.log(`Recorded job ${jobId} as ${stage}${opts.round ? `, with the ${opts.round} round` : ''}.`);
  });

program
  .command('rate <job> <verdict>')
  .description('Your quick good or bad verdict on a shortlisted job')
  .action((jobId: string, verdict: string) => {
    if (verdict !== 'good' && verdict !== 'bad') throw new Error('verdict must be good or bad');
    const db = openDb(resolvePaths().db);
    try {
      rateJob(db, Number(jobId), verdict);
    } finally {
      db.close();
    }
    console.log(`Rated job ${jobId} ${verdict}.`);
  });

program
  .command('insights')
  .description('Funnel and call rates by channel, role match, seniority, company type, resume variant and posting age')
  .option('--json', 'print machine-readable output')
  .action((opts: { json?: boolean }) => {
    const db = openDb(resolvePaths().db);
    const report = insights(db);
    db.close();
    if (opts.json) return console.log(JSON.stringify(report));
    const { funnel } = report;
    console.log(`Applied ${funnel.applied} -> calls ${funnel.calls} -> interviews ${funnel.interviews} -> offers ${funnel.offers}`);
    console.log(`Ratings: ${report.ratings.good} good, ${report.ratings.bad} bad`);
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    for (const [name, groups] of Object.entries(report.groups)) {
      if (!groups.length) continue;
      console.log(`\n${name.replace(/_/g, ' ')}:`);
      for (const g of groups) {
        const thin = g.applied < report.minGroupSize ? '  (too few to act on)' : '';
        console.log(`  ${g.value.padEnd(16)} ${g.calls}/${g.applied} calls, ${pct(g.rate)} (likely ${pct(g.low)}-${pct(g.high)})${thin}`);
      }
    }
  });

program
  .command('doctor')
  .description('Check the install, the Offerstar folder and optional tools')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const report = await runDoctor(resolvePaths());
    console.log(opts.json ? JSON.stringify(report) : formatDoctor(report));
    if (!report.ok) process.exitCode = 1;
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`offerstar: ${(err as Error).message}`);
  process.exitCode = 1;
}
