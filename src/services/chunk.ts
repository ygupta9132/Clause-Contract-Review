/**
 * Clause-aware chunking.
 *
 * A fixed-size sliding window is the usual default and it is wrong for contracts. Cutting every
 * 1,000 characters splits "either party may terminate" from "on thirty days written notice", and
 * then no retrieval strategy can recover the clause, because the clause no longer exists in one
 * piece. So the split points come from the document's own structure first:
 *
 *   1. find headings - numbered (7., 7.2, 7.2.1), ARTICLE/SECTION/CLAUSE, or short ALL-CAPS lines
 *   2. a chunk is a section, carrying its heading as a label
 *   3. only a section that is too long to embed is split further, on paragraph then sentence
 *      boundaries, with overlap, and every piece keeps the parent heading
 *
 * Every chunk keeps its character offsets, so a finding can be traced back to the exact span of
 * the original text, and its page range, so the UI can say where to look.
 */
import { pageAt, type PageSpan } from "./extract";

export type DraftChunk = {
  ordinal: number;
  content: string;
  sectionLabel: string | null;
  charStart: number;
  charEnd: number;
  pageFrom: number | null;
  pageTo: number | null;
};

const MAX_CHARS = 1800;
const MIN_CHARS = 120;
const OVERLAP = 200;

/** A line that introduces a clause rather than being part of one. */
const HEADING_PATTERNS: RegExp[] = [
  // 7.  TERMINATION      |  7.2 Termination for convenience  |  12.1.3 Notices
  // The separator is captured rather than discarded: see numberLooksLikeClause.
  /^\s{0,8}(\d{1,2}(?:\.\d{1,2}){0,3})([.):])?\s+(\S[^\n]{0,90})$/,
  // ARTICLE V - LIMITATION OF LIABILITY   |   Section 4: Payment
  /^\s{0,8}((?:ARTICLE|Article|SECTION|Section|CLAUSE|Clause|SCHEDULE|Schedule|ANNEXURE|Annexure|EXHIBIT|Exhibit)\s+[IVXLCDM\d]{1,6})\s*[.:\-–]?\s*([^\n]{0,90})$/,
  // CONFIDENTIALITY        (a short all-caps line on its own)
  /^\s{0,8}([A-Z][A-Z0-9 &\-'/,.]{3,60})$/,
];

/**
 * Is the text after a clause number a title, or the start of the clause itself?
 *
 * Contracts do both. "7. TERMINATION" puts the title on its own line; "7.1 Either party may
 * terminate this Agreement by giving..." runs straight into prose. Keeping the trailing text in
 * both cases produces labels like "2.1 This Agreement commences on the Effective Date and
 * continues for an initial period of", which is a sentence fragment, not a label.
 *
 * A title is short and reads like a heading: few words, and not a lowercase run of prose.
 */
/**
 * Is a leading number a clause number, or the start of a street address?
 *
 * "7. TERMINATION" and "7.1 Either party may..." are clauses. "22 Finsbury Square, London" and
 * "14 April 2026" are not, and treating them as headings produced findings citing
 * "Section 22" and "Section 14 April 2026".
 *
 * A decimal number is always a clause number - nothing else is written "7.2". A bare integer
 * counts only when a separator follows it, which is how every contract here writes one.
 */
function numberLooksLikeClause(num: string, separator: string | undefined): boolean {
  return num.includes(".") || Boolean(separator);
}

function looksLikeTitle(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (/[.;,]$/.test(text.trim())) return false;
  // Headings rarely contain a comma; addresses almost always do.
  if (text.includes(",")) return false;
  // ALL CAPS, or Title Case on the first word and no obvious sentence verb pattern after.
  const caps = text === text.toUpperCase();
  const titleCase = /^[A-Z][a-z]/.test(words[0]);
  return caps || titleCase;
}

function headingAt(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 100) return null;

  for (let i = 0; i < HEADING_PATTERNS.length; i++) {
    const m = trimmed.match(HEADING_PATTERNS[i]);
    if (!m) continue;

    if (i === 2) {
      // The all-caps rule is the loosest of the three, so demand it look like a title.
      if (!looksLikeTitle(trimmed)) return null;
      return trimmed.slice(0, 120);
    }

    // The numbered form captures a separator in group 2, so its text is group 3.
    if (i === 0) {
      const number = m[1].trim();
      if (!numberLooksLikeClause(number, m[2])) return null;
      const rest = (m[3] ?? "").trim();
      const label = rest && looksLikeTitle(rest) ? `${number} ${rest}` : number;
      return label.replace(/\s+/g, " ").slice(0, 120);
    }

    // ARTICLE/SECTION form: keep the trailing text only when it is a title.
    const number = m[1].trim();
    const rest = (m[2] ?? "").trim();
    const label = rest && looksLikeTitle(rest) ? `${number} ${rest}` : number;
    return label.replace(/\s+/g, " ").slice(0, 120);
  }
  return null;
}

type Section = { label: string | null; start: number; end: number };

/** Split the document into sections on heading lines, keeping absolute offsets. */
export function findSections(fullText: string): Section[] {
  const sections: Section[] = [];
  let currentLabel: string | null = null;
  let currentStart = 0;
  let offset = 0;

  const lines = fullText.split("\n");
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline removed by split

    const label = headingAt(line);
    if (!label) continue;

    // Close the previous section at the start of this heading.
    if (lineStart > currentStart) {
      sections.push({ label: currentLabel, start: currentStart, end: lineStart });
    }
    currentLabel = label;
    currentStart = lineStart;
  }

  sections.push({ label: currentLabel, start: currentStart, end: fullText.length });
  return sections.filter((s) => fullText.slice(s.start, s.end).trim().length > 0);
}

/** Split one over-long section on paragraph, then sentence, then hard boundaries. */
function splitLong(text: string, absoluteStart: number): { text: string; start: number }[] {
  if (text.length <= MAX_CHARS) return [{ text, start: absoluteStart }];

  const pieces: { text: string; start: number }[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(cursor + MAX_CHARS, text.length);

    if (end < text.length) {
      // Prefer a paragraph break, then a sentence end, then a space. Only look in the last
      // third of the window, so a break near the start does not produce a tiny chunk.
      const windowStart = cursor + Math.floor(MAX_CHARS * 0.6);
      const candidates = [
        text.lastIndexOf("\n\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf(";\n", end),
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
      ].filter((i) => i > windowStart);
      if (candidates.length) end = Math.max(...candidates) + 1;
    }

    const slice = text.slice(cursor, end);
    if (slice.trim()) pieces.push({ text: slice, start: absoluteStart + cursor });

    if (end >= text.length) break;
    // Overlap backwards so a clause that straddles the cut appears whole in one of the pieces.
    cursor = Math.max(end - OVERLAP, cursor + 1);
  }

  return pieces;
}

export function chunkDocument(fullText: string, pages: PageSpan[]): DraftChunk[] {
  const sections = findSections(fullText);
  const drafts: DraftChunk[] = [];

  for (const section of sections) {
    const raw = fullText.slice(section.start, section.end);

    for (const piece of splitLong(raw, section.start)) {
      const content = piece.text.trim();
      if (!content) continue;

      // Where the trimmed content actually begins, so offsets point at real characters.
      const lead = piece.text.length - piece.text.trimStart().length;
      const charStart = piece.start + lead;
      const charEnd = charStart + content.length;

      drafts.push({
        ordinal: 0, // assigned after merging
        content,
        sectionLabel: section.label,
        charStart,
        charEnd,
        pageFrom: pageAt(pages, charStart),
        pageTo: pageAt(pages, charEnd),
      });
    }
  }

  // A heading on its own line becomes a chunk of a dozen characters, which embeds to noise.
  // Fold anything too short into the next chunk so the heading travels with its clause.
  const merged: DraftChunk[] = [];
  for (const draft of drafts) {
    const previous = merged[merged.length - 1];
    if (previous && previous.content.length < MIN_CHARS && previous.sectionLabel === draft.sectionLabel) {
      previous.content = `${previous.content}\n${draft.content}`;
      previous.charEnd = draft.charEnd;
      previous.pageTo = draft.pageTo;
      continue;
    }
    merged.push({ ...draft });
  }

  return merged.map((c, i) => ({ ...c, ordinal: i }));
}
