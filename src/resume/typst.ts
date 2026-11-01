import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paths } from '../paths.ts';

export const TYPST_VERSION = '0.15.1';

// SHA-256 digests GitHub publishes for the v0.15.1 release assets.
const ASSETS: Record<string, { name: string; sha256: string }> = {
  'win32-x64': { name: 'typst-x86_64-pc-windows-msvc.zip', sha256: '19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736' },
  'win32-arm64': { name: 'typst-aarch64-pc-windows-msvc.zip', sha256: '4ab28e1b71ec3184d38d580ab797f499b6770d952b6b19167be5cea5c2662e14' },
  'darwin-x64': { name: 'typst-x86_64-apple-darwin.tar.xz', sha256: '7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa' },
  'darwin-arm64': { name: 'typst-aarch64-apple-darwin.tar.xz', sha256: '48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a' },
  'linux-x64': { name: 'typst-x86_64-unknown-linux-musl.tar.xz', sha256: 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c' },
  'linux-arm64': { name: 'typst-aarch64-unknown-linux-musl.tar.xz', sha256: '5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee' },
};

const exe = process.platform === 'win32' ? 'typst.exe' : 'typst';

export function localTypst(paths: Paths): string {
  return join(paths.bin, `typst-${TYPST_VERSION}`, exe);
}

export function typstVersion(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

// Prefers a typst already on PATH, then the copy in ~/.offerstar/bin,
// and downloads the pinned release only when neither exists.
export async function ensureTypst(paths: Paths, log: (line: string) => void = () => {}): Promise<string> {
  if (typstVersion('typst')) return 'typst';
  const local = localTypst(paths);
  if (existsSync(local)) return local;

  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`no Typst build for ${process.platform}-${process.arch}; install Typst yourself and put it on PATH`);

  log(`Downloading Typst ${TYPST_VERSION} (first resume build only)...`);
  const res = await fetch(`https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${asset.name}`);
  if (!res.ok) throw new Error(`Typst download failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`Typst download has the wrong checksum (${digest}); not using it`);

  const dir = join(paths.bin, `typst-${TYPST_VERSION}`);
  // A staging folder of its own, so two offerstar processes downloading at
  // once (the morning schedule and a manual run) never share one.
  const staging = `${dir}.download-${process.pid}-${randomBytes(4).toString('hex')}`;
  await mkdir(staging, { recursive: true });
  try {
    const archive = join(staging, asset.name);
    await writeFile(archive, bytes);
    // On Windows, use the system bsdtar, which reads .zip: Git for Windows puts
    // GNU tar on PATH, and GNU tar can't, and reads "C:" as a remote host.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const result = spawnSync(tar, ['-xf', archive, '-C', staging], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`could not unpack Typst: ${(result.stderr || '').trim()}`);

    const found = await findFile(staging, exe);
    if (!found) throw new Error('Typst archive did not contain the typst binary');
    await mkdir(dir, { recursive: true });
    try {
      await rename(found, local);
    } catch (err) {
      // Another process installed it first; theirs is the same verified build.
      if (!existsSync(local)) throw err;
    }
    return local;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}
