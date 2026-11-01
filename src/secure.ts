import { spawnSync } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';

// Limits a secrets file to the current user: mode 600 on macOS and Linux,
// an explicit access rule for this account only on Windows.
export async function restrictToOwner(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    return;
  }
  const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`icacls failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

export async function isOwnerOnly(file: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return ((await stat(file)).mode & 0o077) === 0;
  }
  const result = spawnSync('icacls', [file], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  // Each rule line looks like "DOMAIN\user:(F)"; the first one also starts with the file path.
  const principals = result.stdout
    .split(/\r?\n/)
    .map((line) => (line.startsWith(file) ? line.slice(file.length) : line).trim())
    .filter((line) => /:\(.*\)/.test(line))
    .map((line) => line.slice(0, line.indexOf(':(')).toLowerCase());
  const me = userInfo().username.toLowerCase();
  return principals.length > 0 && principals.every((p) => p === me || p.endsWith(`\\${me}`));
}
