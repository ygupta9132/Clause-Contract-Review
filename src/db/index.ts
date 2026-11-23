import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env, or start the database with " +
      "`docker compose up -d postgres redis`.",
  );
}

// Next re-evaluates modules on every hot reload in development, which would open a new pool
// each time until Postgres refused connections.
const globalForDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.__sql ??
  postgres(url, {
    max: 10,
    // A short connect timeout surfaces a wrong DATABASE_URL immediately instead of hanging.
    connect_timeout: 10,
  });

globalForDb.__sql = sql;

export const db = drizzle(sql, { schema });

export { schema };
