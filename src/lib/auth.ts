/**
 * Server-side authentication and the single ownership check.
 *
 * Clerk's `auth()` verifies the session token on the server from the request cookie or
 * Authorization header. The user id comes from that verified token and from nowhere else - no
 * route reads a user id from a body, a query string or a header the client controls. That is the
 * difference between "scoped to the signed-in user" and "scoped to whoever the client says".
 *
 * `loadOwnedContract` is the only way a route gets a contract. Routes cannot forget the
 * predicate because they never write one: the function will not return a row that belongs to
 * someone else. A missing contract and someone else's contract are deliberately the same result,
 * so the API cannot be used to discover which ids exist.
 */
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { contracts, type Contract } from "@/db/schema";

export class UnauthorizedError extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The signed-in user's id, or throw. Every route starts here. */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();
  return userId;
}

/**
 * Load a contract that belongs to this user, or throw NotFoundError.
 *
 * Note the `and(eq(id), eq(userId))`: both predicates in one statement. An earlier habit of
 * loading by id and then comparing `row.userId === userId` in application code is one early
 * return away from being wrong, and it has already read the row by then.
 */
export async function loadOwnedContract(
  contractId: string,
  userId: string,
): Promise<Contract> {
  if (!isUuid(contractId)) throw new NotFoundError();

  const [row] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.userId, userId)))
    .limit(1);

  if (!row) throw new NotFoundError();
  return row;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
