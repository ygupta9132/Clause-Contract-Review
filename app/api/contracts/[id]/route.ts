/**
 * GET    /api/contracts/:id  - the contract, its findings, and the clause behind each finding
 * DELETE /api/contracts/:id  - delete it
 *
 * Both start with loadOwnedContract, which returns 404 for an id that exists but belongs to
 * someone else. There is no code path in this file that reads a contract any other way.
 */
import { unlink } from "node:fs/promises";

import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { CHECKLIST } from "@/checklist";
import { db } from "@/db";
import { chunks, contracts, findings } from "@/db/schema";
import { loadOwnedContract, requireUserId } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const contract = await loadOwnedContract(id, userId);

    const rows = await db
      .select({
        itemKey: findings.itemKey,
        status: findings.status,
        summary: findings.summary,
        quote: findings.quote,
        sectionLabel: findings.sectionLabel,
        pageNumber: findings.pageNumber,
        quoteVerified: findings.quoteVerified,
        quoteCharStart: findings.quoteCharStart,
        quoteCharEnd: findings.quoteCharEnd,
        // The surrounding clause, so "click to see the full clause" needs no second request.
        clause: chunks.content,
      })
      .from(findings)
      .leftJoin(chunks, eq(findings.chunkId, chunks.id))
      .where(and(eq(findings.contractId, id), eq(findings.userId, userId)))
      .orderBy(asc(findings.itemKey));

    const byKey = new Map(rows.map((r) => [r.itemKey, r]));

    // Always return all eight items in checklist order, so the UI renders a stable list while
    // the review is still running rather than reordering as rows appear.
    const items = CHECKLIST.map((item) => ({
      key: item.key,
      label: item.label,
      description: item.description,
      finding: byKey.get(item.key) ?? null,
    }));

    return NextResponse.json({
      contract: {
        id: contract.id,
        filename: contract.filename,
        sizeBytes: contract.sizeBytes,
        status: contract.status,
        statusDetail: contract.statusDetail,
        pageCount: contract.pageCount,
        hasRealPages: contract.hasRealPages,
        createdAt: contract.createdAt,
      },
      items,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const contract = await loadOwnedContract(id, userId);

    // Chunks, findings and chat messages go with it through ON DELETE CASCADE.
    await db
      .delete(contracts)
      .where(and(eq(contracts.id, id), eq(contracts.userId, userId)));

    // The row is the source of truth; a leftover file is untidy, not a correctness problem, so
    // a failure to unlink must not fail the request.
    await unlink(contract.storagePath).catch(() => {});

    return NextResponse.json({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
