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
  // Also drop explicit entries for Everyone, Authenticated Users and Users
  // (by SID, so it works in any Windows language).
  spawnSync('icacls', [file, '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545'], { encoding: 'utf8', windowsHide: true });
}

// The accounts in a Windows file's access list, lowercased ("domain\user").
export function aclPrincipals(file: string): string[] {
  const result = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return [];
  // Each rule line looks like "DOMAIN\user:(F)"; the first one also starts with the file path.
  return result.stdout
    .split(/\r?\n/)
    .map((line) => (line.toLowerCase().startsWith(file.toLowerCase()) ? line.slice(file.length) : line).trim())
    .filter((line) => /:\(.*\)/.test(line))
    .map((line) => line.slice(0, line.indexOf(':(')).toLowerCase());
}

// SYSTEM and Administrators can read every file on the machine regardless,
// so their presence does not expose the file to other ordinary accounts.
const ALWAYS_ALLOWED = new Set(['nt authority\\system', 'builtin\\administrators']);

export async function isOwnerOnly(file: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return ((await stat(file)).mode & 0o077) === 0;
  }
  const principals = aclPrincipals(file);
  const me = userInfo().username.toLowerCase();
  return principals.some((p) => p === me || p.endsWith(`\\${me}`)) && principals.every((p) => p === me || p.endsWith(`\\${me}`) || ALWAYS_ALLOWED.has(p));
}
