import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Paths } from './paths.ts';

const TASK = 'Offerstar daily';
const LABEL = 'com.offerstar.daily';
const CRON_MARK = '# offerstar-daily';
const CLI = fileURLToPath(new URL('../bin/offerstar.js', import.meta.url));

// The daily run: scan and track every morning; the Naukri refresh decides
// for itself whether it is due. Output goes to logs/daily.log.
export function dailyScript(paths: Paths, platform = process.platform): { file: string; text: string } {
  const node = process.execPath;
  const log = join(paths.logs, 'daily.log');
  const steps = ['scan', 'track', 'naukri refresh --scheduled'];
  if (platform === 'win32') {
    return {
      file: join(paths.bin, 'daily.cmd'),
      text: ['@echo off', `set "OFFERSTAR_HOME=${paths.home}"`, `echo === %DATE% %TIME% >> "${log}"`, ...steps.map((s) => `"${node}" "${CLI}" ${s} >> "${log}" 2>&1`), ''].join('\r\n'),
    };
  }
  return {
    file: join(paths.bin, 'daily.sh'),
    text: ['#!/bin/sh', `export OFFERSTAR_HOME='${paths.home}'`, `echo "=== $(date)" >> '${log}'`, ...steps.map((s) => `'${node}' '${CLI}' ${s} >> '${log}' 2>&1`), ''].join('\n'),
  };
}

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, input });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export async function installSchedule(paths: Paths, time: string): Promise<string> {
  const [hour = '8', minute = '30'] = time.split(':');
  const script = dailyScript(paths);
  await mkdir(paths.bin, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  await writeFile(script.file, script.text, { mode: 0o700 });

  if (process.platform === 'win32') {
    run('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/TN', TASK, '/TR', `"${script.file}"`, '/ST', `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`]);
    return `Task Scheduler task "${TASK}" runs every day at ${time}`;
  }
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${script.file}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict>
</dict></plist>
`,
    );
    spawnSync('launchctl', ['unload', plist]);
    run('launchctl', ['load', plist]);
    return `launchd job ${LABEL} runs every day at ${time}`;
  }
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout ?? '';
  const kept = existing.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARK));
  run('crontab', ['-'], [...kept, `${Number(minute)} ${Number(hour)} * * * /bin/sh '${script.file}' ${CRON_MARK}`, ''].join('\n'));
  return `cron runs it every day at ${time}`;
}

export async function removeSchedule(paths: Paths): Promise<void> {
  if (process.platform === 'win32') {
    spawnSync('schtasks', ['/Delete', '/F', '/TN', TASK], { windowsHide: true });
  } else if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    spawnSync('launchctl', ['unload', plist]);
    await rm(plist, { force: true });
  } else {
    const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout ?? '';
    run('crontab', ['-'], `${existing.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARK)).join('\n')}\n`);
  }
  await rm(dailyScript(paths).file, { force: true });
}
