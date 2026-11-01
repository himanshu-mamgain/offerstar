import * as cheerio from 'cheerio';

export interface GuardResult {
  text: string;
  // Instruction-like lines, quoted so the user can see what was there.
  flags: string[];
  hiddenElements: number;
  invisibleChars: number;
}

const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|(?:^|;)\s*color\s*:\s*(?:#fff(?:fff)?|white|transparent)\b/i;

// Zero-width, bidi-control, soft-hyphen, word-joiner, BOM and Unicode tag characters.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

const INSTRUCTION_PATTERNS = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)/i,
  /\bdisregard (?:all |any )?(?:the )?(?:previous|prior|above|your) /i,
  /\b(?:you are|act as|pretend to be) (?:an? |the )?(?:ai|assistant|language model|llm|chatbot)\b/i,
  /\b(?:as an ai|as a language model)\b/i,
  /\bsystem prompt\b/i,
  /\b(?:if you are|attention|note to|dear|hey) (?:an? |the )?(?:ai|llm|language model|assistant|chatgpt|claude|gpt|bot)\b/i,
  /\b(?:ai|llm|language model|assistant|chatgpt|claude|gpt)s?(?: model)?(?: reading this| screening this| reviewing this)?,? (?:you )?(?:must|should|need to|are required to)\b/i,
  /\b(?:include|insert|add|mention) (?:the (?:word|phrase)|this (?:word|phrase))\b/i,
  /^\s*(?:system|assistant|user)\s*:/im,
  /\bdo not (?:tell|inform|reveal to) (?:the )?(?:candidate|user|applicant)\b/i,
  /\brate this candidate\b/i,
];

export function guardPosting(input: { html?: string | null; text?: string | null }): GuardResult {
  let hiddenElements = 0;
  let raw = input.text ?? '';

  if (input.html) {
    const $ = cheerio.load(input.html);
    $('script, style, noscript, template, iframe, object, embed').remove();
    $('[hidden], [aria-hidden="true"]').each((_, el) => {
      hiddenElements++;
      $(el).remove();
    });
    $('[style]').each((_, el) => {
      if (HIDDEN_STYLE.test($(el).attr('style') ?? '')) {
        hiddenElements++;
        $(el).remove();
      }
    });
    $('br').replaceWith('\n');
    $('p, div, h1, h2, h3, h4, h5, h6, tr, section, ul, ol').each((_, el) => {
      $(el).prepend('\n').append('\n');
    });
    $('li').each((_, el) => {
      $(el).prepend('\n- ').append('\n');
    });
    raw = $.root().text();
  }

  const invisibleChars = (raw.match(INVISIBLE) ?? []).length;
  const text = raw
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const flags = text
    .split('\n')
    .filter((line) => INSTRUCTION_PATTERNS.some((p) => p.test(line)))
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));

  return { text, flags, hiddenElements, invisibleChars };
}
