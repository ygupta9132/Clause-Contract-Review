/**
 * Schema migration, run as `npm run db:push`.
 *
 * This is hand-written idempotent SQL rather than `drizzle-kit push` on purpose. `push` compares
 * the live schema to the models and asks interactive questions when it is unsure, which hangs in
 * a container, and it answers some of those questions by dropping data. A migration that runs
 * unattended in docker-compose has to be deterministic.
 *
 * Drizzle is still the query layer; it is only the migration step that is plain SQL.
 */
import "dotenv/config";

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");

const DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? 2048);
if (!Number.isInteger(DIMS) || DIMS < 8 || DIMS > 16000) {
  throw new Error(`EMBEDDING_DIMENSIONS looks wrong: ${process.env.EMBEDDING_DIMENSIONS}`);
}

async function main() {
  const sql = postgres(url!, { max: 1, connect_timeout: 15 });

  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS contracts (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       text NOT NULL,
        filename      text NOT NULL,
        mime_type     text NOT NULL,
        size_bytes    integer NOT NULL,
        storage_path  text NOT NULL,
        status        text NOT NULL DEFAULT 'processing',
        status_detail text,
        page_count    integer,
        full_text     text,
        -- [{page, start, end}] character spans, so a verified quote can be mapped to a page.
        page_map      jsonb,
        has_real_pages boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chunks (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id   uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        user_id       text NOT NULL,
        ordinal       integer NOT NULL,
        content       text NOT NULL,
        section_label text,
        page_from     integer,
        page_to       integer,
        char_start    integer NOT NULL,
        char_end      integer NOT NULL,
        embedding     vector(${DIMS}),
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS findings (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id      uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        user_id          text NOT NULL,
        item_key         text NOT NULL,
        status           text NOT NULL,
        summary          text NOT NULL,
        quote            text,
        section_label    text,
        page_number      integer,
        quote_verified   boolean NOT NULL DEFAULT false,
        quote_char_start integer,
        quote_char_end   integer,
        chunk_id         uuid REFERENCES chunks(id) ON DELETE SET NULL,
        created_at       timestamptz NOT NULL DEFAULT now()
      )
    `);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        user_id     text NOT NULL,
        role        text NOT NULL,
        content     text NOT NULL,
        citations   jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    /**
     * Embedding width is part of the column type, and it changes when the embedding model
     * changes - a different provider returns a different number of dimensions.
     *
     * CREATE TABLE IF NOT EXISTS silently leaves the old width in place, and the failure then
     * appears much later as an unreadable "expected N dimensions, not M" from inside an insert.
     * So the width is checked explicitly, and a mismatch rebuilds the column.
     *
     * Existing vectors cannot be converted - they are a different model's output and comparing
     * them would be meaningless - so they are deleted and the contracts that own them are
     * marked for re-upload. That is destructive, so it says so loudly.
     */
    const [current] = await sql.unsafe(`
      SELECT a.atttypmod AS dims
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'chunks' AND a.attname = 'embedding' AND a.attnum > 0
    `);

    if (current && Number(current.dims) > 0 && Number(current.dims) !== DIMS) {
      const [{ count }] = await sql.unsafe(`SELECT count(*)::int AS count FROM chunks`);
      console.warn(
        `\n!! embedding width is changing from ${current.dims} to ${DIMS}.\n` +
          `!! ${count} chunk(s) were produced by a different model and cannot be reused.\n` +
          `!! Deleting them. Any contract already processed must be uploaded again.\n`,
      );
      await sql.unsafe(`DELETE FROM chunks`);
      await sql.unsafe(`ALTER TABLE chunks DROP COLUMN embedding`);
      await sql.unsafe(`ALTER TABLE chunks ADD COLUMN embedding vector(${DIMS})`);
      await sql.unsafe(`
        UPDATE contracts
           SET status = 'failed',
            status_detail = 'The embedding model changed, so this contract needs to be uploaded again.'
        WHERE status = 'reviewed'
      `);
    }

    // One finding per checklist item per contract. Re-running a review updates in place instead
    // of stacking duplicates, and a concurrent re-run cannot produce two rows for one item.
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS findings_contract_item_uniq
        ON findings (contract_id, item_key)
    `);

    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS contracts_user_created_idx
        ON contracts (user_id, created_at DESC)
    `);
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS chunks_contract_idx ON chunks (contract_id, ordinal)
    `);
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_user_idx ON chunks (user_id)`);
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS findings_contract_idx ON findings (contract_id)`);
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS chat_contract_created_idx
        ON chat_messages (contract_id, created_at)
    `);

    // Keyword half of the hybrid search.
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS chunks_content_trgm_idx
        ON chunks USING gin (content gin_trgm_ops)
    `);

    /**
     * No ANN index on the embedding, and that is a decision rather than an omission.
     *
     * Every vector query here is filtered to one contract first, so the candidate set is a few
     * hundred rows and an exact scan is faster than an approximate index. On top of that,
     * pgvector's hnsw and ivfflat cap out at 2000 dimensions for the `vector` type, and the
     * suggested embedding model returns 2048. Indexing those would mean an expression index on
     * `embedding::halfvec(2048)` and matching casts in every query - real cost, no benefit at
     * this size.
     *
     * If this ever searched across all contracts at once, the index below is the one to add:
     *   CREATE INDEX chunks_embedding_hnsw ON chunks
     *     USING hnsw ((embedding::halfvec(${DIMS})) halfvec_cosine_ops);
     */

    console.log(`migration ok (embedding dimensions: ${DIMS})`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
