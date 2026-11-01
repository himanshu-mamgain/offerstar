import { z } from 'zod';
import type { Config } from '../config.ts';
import { profileSkills } from '../jobs/score.ts';
import { canonicalSkill } from '../jobs/terms.ts';
import type { EvidenceBlock, Profile } from '../profile.ts';
import { formatDates, resumeData, type ResumeData } from '../resume/data.ts';

const cited = z.object({ text: z.string().trim().min(1), cites: z.array(z.string()).min(1, 'cite at least one evidence block') });

// What the apply skill hands the CLI: tailored wording, every line citing
// the evidence blocks it comes from. The CLI, not Claude, decides whether
// it is grounded.
export const DraftSchema = z.object({
  jobId: z.number().int(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  summary: cited.optional(),
  items: z.array(z.object({ blockId: z.string(), bullets: z.array(cited).min(1) })).min(1),
  skills: z.array(z.string()).optional(),
  coverNote: cited.optional(),
  answers: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1), cites: z.array(z.string()).default([]), fromConfig: z.array(z.string()).default([]) }))
    .default([]),
});

export type Draft = z.infer<typeof DraftSchema>;

// Every number written in a sentence: "40%", "1.5", "12,000", "3x".
const NUMBERS = /\d+(?:[.,]\d+)*/g;

function blockText(b: EvidenceBlock): string {
  return [b.title, b.organization, b.summary, ...b.highlights, ...b.metrics, b.location, formatDates(b.start, b.end), b.start, b.end].filter(Boolean).join('\n');
}

const configValue = (config: Config, key: string): unknown => key.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), config);

// One cited line: every block it cites exists, and every number it states
// appears in those blocks.
export function auditCited(where: string, line: { text: string; cites: string[] }, profile: Profile): string[] {
  const byId = new Map(profile.blocks.map((b) => [b.id, b]));
  if (line.cites.length === 0) return [`${where}: cite at least one evidence block`];
  const missing = line.cites.filter((id) => !byId.has(id));
  if (missing.length) return [`${where}: cites unknown block ${missing.join(', ')}`];
  const sources = line.cites.map((id) => blockText(byId.get(id)!)).join('\n');
  const sourceNumbers = new Set((sources.match(NUMBERS) ?? []).map((n) => n.replace(/,/g, '')));
  return (line.text.match(NUMBERS) ?? [])
    .filter((n) => !sourceNumbers.has(n.replace(/,/g, '')))
    .map((n) => `${where}: the number ${n} is not in ${line.cites.join(', ')}`);
}

// Returns the problems that block rendering; an empty list means grounded.
export function auditDraft(draft: Draft, profile: Profile, config: Config): string[] {
  const problems: string[] = [];
  const byId = new Map(profile.blocks.map((b) => [b.id, b]));
  const checkCited = (where: string, line: { text: string; cites: string[] }) => problems.push(...auditCited(where, line, profile));

  if (draft.summary) checkCited('summary', draft.summary);
  if (draft.coverNote) checkCited('cover note', draft.coverNote);

  const seen = new Set<string>();
  draft.items.forEach((item, i) => {
    if (!byId.has(item.blockId)) return problems.push(`item ${i + 1}: no evidence block ${item.blockId}`);
    if (seen.has(item.blockId)) problems.push(`item ${i + 1}: ${item.blockId} appears twice`);
    seen.add(item.blockId);
    item.bullets.forEach((bullet, j) => {
      const where = `${item.blockId} bullet ${j + 1}`;
      if (!bullet.cites.includes(item.blockId)) problems.push(`${where}: must cite ${item.blockId}, the block it sits under`);
      checkCited(where, bullet);
    });
  });

  const known = profileSkills(profile);
  for (const skill of draft.skills ?? []) {
    if (!known.has(canonicalSkill(skill))) problems.push(`skill "${skill}" is not in any evidence block`);
  }

  draft.answers.forEach((a, i) => {
    const where = `answer ${i + 1} ("${a.question.slice(0, 40)}")`;
    if (a.cites.length === 0 && a.fromConfig.length === 0) problems.push(`${where}: cite an evidence block or a config.yaml field; otherwise leave it for the user`);
    const missing = a.fromConfig.filter((key) => configValue(config, key) === undefined || configValue(config, key) === '');
    if (missing.length) problems.push(`${where}: config.yaml has no ${missing.join(', ')}`);
    if (a.cites.length) checkCited(where, { text: a.answer, cites: a.cites });
    else {
      const allowed = new Set(a.fromConfig.flatMap((key) => String(configValue(config, key) ?? '').match(NUMBERS) ?? []));
      for (const n of a.answer.match(NUMBERS) ?? []) if (!allowed.has(n)) problems.push(`${where}: the number ${n} is not in ${a.fromConfig.join(', ')}`);
    }
  });

  return problems;
}

// The resume as tailored: the chosen blocks in the standard layout, with the
// draft's wording in place of each block's stored highlights.
export function draftResume(draft: Draft, profile: Profile, config: Config): ResumeData {
  const data = resumeData(config, profile.blocks, draft.items.map((i) => i.blockId));
  const bullets = new Map(draft.items.map((i) => [i.blockId, i.bullets.map((b) => b.text)]));
  for (const section of data.sections) for (const item of section.items) item.bullets = bullets.get(item.blockId) ?? item.bullets;
  if (draft.summary) data.summary = draft.summary.text;
  if (draft.skills?.length) data.skills = draft.skills;
  return data;
}
