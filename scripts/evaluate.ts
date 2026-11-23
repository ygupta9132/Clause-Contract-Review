/**
 * Evaluation harness: run the real pipeline over the sample contracts and score the result.
 *
 *   npm run evaluate
 *
 * This is the bonus item from the task, but it earned its place for a different reason: it is
 * the only way to change a prompt, a chunk size or a retrieval weight and find out whether the
 * change helped. Without it, tuning a RAG pipeline is guesswork with a confident tone.
 *
 * It runs the same code the worker runs - extraction, chunking, embedding, retrieval, the
 * checklist, quote verification - under a synthetic user id, scores the findings against
 * samples/expected.json, and deletes its rows afterwards.
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { CHECKLIST } from "../src/checklist";
import { db, sql } from "../src/db";
import { contracts, findings } from "../src/db/schema";
import { processContract } from "../src/services/ingest";

const SAMPLES_DIR = path.join(process.cwd(), "samples");
const EVAL_USER = `eval_${randomUUID()}`;

type Expected = Record<string, Record<string, string[]>>;

type Scored = {
  file: string;
  itemKey: string;
  expected: string[];
  actual: string;
  correct: boolean;
  quoteVerified: boolean;
  summary: string;
};

async function run() {
  const expectedRaw = JSON.parse(
    await readFile(path.join(SAMPLES_DIR, "expected.json"), "utf8"),
  ) as Expected;

  const files = Object.keys(expectedRaw).filter((k) => !k.startsWith("_"));
  const scored: Scored[] = [];
  const createdIds: string[] = [];

  for (const file of files) {
    process.stdout.write(`\n${file}\n${"-".repeat(file.length)}\n`);

    const storagePath = path.join(SAMPLES_DIR, file);
    const bytes = await readFile(storagePath);

    const [row] = await db
      .insert(contracts)
      .values({
        userId: EVAL_USER,
        filename: file,
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength,
        storagePath,
        status: "processing",
      })
      .returning({ id: contracts.id });
    createdIds.push(row.id);

    const started = Date.now();
    await processContract(row.id, (m) => process.stdout.write(`  ${m}\n`));
    process.stdout.write(`  took ${Math.round((Date.now() - started) / 1000)}s\n\n`);

    const rows = await db
      .select()
      .from(findings)
      .where(and(eq(findings.contractId, row.id), eq(findings.userId, EVAL_USER)));
    const byKey = new Map(rows.map((r) => [r.itemKey, r]));

    for (const item of CHECKLIST) {
      const expected = expectedRaw[file][item.key] ?? [];
      const actual = byKey.get(item.key);
      const status = actual?.status ?? "missing";
      const correct = expected.includes(status);

      scored.push({
        file,
        itemKey: item.key,
        expected,
        actual: status,
        correct,
        quoteVerified: actual?.quoteVerified ?? false,
        summary: actual?.summary ?? "",
      });

      const mark = correct ? "PASS" : "FAIL";
      const quote = actual?.quoteVerified ? "quote verified" : actual?.quote ? "quote UNVERIFIED" : "no quote";
      process.stdout.write(
        `  ${mark}  ${item.label.padEnd(24)} ${status.padEnd(10)} (expected ${expected.join(" or ")})  [${quote}]\n`,
      );
      if (!correct) process.stdout.write(`        summary: ${actual?.summary ?? "-"}\n`);
    }
  }

  // ---- report ---------------------------------------------------------------------------
  const total = scored.length;
  const passed = scored.filter((s) => s.correct).length;
  const shouldQuote = scored.filter((s) => s.actual === "found");
  const quoted = shouldQuote.filter((s) => s.quoteVerified).length;

  process.stdout.write(`\n${"=".repeat(62)}\n`);
  process.stdout.write(`checklist items correct : ${passed}/${total} (${Math.round((passed / total) * 100)}%)\n`);
  process.stdout.write(
    `"found" with a verified quote: ${quoted}/${shouldQuote.length}` +
      (shouldQuote.length ? ` (${Math.round((quoted / shouldQuote.length) * 100)}%)\n` : "\n"),
  );

  const failures = scored.filter((s) => !s.correct);
  if (failures.length) {
    process.stdout.write(`\nfailures:\n`);
    for (const f of failures) {
      process.stdout.write(`  ${f.file} / ${f.itemKey}: got ${f.actual}, expected ${f.expected.join(" or ")}\n`);
    }
  }

  // Every "found" must carry a quote that is really in the contract. That is the invariant the
  // whole design rests on, so it is reported separately and fails the run.
  const unverified = shouldQuote.filter((s) => !s.quoteVerified);
  if (unverified.length) {
    process.stdout.write(
      `\nWARNING: ${unverified.length} item(s) reported "found" without a verified quote.\n`,
    );
  }

  // Clean up: this is a scratch user, and leaving its rows behind would pollute the next run.
  for (const id of createdIds) {
    await db.delete(contracts).where(and(eq(contracts.id, id), eq(contracts.userId, EVAL_USER)));
  }

  await sql.end({ timeout: 5 });
  process.exit(failures.length || unverified.length ? 1 : 0);
}

run().catch(async (err) => {
  console.error("\nevaluation failed:", err);
  await db.delete(contracts).where(eq(contracts.userId, EVAL_USER)).catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
