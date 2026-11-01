#!/usr/bin/env node
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { formatDoctor, runDoctor } from './doctor.ts';
import { initHome } from './home.ts';
import { resolvePaths } from './paths.ts';

const program = new Command()
  .name('offerstar')
  .description(pkg.description)
  .version(pkg.version);

program
  .command('init')
  .description('Create the Offerstar folder, default config and database; safe to run again')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const paths = resolvePaths();
    const created = await initHome(paths);
    if (opts.json) {
      console.log(JSON.stringify({ home: paths.home, created }));
    } else if (created.length === 0) {
      console.log(`${paths.home} is already set up.`);
    } else {
      console.log(`Set up ${paths.home}:`);
      for (const path of created) console.log(`  created ${path}`);
      console.log(`\nNext: set your role in ${paths.config}, then run offerstar doctor.`);
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

await program.parseAsync();
