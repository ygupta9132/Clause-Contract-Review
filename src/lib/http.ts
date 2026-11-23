/**
 * One place that turns a thrown error into a response.
 *
 * Without this every route grows its own try/catch and they drift: one returns 403 where
 * another returns 404, one leaks a stack trace. Routes throw typed errors; this decides the
 * status and what the client is allowed to see.
 */
import { NextResponse } from "next/server";

import { NotFoundError, UnauthorizedError } from "./auth";
import { RateLimitError, UpstreamError } from "@/services/llm";
import { UnsupportedFileError } from "@/services/extract";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }

  // 404 rather than 403 for someone else's contract: a 403 would confirm the id exists.
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }

  if (err instanceof ValidationError || err instanceof UnsupportedFileError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  if (err instanceof RateLimitError) {
    return NextResponse.json(
      {
        error: err.message,
        retryAfterSeconds: err.retryAfterSeconds ?? 30,
        kind: "rate_limited",
      },
      { status: 429 },
    );
  }

  if (err instanceof UpstreamError) {
    return NextResponse.json({ error: err.message, kind: "upstream" }, { status: 502 });
  }

  // Anything unrecognised is logged in full and reported in outline. The message of an unknown
  // error can contain a connection string or a row of someone's data.
  console.error("unhandled route error:", err);
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}
