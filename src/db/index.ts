import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * The connection is created on first use, not when this module is imported.
 *
 * Next imports every route module during `next build` to collect page data, so anything that
 * throws at import time makes the build depend on run-time configuration. Reading
 * DATABASE_URL eagerly meant the image only built because `.env` was being copied into it -
 * and the moment a .dockerignore stopped that (which it should, those are secrets), the build
 * failed with "DATABASE_URL is not set".
 *
 * Deferring it means a clone builds with no credentials at all, and a missing URL is reported
 * on the first query, where it is actionable, rather than during a build that has no business
 * needing a database.
 */
const globalForDb = globalThis as unknown as {
  __sql?: ReturnType<typeof postgres>;
  __db?: ReturnType<typeof drizzle>;
};

function connect(): ReturnType<typeof postgres> {
  if (globalForDb.__sql) return globalForDb.__sql;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, or start the database with " +
        "`docker compose up -d postgres redis`.",
    );
  }

  const client = postgres(url, {
    max: 10,
    // The worker holds long transactions while embedding; the default idle timeout is fine,
    // but a short connect timeout surfaces a wrong DATABASE_URL immediately instead of hanging.
    connect_timeout: 10,
  });

  // Next re-evaluates modules on every hot reload in development, which would open a new pool
  // each time until Postgres refused connections.
  globalForDb.__sql = client;
  return client;
}

function database(): ReturnType<typeof drizzle> {
  if (!globalForDb.__db) globalForDb.__db = drizzle(connect(), { schema });
  return globalForDb.__db;
}

/**
 * `sql` is callable as a tagged template and also carries methods such as `end` and `unsafe`,
 * so the proxy forwards both. `db` only needs property access.
 */
export const sql = new Proxy((() => {}) as unknown as ReturnType<typeof postgres>, {
  apply(_target, _thisArg, args: unknown[]) {
    return (connect() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, property) {
    const client = connect() as unknown as Record<string | symbol, unknown>;
    const value = client[property];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, property) {
    const instance = database() as unknown as Record<string | symbol, unknown>;
    const value = instance[property];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export { schema };
