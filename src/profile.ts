import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { PROFILE_FOLDERS } from './paths.ts';

const blockTypes = Object.keys(PROFILE_FOLDERS) as [keyof typeof PROFILE_FOLDERS, ...(keyof typeof PROFILE_FOLDERS)[]];
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const EvidenceBlockSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'use lowercase words joined by hyphens'),
    type: z.enum(blockTypes),
    title: z.string().min(1),
    // Employer, school or issuer, for experience, education and certifications.
    organization: z.string().optional(),
    start: yearMonth.optional(),
    end: z.union([yearMonth, z.literal('present')]).optional(),
    location: z.string().optional(),
    summary: z.string().default(''),
    // Resume bullets, each a fact the evidence supports.
    highlights: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    evidence: z
      .array(z.object({ kind: z.enum(['repo', 'package', 'app', 'certificate', 'link', 'document']), url: z.url() }))
      .default([]),
    verified: z.enum(['self', 'linked', 'issuer-signed']),
    // Only numbers the user has confirmed.
    metrics: z.array(z.string()).default([]),
    updated: z.iso.date(),
  })
  .refine((b) => b.verified === 'self' || b.evidence.length > 0, {
    message: 'a linked or issuer-signed block needs at least one evidence link',
    path: ['evidence'],
  });

export type EvidenceBlock = z.infer<typeof EvidenceBlockSchema>;
export type EvidenceBlockInput = z.input<typeof EvidenceBlockSchema>;

// Writes a new block file. Never overwrites: the user may have edited it.
// Returns the path, or undefined when the file already exists.
export async function writeBlock(profileDir: string, block: EvidenceBlockInput): Promise<string | undefined> {
  const parsed = EvidenceBlockSchema.parse(block);
  const path = join(profileDir, PROFILE_FOLDERS[parsed.type], `${parsed.id}.yaml`);
  try {
    await writeFile(path, stringify(block), { flag: 'wx' });
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw err;
  }
}

export interface ProfileProblem {
  file: string;
  message: string;
}

export interface Profile {
  blocks: EvidenceBlock[];
  problems: ProfileProblem[];
  // Hash of every block file's path and bytes; scores and resumes record it.
  hash: string;
}

export async function loadProfile(profileDir: string): Promise<Profile> {
  const blocks: EvidenceBlock[] = [];
  const problems: ProfileProblem[] = [];
  const hash = createHash('sha256');
  const seen = new Map<string, string>();

  for (const [type, folder] of Object.entries(PROFILE_FOLDERS)) {
    const dir = join(profileDir, folder);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /\.ya?ml$/.test(n)).sort();
    for (const name of names) {
      const path = join(dir, name);
      const file = relative(profileDir, path).replaceAll('\\', '/');
      const text = await readFile(path, 'utf8');
      hash.update(`${file}\0${text}\0`);

      let data: unknown;
      try {
        data = parse(text);
      } catch (err) {
        problems.push({ file, message: `not valid YAML: ${(err as Error).message}` });
        continue;
      }
      const result = EvidenceBlockSchema.safeParse(data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          problems.push({ file, message: `${issue.path.join('.') || 'block'}: ${issue.message}` });
        }
        continue;
      }
      const block = result.data;
      if (block.type !== type) {
        problems.push({ file, message: `type is "${block.type}" but the file is in ${folder}/` });
        continue;
      }
      const other = seen.get(block.id);
      if (other) {
        problems.push({ file, message: `id "${block.id}" is already used by ${other}` });
        continue;
      }
      seen.set(block.id, file);
      blocks.push(block);
    }
  }

  return { blocks, problems, hash: hash.digest('hex').slice(0, 16) };
}
