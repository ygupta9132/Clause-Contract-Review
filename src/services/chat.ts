/**
 * Grounded follow-up questions.
 *
 * Same contract as the checklist review: the answer comes from retrieved excerpts, it quotes the
 * clause, and a quote that is not in the contract is not presented as one. The difference is
 * that the answer streams, so verification cannot happen before the user sees the text - it
 * happens as the stream closes, and the citations that arrive afterwards carry the verdict.
 */
import type { ChatMessage as LlmMessage } from "./llm";
import type { RetrievedChunk } from "./retrieve";
import { findQuote } from "./verify";
import { pageAt, type PageSpan } from "./extract";
import type { Citation } from "@/db/schema";

export const CHAT_SYSTEM_PROMPT = `You answer questions about one contract, using only the excerpts provided.

Rules:
- Answer ONLY from the excerpts. You have no other knowledge of this contract.
- If the excerpts do not answer the question, say exactly: "The contract does not cover this."
  Do not guess, and do not describe what contracts usually say.
- Support every claim by quoting the contract word for word inside double quotes.
- Keep it short: two or three sentences, then the quote.
- Never invent a clause, a number, a date or a party name.`;

export function buildChatMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: { role: "user" | "assistant"; content: string }[],
): LlmMessage[] {
  const excerpts = chunks.length
    ? chunks
        .map((c, i) => {
          const where = [
            c.sectionLabel ? `section: ${c.sectionLabel}` : null,
            c.pageFrom ? `page ${c.pageFrom}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          return `--- EXCERPT ${i + 1}${where ? ` (${where})` : ""} ---\n${c.content}`;
        })
        .join("\n\n")
    : "(no relevant excerpts were found in this contract)";

  // Only the last few turns: a long history crowds out the excerpts, and the excerpts are what
  // keeps the answer grounded.
  const recent = history.slice(-6).map((m) => ({ role: m.role, content: m.content }) as LlmMessage);

  return [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    ...recent,
    {
      role: "user",
      content: `Excerpts from the contract:\n\n${excerpts}\n\nQuestion: ${question}`,
    },
  ];
}

/**
 * Models sometimes escape quotation marks inside plain prose, as if they were writing a JSON
 * string: `1.1 \"Services\" means...`. Two things go wrong if that is left alone. The reader
 * sees the backslashes, and quote extraction breaks - the regex below treats an escaped quote
 * as a closing one, so a single quotation is parsed as two overlapping fragments and the answer
 * shows the same citation twice.
 *
 * Unescaping at the boundary is more reliable than asking the model not to do it.
 */
export function unescapeQuotes(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Double-quoted spans in the answer, which is where the model is told to put its evidence. */
export function extractQuotedSpans(answer: string): string[] {
  const found: string[] = [];
  const pattern = /"([^"]{12,})"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(unescapeQuotes(answer))) !== null) found.push(match[1].trim());

  // A quotation often appears twice in one answer - once inside a sentence and once in full -
  // so drop any span that is contained in a longer one. Longest first makes that a single pass.
  const unique = Array.from(new Set(found)).sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const span of unique) {
    if (!kept.some((k) => k.includes(span))) kept.push(span);
  }
  return kept;
}

/**
 * Check each quote in a finished answer against the contract.
 *
 * An unverified quote is still returned, flagged false, rather than dropped. The user has
 * already read it in the streamed text; hiding the citation would leave them with a quotation
 * and no warning. Showing it marked "not found in the contract" is the honest outcome.
 */
export function verifyAnswerCitations(
  answer: string,
  fullText: string,
  pages: PageSpan[],
  chunks: RetrievedChunk[],
): Citation[] {
  const seen = new Set<string>();

  const citations = extractQuotedSpans(answer).map((quote) => {
    const match = findQuote(fullText, quote);
    if (!match) {
      return { chunkId: "", quote, sectionLabel: null, pageNumber: null, verified: false };
    }
    const containing = chunks.find(
      (c) => match.start >= c.charStart && match.start <= c.charEnd,
    );
    return {
      chunkId: containing?.id ?? "",
      quote: match.text,
      sectionLabel: containing?.sectionLabel ?? null,
      pageNumber: pages.length ? pageAt(pages, match.start) : (containing?.pageFrom ?? null),
      verified: true,
      _span: `${match.start}:${match.end}`,
    } as Citation & { _span?: string };
  });

  // Two different quote strings can resolve to the same span of the contract. Cite it once.
  return citations
    .filter((c) => {
      const key = (c as { _span?: string })._span ?? `u:${c.quote}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ ...c }) => {
      delete (c as { _span?: string })._span;
      return c as Citation;
    });
}
