/**
 * GET  /api/contracts  - the signed-in user's contracts
 * POST /api/contracts  - upload one
 *
 * The upload does as little as possible: validate, write the bytes, insert a row with status
 * "processing", enqueue, return. Extraction, embedding and the checklist happen in the worker.
 * A 20 MB PDF therefore never occupies a request.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { contracts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { errorResponse, ValidationError } from "@/lib/http";
import { enqueueIngest } from "@/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024);

const ALLOWED: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
  "text/markdown": ".txt",
};
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);

export async function GET() {
  try {
    const userId = await requireUserId();

    const rows = await db
      .select({
        id: contracts.id,
        filename: contracts.filename,
        sizeBytes: contracts.sizeBytes,
        status: contracts.status,
        statusDetail: contracts.statusDetail,
        pageCount: contracts.pageCount,
        createdAt: contracts.createdAt,
      })
      .from(contracts)
      .where(eq(contracts.userId, userId))
      .orderBy(desc(contracts.createdAt));

    return NextResponse.json({ contracts: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();

    /**
     * Check the declared size before parsing the body.
     *
     * A body over the limit is rejected by the framework while it is being read, so
     * `formData()` throws and the user is told their request is not multipart - which is both
     * wrong and impossible to act on. Content-Length is a claim rather than a fact, so the real
     * size is still checked below; this is only here to produce the right message.
     */
    const declared = Number(request.headers.get("content-length") ?? 0);
    // Multipart adds boundaries and headers around the file, hence the small allowance.
    if (declared > MAX_BYTES + 8 * 1024) {
      throw new ValidationError(
        `That file is ${(declared / 1024 / 1024).toFixed(1)} MB. The limit is ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      );
    }

    const form = await request.formData().catch(() => {
      throw new ValidationError("Send the file as multipart/form-data with a 'file' field.");
    });

    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("No file was uploaded.");
    if (file.size === 0) throw new ValidationError("That file is empty.");
    if (file.size > MAX_BYTES) {
      throw new ValidationError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      );
    }

    // Trust the extension over the browser's content type, which is unreliable for DOCX, but
    // require both to be plausible.
    const originalName = path.basename(file.name || "contract");
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED[file.type]) {
      throw new ValidationError("Upload a PDF, DOCX or TXT file.");
    }

    const contractId = randomUUID();
    const uploadDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "data", "uploads");
    await mkdir(uploadDir, { recursive: true });

    // The stored name is the contract id, never the user's filename: a name like
    // "../../etc/passwd" or a duplicate upload cannot touch anything it should not.
    const storagePath = path.join(uploadDir, `${contractId}${ext || ".bin"}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(storagePath, bytes);

    await db.insert(contracts).values({
      id: contractId,
      userId,
      filename: originalName,
      mimeType: file.type || ALLOWED[ext] || "application/octet-stream",
      sizeBytes: file.size,
      storagePath,
      status: "processing",
      statusDetail: "Queued",
    });

    await enqueueIngest({ contractId, userId });

    return NextResponse.json(
      { id: contractId, filename: originalName, status: "processing" },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
