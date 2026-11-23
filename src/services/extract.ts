/**
 * Turn an uploaded file into text, keeping track of where each page starts.
 *
 * The page map is the point. A finding has to say "page 4", and a quote has to be locatable in
 * the original, so extraction records the character offset at which every page begins. Everything
 * downstream works on one `fullText` string plus that map, which keeps chunking and quote
 * verification simple: they only ever deal with offsets.
 *
 * DOCX has no fixed pages - pagination happens at render time in Word - so it is reported as a
 * single page and located by section heading instead. That is stated in the UI rather than faked.
 */

export type PageSpan = { page: number; start: number; end: number };

export type Extraction = {
  fullText: string;
  pages: PageSpan[];
  pageCount: number;
  /** True when page numbers are real; false for DOCX and TXT, where sections are used instead. */
  hasRealPages: boolean;
};

export class UnsupportedFileError extends Error {}

export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<Extraction> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (mimeType === "application/pdf" || ext === "pdf") return extractPdf(buffer);
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return extractDocx(buffer);
  }
  if (mimeType.startsWith("text/") || ext === "txt" || ext === "md") {
    return fromSinglePage(buffer.toString("utf8"));
  }

  throw new UnsupportedFileError(
    `Unsupported file type "${mimeType || ext || "unknown"}". Upload a PDF, DOCX or TXT.`,
  );
}

function fromSinglePage(text: string): Extraction {
  const clean = normaliseNewlines(text);
  return {
    fullText: clean,
    pages: [{ page: 1, start: 0, end: clean.length }],
    pageCount: 1,
    hasRealPages: false,
  };
}

function normaliseNewlines(s: string): string {
  // Strip the BOM, unify line endings, and collapse runs of blank lines. Keeps offsets stable
  // between extraction and verification, which both work on this same string.
  return s
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}

async function extractPdf(buffer: Buffer): Promise<Extraction> {
  // The legacy build is the one that runs in Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    // No worker thread in Node: the fake worker runs inline, which is what we want inside a
    // queue consumer that is already a separate process.
    disableFontFace: true,
  }).promise;

  const parts: string[] = [];
  const pages: PageSpan[] = [];
  let offset = 0;

  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();

    // pdf.js returns positioned fragments, not lines. Rebuild lines by watching the vertical
    // position: a new baseline means a new line. Without this every page collapses into one
    // unreadable paragraph and clause boundaries disappear.
    let text = "";
    let lastY: number | null = null;
    for (const item of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      if (typeof item.str !== "string") continue;
      const y = item.transform?.[5];
      if (lastY !== null && typeof y === "number" && Math.abs(y - lastY) > 2) {
        text += "\n";
      } else if (text && !text.endsWith(" ") && !text.endsWith("\n") && item.str) {
        text += " ";
      }
      text += item.str;
      if (typeof y === "number") lastY = y;
      if (item.hasEOL) {
        text += "\n";
        lastY = null;
      }
    }

    const pageText = normaliseNewlines(text).trim();
    const start = offset;
    parts.push(pageText);
    offset += pageText.length;
    pages.push({ page: pageNo, start, end: offset });

    // Separator between pages, counted into the offsets so they stay exact.
    if (pageNo < doc.numPages) {
      parts.push("\n\n");
      offset += 2;
    }

    page.cleanup();
  }

  await doc.destroy();

  const fullText = parts.join("");
  if (!fullText.trim()) {
    throw new UnsupportedFileError(
      "No text could be read from this PDF. It is probably a scan; this app does not run OCR.",
    );
  }

  return { fullText, pages, pageCount: doc.numPages, hasRealPages: true };
}

async function extractDocx(buffer: Buffer): Promise<Extraction> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer });
  if (!value.trim()) throw new UnsupportedFileError("No text could be read from this DOCX.");
  return fromSinglePage(value);
}

/** Which page a character offset falls on. */
export function pageAt(pages: PageSpan[], charIndex: number): number | null {
  for (const p of pages) {
    if (charIndex >= p.start && charIndex <= p.end) return p.page;
  }
  return pages.length ? pages[pages.length - 1].page : null;
}
