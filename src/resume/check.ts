import { extractText, getDocumentProxy } from 'unpdf';
import type { Config } from '../config.ts';
import type { EvidenceBlock } from '../profile.ts';
import { formatDates } from './data.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface ResumeCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface CheckReport {
  ok: boolean;
  pages: number;
  checks: ResumeCheck[];
  fields?: { matched: number; total: number; missing: string[] };
  keywords?: { covered: string[]; missing: string[] };
}

export async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { pages: totalPages, text };
}

// Lowercase, one space between words, and the same dash everywhere, so a
// match does not depend on how the PDF happened to space or encode text.
const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');

export async function checkResume(
  bytes: Uint8Array,
  opts: { config?: Config; blocks?: EvidenceBlock[]; keywords?: string[] } = {},
): Promise<CheckReport> {
  const { pages, text } = await pdfText(bytes);
  const flat = norm(text);
  const checks: ResumeCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });

  add('pages', pages >= 1 && pages <= 2 ? 'ok' : 'fail', `${pages} page${pages === 1 ? '' : 's'}${pages > 2 ? '; keep it to one or two' : ''}`);

  if (flat.length < 50) {
    add('text', 'fail', 'little or no text layer; an ATS would see an empty resume (is it a scanned image?)');
  } else if (flat.length < 300) {
    add('text', 'warn', `only ${flat.split(' ').length} words; a recruiter will expect more detail`);
  } else {
    add('text', 'ok', `${flat.split(' ').length} words extracted`);
  }

  const garbled = text.match(/[�-ﬀ-ﬆ]/g) ?? [];
  add('characters', garbled.length === 0 ? 'ok' : 'fail', garbled.length === 0 ? 'no garbled or ligature characters' : `${garbled.length} garbled or ligature characters, e.g. "${garbled.slice(0, 3).join('')}"`);

  const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
  const contact = opts.config?.contact;
  if (contact?.email) {
    add('email', flat.includes(norm(contact.email)) ? 'ok' : 'fail', flat.includes(norm(contact.email)) ? contact.email : `${contact.email} not found in the text`);
  } else {
    add('email', email ? 'ok' : 'fail', email ?? 'no email address found');
  }
  if (contact?.phone) {
    const found = digits(text).includes(digits(contact.phone));
    add('phone', found ? 'ok' : 'fail', found ? contact.phone : `${contact.phone} not found in the text`);
  } else {
    const phone = text.match(/\+?\d[\d\s-]{8,}\d/)?.[0];
    add('phone', phone ? 'ok' : 'warn', phone ?? 'no phone number found');
  }

  if (contact?.name) {
    const at = flat.indexOf(norm(contact.name));
    add('order', at >= 0 && at < 100 ? 'ok' : 'fail', at >= 0 && at < 100 ? 'name comes first' : 'your name is not at the start of the text; the reading order may be wrong');
  }

  const report: CheckReport = { ok: false, pages, checks };

  if (opts.blocks?.length) {
    const fields: [string, string][] = [];
    for (const b of opts.blocks) {
      fields.push([`${b.id}: title`, b.title]);
      if (b.organization) fields.push([`${b.id}: organization`, b.organization]);
      const dates = formatDates(b.start, b.end);
      if (dates) fields.push([`${b.id}: dates`, dates]);
    }
    const missing = fields.filter(([, value]) => !flat.includes(norm(value))).map(([label]) => label);
    report.fields = { matched: fields.length - missing.length, total: fields.length, missing };
    add('fields', missing.length === 0 ? 'ok' : 'fail', `${fields.length - missing.length} of ${fields.length} fields matched${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
  }

  if (opts.keywords?.length) {
    const covered = opts.keywords.filter((k) => flat.includes(norm(k)));
    const missing = opts.keywords.filter((k) => !covered.includes(k));
    report.keywords = { covered, missing };
    add('keywords', missing.length === 0 ? 'ok' : 'warn', `${covered.length} of ${opts.keywords.length} covered${missing.length ? `; not in the resume: ${missing.join(', ')}` : ''}`);
  }

  report.ok = checks.every((c) => c.status !== 'fail');
  return report;
}

const LABELS: Record<CheckStatus, string> = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]' };

export function formatCheck(report: CheckReport): string {
  return [...report.checks.map((c) => `${LABELS[c.status]} ${c.id.padEnd(10)} ${c.detail}`), '', report.ok ? 'The resume parses cleanly.' : 'The resume has problems an ATS would trip on.'].join('\n');
}
