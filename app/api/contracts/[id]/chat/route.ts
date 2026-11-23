/**
 * GET  /api/contracts/:id/chat  - the conversation so far
 * POST /api/contracts/:id/chat  - ask a question, stream the answer
 *
 * The response is newline-delimited JSON rather than plain text, because the client needs three
 * different things on one connection: the tokens as they arrive, the verified citations once the
 * answer is complete, and an error that happens mid-stream. Plain text cannot carry the second
 * two, and by the time a rate limit hits, the HTTP status has already been sent as 200.
 *
 *   {"type":"delta","text":"..."}
 *   {"type":"citations","citations":[...]}
 *   {"type":"error","error":"...","kind":"rate_limited"}
 *   {"type":"done"}
 */
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { chatMessages } from "@/db/schema";
import { loadOwnedContract, requireUserId } from "@/lib/auth";
import { errorResponse, ValidationError } from "@/lib/http";
import { buildChatMessages, unescapeQuotes, verifyAnswerCitations } from "@/services/chat";
import { chatStream, embedOne, RateLimitError } from "@/services/llm";
import { matchChecklistItem, retrieveForQuestion } from "@/services/retrieve";
import type { PageSpan } from "@/services/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await loadOwnedContract(id, userId);

    const messages = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        citations: chatMessages.citations,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(and(eq(chatMessages.contractId, id), eq(chatMessages.userId, userId)))
      .orderBy(asc(chatMessages.createdAt));

    return NextResponse.json({ messages });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const contract = await loadOwnedContract(id, userId);

    if (contract.status !== "reviewed") {
      throw new ValidationError(
        contract.status === "processing"
          ? "This contract is still being processed. Try again once the review finishes."
          : "This contract failed to process, so there is nothing to ask about.",
      );
    }

    const body = (await request.json().catch(() => ({}))) as { question?: unknown };
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) throw new ValidationError("Ask a question.");
    if (question.length > 1000) throw new ValidationError("That question is too long.");

    const history = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.contractId, id), eq(chatMessages.userId, userId)))
      .orderBy(asc(chatMessages.createdAt));

    await db.insert(chatMessages).values({
      contractId: id,
      userId,
      role: "user",
      content: question,
    });

    /**
     * Retrieval happens before the stream opens, so a failure here is still a real HTTP error
     * the client can show, rather than an error frame inside a 200 response.
     *
     * When the question is clearly about one of the eight checklist items, that item's query -
     * written to read like the clause rather than to name it - is embedded alongside the
     * question. It costs no extra call, and it is the difference between finding the preamble
     * and answering "the contract does not cover this" for "who are the parties".
     */
    const matchedItem = matchChecklistItem(question);
    const embedText = matchedItem ? `${question}
${matchedItem.query}` : question;
    const questionVector = await embedOne(embedText);
    const chunks = await retrieveForQuestion(userId, id, questionVector, question);

    const llmMessages = buildChatMessages(question, chunks, history);
    const fullText = contract.fullText ?? "";
    const pages = (contract.pageMap ?? []) as PageSpan[];

    const encoder = new TextEncoder();
    const frame = (obj: unknown) => encoder.encode(`${JSON.stringify(obj)}\n`);

    const stream = new ReadableStream({
      async start(controller) {
        let answer = "";
        try {
          for await (const delta of chatStream(llmMessages)) {
            answer += delta;
            controller.enqueue(frame({ type: "delta", text: delta }));
          }

          // Store the cleaned text: a reader should never see a model's stray backslashes, and
          // a reload should show exactly what the stream showed.
          const clean = unescapeQuotes(answer);
          const citations = verifyAnswerCitations(clean, fullText, pages, chunks);

          await db.insert(chatMessages).values({
            contractId: id,
            userId,
            role: "assistant",
            content: clean,
            citations,
          });

          controller.enqueue(frame({ type: "citations", citations }));
          controller.enqueue(frame({ type: "done" }));
        } catch (err) {
          const rateLimited = err instanceof RateLimitError;
          controller.enqueue(
            frame({
              type: "error",
              kind: rateLimited ? "rate_limited" : "upstream",
              error: rateLimited
                ? "The free model is rate-limited right now. Wait a moment and ask again."
                : `The answer could not be completed: ${(err as Error).message.slice(0, 200)}`,
            }),
          );

          // Persist whatever did arrive, so a refresh does not show a question with no answer.
          if (answer.trim()) {
            await db
              .insert(chatMessages)
              .values({
                contractId: id,
                userId,
                role: "assistant",
                content: `${unescapeQuotes(answer)}\n\n(This answer was cut short.)`,
                citations: verifyAnswerCitations(
                  unescapeQuotes(answer),
                  fullText,
                  pages,
                  chunks,
                ),
              })
              .catch(() => {});
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Without this a proxy can buffer the whole response and defeat the streaming.
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
