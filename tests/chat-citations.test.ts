/**
 * Citation extraction from a streamed answer.
 *
 * Both cases here were real defects, visible on screen before they were visible in the code.
 *
 * A model writing prose sometimes escapes its quotation marks as if it were emitting a JSON
 * string: `1.1 \"Services\" means...`. The reader sees the backslashes, and worse, the
 * extraction regex treats an escaped quote as a closing one - so one quotation is parsed as two
 * overlapping fragments and the same clause is cited twice.
 */
import { describe, expect, it } from "vitest";

import { extractQuotedSpans, unescapeQuotes, verifyAnswerCitations } from "@/services/chat";
import type { RetrievedChunk } from "@/services/retrieve";

const CONTRACT = `1. DEFINITIONS

1.1 "Services" means the data processing and reporting services described in Schedule A.

8. TERMINATION

8.1 Either party may terminate this Agreement for convenience by giving not less than sixty
(60) days prior written notice to the other party.`;

const PAGES = [{ page: 1, start: 0, end: CONTRACT.length }];

const CHUNKS: RetrievedChunk[] = [
  {
    id: "chunk-1",
    content: CONTRACT,
    sectionLabel: "1.1",
    pageFrom: 1,
    pageTo: 1,
    charStart: 0,
    charEnd: CONTRACT.length,
    similarity: 0.9,
    keywordHits: 1,
    score: 0.9,
  },
];

describe("escaped quotation marks", () => {
  it("removes the backslashes a model adds around quoted words", () => {
    expect(unescapeQuotes('1.1 \\"Services\\" means the data')).toBe('1.1 "Services" means the data');
  });

  it("does not split one quotation into two at an escaped quote", () => {
    const answer =
      'The contract covers data processing. "1.1 \\"Services\\" means the data processing and ' +
      'reporting services described in Schedule A."';

    const spans = extractQuotedSpans(answer);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toContain("means the data processing and reporting services");
  });
});

describe("overlapping quotations", () => {
  it("cites a clause once when the answer quotes it twice, long and short", () => {
    // Exactly the shape that produced two identical "Verified quote - Section 1.1" lines.
    const answer =
      'The contract is about "the data processing and reporting services described in Schedule A."\n\n' +
      '"1.1 \\"Services\\" means the data processing and reporting services described in Schedule A."';

    const citations = verifyAnswerCitations(answer, CONTRACT, PAGES, CHUNKS);
    expect(citations).toHaveLength(1);
    expect(citations[0].verified).toBe(true);
    expect(citations[0].sectionLabel).toBe("1.1");
  });

  it("keeps two citations when they are genuinely different clauses", () => {
    const answer =
      'Services are defined in "means the data processing and reporting services described in Schedule A." ' +
      'Termination needs "not less than sixty (60) days prior written notice".';

    const citations = verifyAnswerCitations(answer, CONTRACT, PAGES, CHUNKS);
    expect(citations).toHaveLength(2);
    expect(citations.every((c) => c.verified)).toBe(true);
  });
});

describe("unverifiable quotations", () => {
  it("returns the citation flagged unverified rather than dropping it", () => {
    // The user has already read the quote in the streamed answer. Hiding the citation would
    // leave them with a quotation and no warning; showing it marked false is the honest result.
    const answer = 'The contract says "either party may walk away at any time without notice".';

    const citations = verifyAnswerCitations(answer, CONTRACT, PAGES, CHUNKS);
    expect(citations).toHaveLength(1);
    expect(citations[0].verified).toBe(false);
  });
});
