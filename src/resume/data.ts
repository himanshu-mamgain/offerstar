import type { Config } from '../config.ts';
import type { EvidenceBlock } from '../profile.ts';

export interface ResumeItem {
  // The evidence block every line of this item comes from.
  blockId: string;
  title: string;
  dates: string;
  location: string;
  bullets: string[];
}

export interface ResumeData {
  paper: Config['resume']['paper'];
  contact: { name: string; details: string[] };
  summary?: string;
  sections: { heading: string; items: ResumeItem[] }[];
  skills: string[];
}

const SECTIONS = [
  ['experience', 'Experience'],
  ['project', 'Projects'],
  ['education', 'Education'],
  ['certification', 'Certifications'],
  ['achievement', 'Achievements'],
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function month(ym: string): string {
  return ym === 'present' ? 'Present' : `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

export function formatDates(start?: string, end?: string): string {
  if (start && end) return `${month(start)} – ${month(end)}`;
  return start ? month(start) : end ? month(end) : '';
}

// Newest first; 'present' sorts above any date; undated items keep their order.
const sortKey = (b: EvidenceBlock) => (b.end === 'present' ? '9999-99' : (b.end ?? b.start ?? ''));

export function resumeData(config: Config, blocks: EvidenceBlock[], blockIds?: string[]): ResumeData {
  if (!config.contact.name) throw new Error('set contact.name in config.yaml before building a resume');

  let chosen = blocks;
  if (blockIds) {
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const missing = blockIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`no evidence block with id ${missing.join(', ')}`);
    chosen = blockIds.map((id) => byId.get(id)!);
  }

  const sections = SECTIONS.map(([type, heading]) => ({
    heading,
    items: chosen
      .filter((b) => b.type === type)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
      .map((b) => ({
        blockId: b.id,
        title: b.organization ? `${b.title}, ${b.organization}` : b.title,
        dates: formatDates(b.start, b.end),
        location: b.location ?? '',
        bullets: b.highlights.length > 0 ? b.highlights : b.summary ? [b.summary] : [],
      })),
  })).filter((s) => s.items.length > 0);

  const skillBlocks = chosen.filter((b) => b.type === 'skill');
  const skills = skillBlocks.length > 0 ? skillBlocks.map((b) => b.title) : [...new Set(chosen.flatMap((b) => b.skills))];

  const { contact } = config;
  return {
    paper: config.resume.paper,
    contact: { name: contact.name, details: [contact.email, contact.phone, contact.location, ...contact.links].filter(Boolean) },
    sections,
    skills,
  };
}
