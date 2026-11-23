import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    // The database tests talk to the real Postgres from docker-compose. They create their own
    // rows under a random user id and delete exactly those rows afterwards. Nothing here
    // truncates a table: a test suite that wipes a shared database is a bad afternoon.
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
