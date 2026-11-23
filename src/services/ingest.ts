/**
 * Everything that happens to a contract after it is uploaded, in one place.
 *
 * This runs in the worker, never in a request. A 20 MB PDF takes tens of seconds to extract and
 * minutes to embed against a rate-limited free endpoint; doing that inside the upload request
 * would hold a connection open, block the event loop during parsing, and lose the work entirely
 * if the server restarted. The API writes a row with status "processing" and enqueues; this is
 * the consumer.
 */
import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { chunks, contracts } from "@/db/schema";
import { chunkDocument } from "./chunk";
import { extractText, UnsupportedFileError } from "./extract";
import { embedBatch, RateLimitError } from "./llm";
import { reviewContract } from "./review";

export type IngestLogger = (message: string) => void;

export async function processContract(
  contractId: string,
  log: IngestLogger = () => {},
): Promise<void> {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) throw new Error(`contract ${contractId} not found`);

  try {
    await setStatus(contractId, "processing", "Reading the document");

    const buffer = await readFile(contract.storagePath);
    const extraction = await extractText(buffer, contract.mimeType, contract.filename);
    log(`extracted ${extraction.fullText.length} chars over ${extraction.pageCount} page(s)`);

    await db
      .update(contracts)
      .set({
        fullText: extraction.fullText,
        pageMap: extraction.pages,
        pageCount: extraction.pageCount,
        hasRealPages: extraction.hasRealPages,
        statusDetail: "Splitting into clauses",
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    const drafts = chunkDocument(extraction.fullText, extraction.pages);
    if (!drafts.length) throw new Error("the document produced no text chunks");
    log(`chunked into ${drafts.length} pieces`);

    // Re-processing replaces chunks rather than adding a second copy.
    await db.delete(chunks).where(eq(chunks.contractId, contractId));

    await setStatus(contractId, "processing", `Embedding ${drafts.length} clauses`);
    const vectors = await embedBatch(drafts.map((d) => d.content));

    // Insert in batches: one statement with hundreds of 2048-float vectors is a very large
    // query, and a failure halfway through a single giant insert tells you nothing.
    const BATCH = 50;
    for (let i = 0; i < drafts.length; i += BATCH) {
      const slice = drafts.slice(i, i + BATCH);
      await db.insert(chunks).values(
        slice.map((d, j) => ({
          contractId,
          userId: contract.userId,
          ordinal: d.ordinal,
          content: d.content,
          sectionLabel: d.sectionLabel,
          pageFrom: d.pageFrom,
          pageTo: d.pageTo,
          charStart: d.charStart,
          charEnd: d.charEnd,
          embedding: vectors[i + j],
        })),
      );
    }
    log(`embedded and stored ${drafts.length} chunks`);

    await setStatus(contractId, "processing", "Running the checklist");
    await reviewContract(contractId, contract.userId, (done, total, key) =>
      log(`checklist ${done}/${total}: ${key}`),
    );

    await setStatus(contractId, "reviewed", null);
    log("done");
  } catch (err) {
    // The stored message is what the user reads on the contract page, so it is a sentence, not
    // the provider's raw JSON. The full error still goes to the worker log for debugging.
    console.error(`[${contractId}] ingest failed:`, err);

    await setStatus(contractId, "failed", userFacingMessage(err));
    throw err;
  }
}

/**
 * A sentence a person can act on.
 *
 * The daily-cap case gets its own wording because it is the single most likely failure on a free
 * key, it is not the user's fault, and the fix is specific: wait for the reset, or raise the cap.
 * Dumping the provider's JSON here would tell them nothing they can use.
 */
function userFacingMessage(err: unknown): string {
  if (err instanceof RateLimitError) {
    const daily = /free-models-per-day|per-day|daily/i.test(err.message);
    return daily
      ? "OpenRouter's daily free-model limit has been reached, so this contract could not be " +
          "processed. The limit resets at 00:00 UTC. Adding credits to the OpenRouter account " +
          "raises it from 50 to 1,000 requests a day."
      : "OpenRouter is rate-limiting requests right now. This usually clears within a minute - " +
          "upload the contract again shortly.";
  }

  if (err instanceof UnsupportedFileError) return err.message;

  const raw = (err as Error)?.message ?? "Unknown error";
  // Strip an embedded JSON body: it is noise on screen and it can carry request detail.
  const cleaned = raw.split(/\s*\{"error"/)[0].trim();
  return (cleaned || "The contract could not be processed.").slice(0, 300);
}

async function setStatus(
  contractId: string,
  status: "processing" | "reviewed" | "failed",
  detail: string | null,
): Promise<void> {
  await db
    .update(contracts)
    .set({ status, statusDetail: detail, updatedAt: new Date() })
    .where(eq(contracts.id, contractId));
}
