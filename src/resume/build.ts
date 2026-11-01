import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { openDb } from '../db.ts';
import type { Paths } from '../paths.ts';
import type { Profile } from '../profile.ts';
import { resumeData, type ResumeData } from './data.ts';
import { RESUME_TEMPLATE } from './template.ts';
import { ensureTypst } from './typst.ts';

export interface BuiltResume {
  path: string;
  fileHash: string;
  profileHash: string;
  blockIds: string[];
}

export async function renderPdf(typst: string, data: ResumeData, out: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'offerstar-resume-'));
  try {
    await writeFile(join(dir, 'resume.typ'), RESUME_TEMPLATE);
    await writeFile(join(dir, 'resume.json'), JSON.stringify(data));
    const result = spawnSync(typst, ['compile', '--root', dir, join(dir, 'resume.typ'), join(dir, 'resume.pdf')], {
      encoding: 'utf8',
      windowsHide: true,
      // Fixed timestamp, so the same content always gives the same file hash.
      env: { ...process.env, SOURCE_DATE_EPOCH: '0' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Typst failed:\n${result.stderr.trim()}`);
    await copyFile(join(dir, 'resume.pdf'), out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Builds a resume from evidence blocks, saves it under resumes/ (or `out`)
// and records the version: file hash, profile hash and the blocks used.
export async function buildResume(
  paths: Paths,
  config: Config,
  profile: Profile,
  opts: { blockIds?: string[]; out?: string; log?: (line: string) => void } = {},
): Promise<BuiltResume> {
  const data = resumeData(config, profile.blocks, opts.blockIds);
  const blockIds = data.sections.flatMap((s) => s.items.map((i) => i.blockId));
  const typst = await ensureTypst(paths, opts.log);

  const tmp = join(paths.resumes, `.build-${process.pid}.pdf`);
  await renderPdf(typst, data, tmp);
  const fileHash = createHash('sha256').update(await readFile(tmp)).digest('hex');
  const path = opts.out ?? join(paths.resumes, `${new Date().toISOString().slice(0, 10)}-${fileHash.slice(0, 8)}.pdf`);
  await copyFile(tmp, path);
  await rm(tmp, { force: true });

  const db = openDb(paths.db);
  try {
    db.prepare('INSERT OR IGNORE INTO resume_versions (file_hash, profile_hash, block_ids, path) VALUES (?, ?, ?, ?)').run(
      fileHash,
      profile.hash,
      JSON.stringify(blockIds),
      path,
    );
    db.prepare("INSERT INTO events (kind, data) VALUES ('resume_built', ?)").run(JSON.stringify({ fileHash, path }));
  } finally {
    db.close();
  }
  return { path, fileHash, profileHash: profile.hash, blockIds };
}
