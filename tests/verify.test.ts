/**
 * Quote verification.
 *
 * Requirement 8 of the task. The interesting cases are not the ones that match exactly - they
 * are the near misses: a faithful quote that differs in whitespace or punctuation must pass, and
 * a paraphrase that reads like the contract must fail. Get that boundary wrong in either
 * direction and the feature is useless: too strict and every real quote is rejected, too loose
 * and an invented clause is presented as a quotation.
 */
import { describe, expect, it } from "vitest";

import { findQuote, quoteAppears } from "@/services/verify";

const DEFINITIONS = `1. DEFINITIONS

1.1 "Services" means the data processing and reporting services described in Schedule A.`;

const CONTRACT = `7. TERMINATION

7.1 Either party may terminate this Agreement by giving not less than thirty (30) days'
prior written notice to the other party.

7.2 The Company may terminate immediately on written notice if the Supplier commits a
material breach which is not remedied within fourteen (14) days.

8. LIMITATION OF LIABILITY

8.1 Neither party shall be liable for any indirect or consequential loss, and the total
aggregate liability of either party shall not exceed the fees paid in the twelve (12)
months preceding the claim.`;

describe("quotes that really are in the contract", () => {
  it("accepts an exact quote", () => {
    expect(quoteAppears(CONTRACT, "Either party may terminate this Agreement")).toBe(true);
  });

  it("accepts a quote whose line breaks were flattened to spaces", () => {
    // This is the normal case, not an edge case: extraction keeps the PDF's line breaks and the
    // model returns the sentence on one line.
    expect(
      quoteAppears(
        CONTRACT,
        "Either party may terminate this Agreement by giving not less than thirty (30) days' prior written notice to the other party.",
      ),
    ).toBe(true);
  });

  it("accepts curly quotes and en dashes where the contract has straight ones", () => {
    expect(quoteAppears(CONTRACT, "thirty (30) days’ prior written notice")).toBe(true);
  });

  it("accepts a quote where the model swapped double quotes for single ones", () => {
    // Observed in production use: the contract defines 1.1 "Services", and the model quoted it
    // back as 1.1 'Services'. That is punctuation, not a different word, so it must verify.
    expect(quoteAppears(DEFINITIONS, "1.1 'Services' means the data processing")).toBe(true);
    expect(quoteAppears(DEFINITIONS, '1.1 `Services` means the data processing')).toBe(true);
  });

  it("ignores case and runs of whitespace", () => {
    expect(quoteAppears(CONTRACT, "NEITHER   PARTY  SHALL BE LIABLE")).toBe(true);
  });

  it("accepts a quote abridged with an ellipsis", () => {
    expect(
      quoteAppears(CONTRACT, "Neither party shall be liable ... shall not exceed the fees paid"),
    ).toBe(true);
  });

  it("reports the real offsets, so the span can be highlighted", () => {
    const match = findQuote(CONTRACT, "material breach which is not remedied");
    expect(match).not.toBeNull();
    expect(CONTRACT.slice(match!.start, match!.end).replace(/\s+/g, " ")).toBe(
      "material breach which is not remedied",
    );
  });
});

describe("quotes that are not in the contract", () => {
  it("rejects a paraphrase, however plausible", () => {
    // The whole point. This says what the contract says; it is not what the contract says.
    expect(quoteAppears(CONTRACT, "Either party can end this agreement with 30 days notice")).toBe(
      false,
    );
  });

  it("rejects an invented standard clause", () => {
    expect(
      quoteAppears(
        CONTRACT,
        "This Agreement shall be governed by and construed in accordance with the laws of England and Wales.",
      ),
    ).toBe(false);
  });

  it("rejects a quote with one word changed", () => {
    expect(quoteAppears(CONTRACT, "Either party must terminate this Agreement")).toBe(false);
  });

  it("rejects a fragment too short to be evidence", () => {
    expect(quoteAppears(CONTRACT, "party")).toBe(false);
  });

  it("rejects ellipsis segments that appear in the wrong order", () => {
    // Order matters: a model stitching two distant phrases backwards has not quoted anything.
    expect(
      quoteAppears(CONTRACT, "shall not exceed the fees paid ... Neither party shall be liable"),
    ).toBe(false);
  });
});
