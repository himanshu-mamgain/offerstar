import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Paths } from '../paths.ts';
import { isOwnerOnly, restrictToOwner } from '../secure.ts';

// NopeRi has no licence, so Offerstar never ships its code: setup downloads
// this exact commit from GitHub onto the user's machine.
export const NOPERI_REPO = 'Traverser25/NopeRi';
export const NOPERI_COMMIT = '8c3d7f55ee34d4ea6fabd950598b66628b49db41';

// Only what the bridge's code paths import; Selenium is left out.
const PACKAGES = ['requests', 'urllib3', 'pycryptodome', 'httpcloak==1.6.1', 'curl_cffi==0.15.0'];

const BRIDGE_SOURCE = fileURLToPath(new URL('../../addons/naukri/bridge.py', import.meta.url));

export function addonDir(paths: Paths) {
  const dir = join(paths.addons, 'naukri');
  return {
    dir,
    bridge: join(dir, 'bridge.py'),
    nopeRi: join(dir, 'NopeRi'),
    python: process.platform === 'win32' ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python'),
  };
}

export function isInstalled(paths: Paths): boolean {
  const a = addonDir(paths);
  return existsSync(a.python) && existsSync(a.bridge) && existsSync(join(a.nopeRi, 'src', 'client', 'naukri_client.py'));
}

function run(command: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (result.error) throw result.error;
  return result;
}

export async function setupNaukri(paths: Paths, log: (line: string) => void = () => {}): Promise<void> {
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (uv.error || uv.status !== 0) {
    throw new Error(
      process.platform === 'win32'
        ? 'uv is not installed. Install it with: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : 'uv is not installed. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh',
    );
  }
  const a = addonDir(paths);
  await mkdir(a.dir, { recursive: true });

  log('Creating a Python environment with uv...');
  const venv = run('uv', ['venv', '--python', '3.12', join(a.dir, '.venv')]);
  if (venv.status !== 0 && !existsSync(a.python)) throw new Error(`uv venv failed: ${venv.stderr.trim()}`);

  log(`Downloading NopeRi at ${NOPERI_COMMIT.slice(0, 7)} from GitHub...`);
  const res = await fetch(`https://codeload.github.com/${NOPERI_REPO}/zip/${NOPERI_COMMIT}`);
  if (!res.ok) throw new Error(`NopeRi download failed: ${res.status} ${res.statusText}`);
  const zip = join(a.dir, 'noperi.zip');
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  await rm(a.nopeRi, { recursive: true, force: true });
  // Python's zipfile unpacks it the same way on every OS.
  const unzip = run(a.python, ['-I', '-c', 'import sys,zipfile,shutil,pathlib;d=pathlib.Path(sys.argv[2]);zipfile.ZipFile(sys.argv[1]).extractall(d.parent/"_noperi");top=next((d.parent/"_noperi").iterdir());shutil.move(str(top),str(d));shutil.rmtree(d.parent/"_noperi")', zip, a.nopeRi]);
  if (unzip.status !== 0) throw new Error(`could not unpack NopeRi: ${unzip.stderr.trim()}`);
  await rm(zip, { force: true });

  log('Installing its Python packages...');
  const pip = run('uv', ['pip', 'install', '--python', a.python, ...PACKAGES]);
  if (pip.status !== 0) throw new Error(`installing packages failed: ${pip.stderr.trim()}`);

  await copyFile(BRIDGE_SOURCE, a.bridge);
}

// ~/.offerstar/.env as key=value lines, kept readable only by the user.
export async function readEnv(paths: Paths): Promise<Record<string, string>> {
  if (!existsSync(paths.env)) return {};
  const env: Record<string, string> = {};
  for (const line of (await readFile(paths.env, 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return env;
}

export async function writeEnv(paths: Paths, values: Record<string, string>): Promise<void> {
  const env = { ...(await readEnv(paths)), ...values };
  await writeFile(paths.env, `${Object.entries(env).map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`).join('\n')}\n`, { mode: 0o600 });
  if (!(await isOwnerOnly(paths.env))) await restrictToOwner(paths.env);
}

export type BridgeRunner = (command: string, payload: unknown) => Promise<unknown>;

// Runs one bridge command with the stored credentials. The credentials go
// to the bridge process only, never into logs or to Claude.
export function bridgeRunner(paths: Paths): BridgeRunner {
  return async (command, payload) => {
    if (!isInstalled(paths)) throw new Error('the Naukri add-on is not installed; run offerstar setup naukri');
    const env = await readEnv(paths);
    const a = addonDir(paths);
    const result = run(a.python, ['-I', '-X', 'utf8', a.bridge, command], {
      input: JSON.stringify(payload ?? {}),
      cwd: a.dir,
      env: { ...process.env, NAUKRI_USERNAME: env.NAUKRI_USERNAME ?? '', NAUKRI_PASSWORD: env.NAUKRI_PASSWORD ?? '' },
    });
    const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    let out: { error?: string };
    try {
      out = JSON.parse(line) as { error?: string };
    } catch {
      throw new Error(`the Naukri add-on failed: ${(result.stderr || result.stdout).trim().slice(-500)}`);
    }
    if (out.error) throw new Error(`Naukri: ${out.error}`);
    return out;
  };
}
