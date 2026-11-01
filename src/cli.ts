#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig, updateConfig } from './config.ts';
import { openDb } from './db.ts';
import { formatDoctor, runDoctor } from './doctor.ts';
import { initHome } from './home.ts';
import { importGithub } from './importers/github.ts';
import { importNpm } from './importers/npm.ts';
import { resolvePaths } from './paths.ts';
import { loadProfile, writeBlock, type EvidenceBlockInput } from './profile.ts';
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
