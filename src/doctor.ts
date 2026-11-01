import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { openDb, SCHEMA_VERSION, schemaVersion } from './db.ts';
import type { Paths } from './paths.ts';
import { loadProfile } from './profile.ts';
import { localTypst, TYPST_VERSION, typstVersion } from './resume/typst.ts';
import { isInstalled, NOPERI_COMMIT, readEnv } from './naukri/addon.ts';
import { isOwnerOnly } from './secure.ts';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

const MIN_NODE = [22, 18] as const;

function toolVersion(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim().split(/\r?\n/)[0];
}

function checkNode(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return supported
    ? { id: 'node', status: 'ok', detail: `Node ${process.versions.node}` }
    : {
        id: 'node',
        status: 'fail',
        detail: `Node ${process.versions.node} is too old`,
        fix: `install Node ${MIN_NODE.join('.')} or newer`,
      };
}

async function checkHome(paths: Paths): Promise<Check> {
  try {
    await access(paths.home, constants.R_OK | constants.W_OK);
    return { id: 'home', status: 'ok', detail: paths.home };
  } catch {
    return { id: 'home', status: 'fail', detail: `${paths.home} is missing or not writable`, fix: 'run offerstar init' };
  }
}

async function checkConfig(paths: Paths): Promise<Check> {
  try {
    const config = await loadConfig(paths.config);
    return config.role
      ? { id: 'config', status: 'ok', detail: `searching for "${config.role}"` }
      : { id: 'config', status: 'warn', detail: 'no role set yet', fix: `set role in ${paths.config}` };
  } catch (err) {
    return { id: 'config', status: 'fail', detail: `${paths.config}: ${(err as Error).message}`, fix: 'fix the file, or delete it and run offerstar init' };
  }
}

async function checkProfile(paths: Paths): Promise<Check> {
  const profile = await loadProfile(paths.profile);
  if (profile.problems.length > 0) {
    return {
      id: 'profile',
      status: 'fail',
      detail: profile.problems.map((p) => `${p.file}: ${p.message}`).join('\n'),
      fix: 'fix or remove the blocks listed',
    };
  }
  return profile.blocks.length === 0
    ? { id: 'profile', status: 'warn', detail: 'no evidence blocks yet' }
    : { id: 'profile', status: 'ok', detail: `${profile.blocks.length} evidence blocks, profile ${profile.hash}` };
}

function checkDatabase(paths: Paths): Check {
  if (!existsSync(paths.db)) {
    return { id: 'database', status: 'fail', detail: `${paths.db} is missing`, fix: 'run offerstar init' };
  }
  try {
    const db = openDb(paths.db, { migrate: false });
    try {
      const version = schemaVersion(db);
      if (version === SCHEMA_VERSION) return { id: 'database', status: 'ok', detail: `schema version ${version}` };
      return version < SCHEMA_VERSION
        ? { id: 'database', status: 'fail', detail: `schema version ${version}, expected ${SCHEMA_VERSION}`, fix: 'run offerstar init to upgrade it' }
        : { id: 'database', status: 'fail', detail: `schema version ${version} is newer than this offerstar`, fix: 'update offerstar' };
    } finally {
      db.close();
    }
  } catch (err) {
    return { id: 'database', status: 'fail', detail: (err as Error).message };
  }
}

async function checkSecrets(paths: Paths): Promise<Check> {
  if (!existsSync(paths.env)) return { id: 'secrets', status: 'skip', detail: 'no .env file yet' };
  return (await isOwnerOnly(paths.env))
    ? { id: 'secrets', status: 'ok', detail: '.env is readable only by you' }
    : { id: 'secrets', status: 'fail', detail: `${paths.env} can be read by other accounts`, fix: 'run offerstar init to lock it down' };
}

function checkTool(id: string, command: string, missing: Omit<Check, 'id'>): Check {
  const version = toolVersion(command);
  return version ? { id, status: 'ok', detail: version } : { id, ...missing };
}

function checkTypst(paths: Paths): Check {
  const version = typstVersion('typst') ?? (existsSync(localTypst(paths)) ? typstVersion(localTypst(paths)) : undefined);
  return version
    ? { id: 'typst', status: 'ok', detail: version }
    : { id: 'typst', status: 'skip', detail: `not installed; Typst ${TYPST_VERSION} is downloaded on the first resume build` };
}

async function checkNaukri(paths: Paths): Promise<Check> {
  const config = await loadConfig(paths.config).catch(() => undefined);
  if (!config?.naukri.enabled) return { id: 'naukri', status: 'skip', detail: 'add-on not enabled (optional)' };
  if (!isInstalled(paths)) return { id: 'naukri', status: 'fail', detail: 'enabled in config.yaml but not installed', fix: 'run offerstar setup naukri' };
  const env = await readEnv(paths);
  if (!env.NAUKRI_USERNAME || !env.NAUKRI_PASSWORD) return { id: 'naukri', status: 'fail', detail: 'no Naukri login saved', fix: 'run offerstar naukri login' };
  return { id: 'naukri', status: 'ok', detail: `installed, NopeRi ${NOPERI_COMMIT.slice(0, 7)}` };
}

export async function runDoctor(paths: Paths): Promise<DoctorReport> {
  const checks: Check[] = [checkNode(), await checkHome(paths)];
  if (checks[1]!.status === 'ok') {
    checks.push(await checkConfig(paths), await checkProfile(paths), checkDatabase(paths), await checkSecrets(paths), await checkNaukri(paths));
  }
  checks.push(
    checkTool('claude', 'claude', {
      status: 'warn',
      detail: 'Claude Code not found on PATH; AI steps need it or an API key',
      fix: 'install Claude Code: https://claude.com/claude-code',
    }),
    checkTypst(paths),
    checkTool('uv', 'uv', { status: 'skip', detail: 'not installed; needed only for the Naukri and OCR add-ons' }),
  );
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

const LABELS: Record<Status, string> = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]', skip: '[skip]' };

export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const [first, ...rest] = c.detail.split('\n');
    const out = [`${LABELS[c.status]} ${c.id.padEnd(9)} ${first}`, ...rest.map((l) => `${' '.repeat(17)}${l}`)];
    if (c.fix) out.push(`${' '.repeat(17)}fix: ${c.fix}`);
    return out.join('\n');
  });
  lines.push('', report.ok ? 'All required checks passed.' : 'Some checks failed.');
  return lines.join('\n');
}
