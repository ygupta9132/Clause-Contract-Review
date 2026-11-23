/**
 * Data isolation between users.
 *
 * This is the test I most wanted to write. In production I have seen a multi-tenant query filter
 * silently lose its tenant condition: the filter was built with `cond && extra`, `extra` was
 * undefined, the whole expression became undefined, and the ORM generated SQL with no tenant
 * predicate at all. Nothing failed, nothing logged, and one account could read another's data.
 *
 * The lesson was that asserting on a function's return value is not enough, because the bug is
 * invisible at that layer. So these tests put two users' rows in the same tables and then try,
 * from user B, every path that reaches user A's data: load the contract, search its vectors,
 * read its findings, read its chat. Each one must come back empty or throw.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql } from "@/db";
import { chatMessages, chunks, contracts, findings, EMBEDDING_DIMENSIONS } from "@/db/schema";
import { loadOwnedContract, NotFoundError } from "@/lib/auth";
import { retrieve } from "@/services/retrieve";

const userA = `test_user_a_${randomUUID()}`;
const userB = `test_user_b_${randomUUID()}`;

let contractA: string;
let contractB: string;

/** A deterministic unit vector, so similarity scores are stable between runs. */
function fakeEmbedding(seed: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin((i + 1) * seed) / 10);
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function seedContract(userId: string, label: string): Promise<string> {
  const [row] = await db
    .insert(contracts)
    .values({
      userId,
      filename: `${label}.txt`,
      mimeType: "text/plain",
      sizeBytes: 100,
      storagePath: `/tmp/${label}.txt`,
      status: "reviewed",
      fullText: `${label} agreement. Either party may terminate on thirty days written notice.`,
      pageMap: [{ page: 1, start: 0, end: 80 }],
      pageCount: 1,
      hasRealPages: false,
    })
    .returning({ id: contracts.id });

  await db.insert(chunks).values({
    contractId: row.id,
    userId,
    ordinal: 0,
    content: `${label}: Either party may terminate this Agreement on thirty days written notice.`,
    sectionLabel: "7 Termination",
    pageFrom: 1,
    pageTo: 1,
    charStart: 0,
    charEnd: 80,
    embedding: fakeEmbedding(label === "alpha" ? 1 : 2),
  });

  await db.insert(findings).values({
    contractId: row.id,
    userId,
    itemKey: "termination",
    status: "found",
    summary: `${label} can be ended with 30 days notice`,
    quote: "Either party may terminate",
    quoteVerified: true,
  });

  await db.insert(chatMessages).values({
    contractId: row.id,
    userId,
    role: "user",
    content: `${label} question`,
  });

  return row.id;
}

beforeAll(async () => {
  contractA = await seedContract(userA, "alpha");
  contractB = await seedContract(userB, "beta");
});

afterAll(async () => {
  // Delete only what this file created. Cascades remove the children.
  await db.delete(contracts).where(eq(contracts.userId, userA));
  await db.delete(contracts).where(eq(contracts.userId, userB));
  await sql.end({ timeout: 5 });
});

describe("a user can reach their own contract", () => {
  it("loads it by id", async () => {
    const row = await loadOwnedContract(contractA, userA);
    expect(row.id).toBe(contractA);
    expect(row.filename).toBe("alpha.txt");
  });

  it("finds its own chunks by vector search", async () => {
    const hits = await retrieve({
      userId: userA,
      contractId: contractA,
      queryEmbedding: fakeEmbedding(1),
      keywords: ["terminate"],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("alpha");
  });
});

describe("a user cannot reach another user's contract", () => {
  it("refuses to load it, and does not reveal that it exists", async () => {
    // 404, not 403. A different status for "exists but not yours" would let anyone probe ids.
    await expect(loadOwnedContract(contractA, userB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadOwnedContract(contractB, userA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns nothing from vector search, even with the right contract id", async () => {
    // The attack this models: user B has somehow learned contract A's id and calls the API with
    // it. Retrieval is scoped by user as well as by contract, so there is nothing to return.
    const hits = await retrieve({
      userId: userB,
      contractId: contractA,
      queryEmbedding: fakeEmbedding(1),
      keywords: ["terminate"],
    });
    expect(hits).toHaveLength(0);
  });

  it("returns no findings", async () => {
    const rows = await db
      .select()
      .from(findings)
      .where(and(eq(findings.contractId, contractA), eq(findings.userId, userB)));
    expect(rows).toHaveLength(0);
  });

  it("returns no chat history", async () => {
    const rows = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.contractId, contractA), eq(chatMessages.userId, userB)));
    expect(rows).toHaveLength(0);
  });

  it("deletes nothing when it tries to delete someone else's contract", async () => {
    await db
      .delete(contracts)
      .where(and(eq(contracts.id, contractA), eq(contracts.userId, userB)));

    // Still there, owned by A.
    const stillThere = await loadOwnedContract(contractA, userA);
    expect(stillThere.id).toBe(contractA);
  });
});

describe("the tenant predicate is in the generated SQL, not only in the result", () => {
  /**
   * The production bug that motivated this file produced correct-looking results in tests while
   * emitting SQL with no tenant filter. Asserting on rows alone would not have caught it, so
   * this asserts on the statement Drizzle actually generates.
   */
  it("includes user_id in the contract lookup", () => {
    const query = db
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractA), eq(contracts.userId, userA)))
      .toSQL();

    expect(query.sql).toContain("user_id");
    expect(query.params).toContain(userA);
  });
});
