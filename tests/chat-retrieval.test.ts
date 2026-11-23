/**
 * Matching a chat question to a checklist item.
 *
 * The checklist items carry retrieval queries written to read like the clause, and those are
 * what make the review accurate. A chat question has only the user's words, which is
 * measurably worse: "who are the parties to this agreement" returned "the contract does not
 * cover this" on a contract whose preamble never uses the word "parties" - it says "by and
 * between X and Y". Borrowing the matched item's vocabulary fixed it.
 *
 * The risk in borrowing is firing on the wrong item, or on a question that is not about the
 * checklist at all, so the match needs two independent hits.
 */
import { describe, expect, it } from "vitest";

import { matchChecklistItem } from "@/services/retrieve";

describe("questions that are clearly about a checklist item", () => {
  it.each([
    ["Who are the parties to this agreement and where are they based?", "parties"],
    ["Is there a cap on the aggregate liability?", "limitation_of_liability"],
    ["What notice is needed to terminate for convenience?", "termination"],
    ["Does this contract automatically renew?", "auto_renewal"],
    ["Which law governs this and which courts have jurisdiction?", "governing_law"],
  ])("matches %j to %s", (question, key) => {
    expect(matchChecklistItem(question)?.key).toBe(key);
  });
});

describe("questions that are not about the checklist", () => {
  it.each([
    "What is the penalty for late delivery?",
    "How many people work at the company?",
    "Can I get a copy of the signed original?",
  ])("does not force a match for %j", (question) => {
    expect(matchChecklistItem(question)).toBeNull();
  });

  it("needs more than one common word", () => {
    // "company" appears in the parties keywords, but one common word is not enough evidence
    // to borrow a whole item's vocabulary.
    expect(matchChecklistItem("How many people work at the company?")).toBeNull();
  });

  it("does match a vague question that names an item", () => {
    // Borrowing here is right, not a false positive: the question is about payment, and the
    // worst case is a few extra keywords merged into a search that also uses the question.
    expect(matchChecklistItem("Was payment discussed?")?.key).toBe("payment_terms");
  });
});
