/**
 * Summaries that say nothing.
 *
 * A model occasionally answers the summary field with the status token - literally
 * "not_found" - and the finding card then showed "Not found in the contract." with
 * "not_found" printed underneath it. The fallback has to replace those, while leaving a real
 * sentence that happens to mention "not found" alone.
 */
import { describe, expect, it } from "vitest";

import { resolveFinding } from "@/services/review";

const CONTRACT = `2. TERM

2.1 This Agreement commences on 1 April 2026 and continues for twelve (12) months.`;

const PAGES = [{ page: 1, start: 0, end: CONTRACT.length }];

const decide = (summary: string) =>
  resolveFinding(
    { status: "not_found", summary, quote: null, excerpt: null },
    [],
    CONTRACT,
    PAGES,
  );

describe("echoed status tokens are replaced", () => {
  it.each(["not_found", "NOT_FOUND", "not found", "Not Found.", "unclear", "none", "n/a", "   "])(
    "replaces %j with the standard sentence",
    (summary) => {
      expect(decide(summary).summary).toBe("Not found in the contract.");
    },
  );
});

describe("a real summary is kept", () => {
  it("keeps a sentence that explains why nothing was found", () => {
    const summary = "The term clause states an expiry date and says nothing about renewal.";
    expect(decide(summary).summary).toBe(summary);
  });

  it("keeps a sentence that merely contains the words not found", () => {
    const summary = "A liability cap was not found, though indirect loss is excluded.";
    expect(decide(summary).summary).toBe(summary);
  });
});

describe("a not_found finding carries no quote", () => {
  it("never shows a quotation for something that is absent", () => {
    const resolved = decide("The contract does not contain an auto-renewal clause.");
    expect(resolved.quote).toBeNull();
    expect(resolved.quoteVerified).toBe(false);
    expect(resolved.status).toBe("not_found");
  });
});
