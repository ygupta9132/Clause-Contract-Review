/**
 * The review pipeline: eight checklist items, one grounded answer each.
 *
 * The design rule is that the model is never the last word. It proposes a status, a summary and
 * a quote from excerpts it was given; the code then checks the quote against the contract and
 * downgrades anything it cannot verify. A model that invents a plausible termination clause
 * produces "unclear", not a fabricated quotation.
 *
 * Order of operations per item:
 *   embed the item's query -> retrieve its clauses -> ask for a decision -> verify -> store
 */
import { eq } from "drizzle-orm";

import { CHECKLIST, type ChecklistItem } from "@/checklist";
import { db, sql } from "@/db";
import { contracts, type FindingStatus } from "@/db/schema";
import { pageAt, type PageSpan } from "./extract";
import { chatJson, embedBatch, type ChatMessage } from "./llm";
import { retrieve, type RetrievedChunk } from "./retrieve";
import { findQuote } from "./verify";
import { z } from "zod";

// `nullish` rather than `.default(null)`: a schema with defaults has a different input type from
// its output type, which makes it awkward to pass through the generic chatJson helper. The two
// fields are optional here and normalised where they are read.
const DecisionSchema = z.object({
  status: z.enum(["found", "not_found", "unclear"]),
  summary: z.string().min(1).max(400),
  quote: z.string().nullish(),
  excerpt: z.number().int().nullish(),
});
type Decision = z.infer<typeof DecisionSchema>;

const SYSTEM_PROMPT = `You review contracts. You answer only from the excerpts you are given.

Rules you must follow:
- Use ONLY the excerpts. Never use general knowledge about what contracts usually say.
- If the excerpts do not cover the item, answer "not_found". Never assume a standard clause.
- "unclear" is for when something related is present but does not actually settle the item.
  A clause that plainly covers the item is "found" even when a detail of it - a duration, a
  figure, an exception - is stated in a different clause you cannot see. Report what the clause
  does say, and note the missing detail in the summary. Do not downgrade a clear clause to
  "unclear" because it is incomplete.
- A quote must be copied WORD FOR WORD from an excerpt, including its punctuation. Never
  paraphrase, tidy or shorten a quote. Copy the sentence or sentences that carry the point.
- Quote ONE continuous passage. Do not join wording from two separate clauses into a single
  quote, and do not stitch together sentences that are not next to each other in the text.
  If the point spans several clauses, quote the one that states it most directly and mention
  the others in the summary.
- The summary is one plain-English line a non-lawyer understands, for example
  "Either party can end the contract with 30 days' written notice".

Reply with a JSON object only, in this exact shape:
{"status":"found|not_found|unclear","summary":"one line","quote":"word for word, or null","excerpt":<number of the excerpt the quote came from, or null>}`;

function buildUserPrompt(item: ChecklistItem, chunks: RetrievedChunk[]): string {
  if (!chunks.length) {
    return `Checklist item: ${item.label} - ${item.description}\n\nThere are no excerpts. Answer "not_found".`;
  }

  const excerpts = chunks
    .map((c, i) => {
      const where = [
        c.sectionLabel ? `section: ${c.sectionLabel}` : null,
        c.pageFrom ? `page ${c.pageFrom}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `--- EXCERPT ${i + 1}${where ? ` (${where})` : ""} ---\n${c.content}`;
    })
    .join("\n\n");

  return `Checklist item: ${item.label} - ${item.description}
${item.guidance}

Excerpts from the contract:

${excerpts}

Decide whether this contract covers "${item.label}". JSON only.`;
}

export type ReviewProgress = (done: number, total: number, itemKey: string) => void;

/**
 * Review one contract against the whole checklist and write the findings.
 * Assumes chunks already exist and are embedded.
 */
export async function reviewContract(
  contractId: string,
  userId: string,
  onProgress?: ReviewProgress,
): Promise<void> {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) throw new Error(`contract ${contractId} not found`);
  if (contract.userId !== userId) throw new Error("contract belongs to another user");
  const fullText = contract.fullText ?? "";
  const pages = (contract.pageMap ?? []) as PageSpan[];

  // All eight queries are static, so they embed in a single batched request rather than eight.
  const queryVectors = await embedBatch(CHECKLIST.map((i) => i.query));

  for (let i = 0; i < CHECKLIST.length; i++) {
    const item = CHECKLIST[i];
    const chunks = await retrieve({
      userId,
      contractId,
      queryEmbedding: queryVectors[i],
      keywords: item.keywords,
      negativeKeywords: item.negativeKeywords,
      limit: 6,
    });

    let decision: Decision;
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(item, chunks) },
      ];
      decision = await chatJson(messages, DecisionSchema, 0);
    } catch (err) {
      // One item failing must not lose the other seven.
      decision = {
        status: "unclear",
        summary: `Could not complete this check: ${(err as Error).message.slice(0, 160)}`,
        quote: null,
        excerpt: null,
      };
    }

    const stored = resolveFinding(decision, chunks, fullText, pages);
    await upsertFinding(contractId, userId, item.key, stored);
    onProgress?.(i + 1, CHECKLIST.length, item.key);

    // Pace the checklist. Eight calls fired back to back trip the free tier's per-minute cap,
    // which it signals by returning an empty body rather than a 429. A second between items
    // costs eight seconds per contract and removes most of those.
    if (i + 1 < CHECKLIST.length) await sleep(ITEM_DELAY_MS);
  }
}

const ITEM_DELAY_MS = Number(process.env.REVIEW_ITEM_DELAY_MS ?? 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ResolvedFinding = {
  status: FindingStatus;
  summary: string;
  quote: string | null;
  sectionLabel: string | null;
  pageNumber: number | null;
  quoteVerified: boolean;
  quoteCharStart: number | null;
  quoteCharEnd: number | null;
  chunkId: string | null;
};

/**
 * Turn the model's answer into a finding, verifying the quote on the way.
 *
 * This is where "found" can become "unclear": a status of found with a quote that is not in the
 * contract is exactly the failure the checker exists to catch.
 */
/**
 * A summary that tells the reader something.
 *
 * Models sometimes echo the status token back as the summary - literally "not_found" - and the
 * card then showed "Not found in the contract." followed by "not_found" underneath it. Anything
 * that is just the status, or empty, is replaced by the fallback sentence so there is nothing
 * redundant to render.
 */
function usefulSummary(summary: string | undefined, fallback: string): string {
  const text = (summary ?? "").trim();
  if (!text) return fallback;
  if (/^(not[_\s-]?found|unclear|found|n\/a|none)[.!]?$/i.test(text)) return fallback;
  return text;
}

export function resolveFinding(
  decision: Decision,
  chunks: RetrievedChunk[],
  fullText: string,
  pages: PageSpan[],
): ResolvedFinding {
  const sourceChunk =
    decision.excerpt != null && chunks[decision.excerpt - 1] ? chunks[decision.excerpt - 1] : null;

  if (decision.status === "not_found") {
    return {
      status: "not_found",
      summary: usefulSummary(decision.summary, "Not found in the contract."),
      quote: null,
      sectionLabel: null,
      pageNumber: null,
      quoteVerified: false,
      quoteCharStart: null,
      quoteCharEnd: null,
      chunkId: null,
    };
  }

  const quote = decision.quote?.trim() || null;
  const match = quote ? findQuote(fullText, quote) : null;

  if (!match) {
    return {
      status: "unclear",
      summary: quote
        ? `${decision.summary} (The quoted wording could not be found in the contract, so this is reported as unclear.)`
        : decision.summary,
      // Keep the unverified text out of the quote field: it is not a quotation from this contract.
      quote: null,
      sectionLabel: sourceChunk?.sectionLabel ?? null,
      pageNumber: sourceChunk?.pageFrom ?? null,
      quoteVerified: false,
      quoteCharStart: null,
      quoteCharEnd: null,
      chunkId: sourceChunk?.id ?? null,
    };
  }

  // Trust the located text over the model's copy, and the located page over the excerpt's.
  const pageNumber = pages.length ? pageAt(pages, match.start) : (sourceChunk?.pageFrom ?? null);
  const containing = chunks.find((c) => match.start >= c.charStart && match.start <= c.charEnd);

  return {
    status: decision.status,
    summary: decision.summary,
    quote: match.text,
    sectionLabel: containing?.sectionLabel ?? sourceChunk?.sectionLabel ?? null,
    pageNumber,
    quoteVerified: true,
    quoteCharStart: match.start,
    quoteCharEnd: match.end,
    chunkId: containing?.id ?? sourceChunk?.id ?? null,
  };
}

async function upsertFinding(
  contractId: string,
  userId: string,
  itemKey: string,
  f: ResolvedFinding,
): Promise<void> {
  // One row per (contract, item): re-running a review replaces the previous answer instead of
  // appending a second one. The unique index makes that atomic.
  await sql`
    INSERT INTO findings (
      contract_id, user_id, item_key, status, summary, quote, section_label, page_number,
      quote_verified, quote_char_start, quote_char_end, chunk_id
    ) VALUES (
      ${contractId}, ${userId}, ${itemKey}, ${f.status}, ${f.summary}, ${f.quote},
      ${f.sectionLabel}, ${f.pageNumber}, ${f.quoteVerified}, ${f.quoteCharStart},
      ${f.quoteCharEnd}, ${f.chunkId}
    )
    ON CONFLICT (contract_id, item_key) DO UPDATE SET
      status = EXCLUDED.status,
      summary = EXCLUDED.summary,
      quote = EXCLUDED.quote,
      section_label = EXCLUDED.section_label,
      page_number = EXCLUDED.page_number,
      quote_verified = EXCLUDED.quote_verified,
      quote_char_start = EXCLUDED.quote_char_start,
      quote_char_end = EXCLUDED.quote_char_end,
      chunk_id = EXCLUDED.chunk_id
  `;
}
