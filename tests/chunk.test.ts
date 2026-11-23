/**
 * Chunking.
 *
 * Two properties matter and both are easy to break silently:
 *   - a clause stays in one piece, so retrieval can find it whole
 *   - every chunk's offsets point at the text it claims, so a finding can be traced back
 *
 * The offsets one is the test worth having. An off-by-one in the trimming logic produces chunks
 * that look perfect in the UI and cite the wrong span of the contract.
 */
import { describe, expect, it } from "vitest";

import { chunkDocument, findSections } from "@/services/chunk";

const CONTRACT = `SERVICES AGREEMENT

1. PARTIES

This Agreement is made between Acme Pvt Ltd ("the Company") and Globex LLP ("the Supplier").

2. TERM

2.1 This Agreement commences on 1 April 2026 and continues for twelve (12) months.

2.2 It shall automatically renew for successive twelve month periods unless either party
gives sixty days written notice of non-renewal.

7. TERMINATION

Either party may terminate this Agreement by giving thirty (30) days prior written notice.`;

const PAGES = [{ page: 1, start: 0, end: CONTRACT.length }];

describe("section detection", () => {
  it("splits on numbered headings and all-caps headings", () => {
    const labels = findSections(CONTRACT)
      .map((s) => s.label)
      .filter(Boolean);
    expect(labels).toContain("1 PARTIES");
    expect(labels).toContain("2 TERM");
    expect(labels).toContain("7 TERMINATION");
  });
});

describe("chunking", () => {
  const chunks = chunkDocument(CONTRACT, PAGES);

  it("produces chunks and labels them with their section", () => {
    expect(chunks.length).toBeGreaterThan(1);
    const termination = chunks.find((c) => c.content.includes("thirty (30) days"));
    expect(termination?.sectionLabel).toBe("7 TERMINATION");
  });

  it("keeps a clause in one piece", () => {
    const termination = chunks.find((c) => c.content.includes("Either party may terminate"));
    expect(termination?.content).toContain("thirty (30) days prior written notice");
  });

  it("keeps auto-renewal with the term clause rather than losing it", () => {
    const renewal = chunks.find((c) => c.content.includes("automatically renew"));
    expect(renewal).toBeDefined();
    expect(renewal?.content).toContain("sixty days written notice");
  });

  it("reports offsets that point at exactly the chunk's own text", () => {
    for (const chunk of chunks) {
      expect(CONTRACT.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it("numbers chunks in document order", () => {
    const ordinals = chunks.map((c) => c.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });
});
