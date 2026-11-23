import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Must match the embedding model's output size. Read at schema-definition time, so changing it
 * means re-running `npm run db:push` and re-embedding every contract.
 */
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 2048);

export const CONTRACT_STATUSES = ["processing", "reviewed", "failed"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const FINDING_STATUSES = ["found", "not_found", "unclear"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * `userId` is the Clerk user id, and it is on every table rather than only on `contracts`.
 *
 * That denormalisation is deliberate. A join is a thing a developer can forget; a `where userId`
 * on the table being queried is not. It means the vector search, the findings query and the chat
 * history query each carry their own tenant predicate instead of inheriting one, so a missing
 * join cannot silently widen the result set.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    status: text("status").$type<ContractStatus>().notNull().default("processing"),
    statusDetail: text("status_detail"),
    pageCount: integer("page_count"),
    /** The extracted plain text, kept so quote verification can run against the source. */
    fullText: text("full_text"),
    /** Character span of each page, so a verified quote can be mapped back to a page number. */
    pageMap: jsonb("page_map").$type<{ page: number; start: number; end: number }[]>(),
    /** False for DOCX and TXT, which have no fixed pages; the UI cites sections instead. */
    hasRealPages: boolean("has_real_pages").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contracts_user_created_idx").on(t.userId, t.createdAt)],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    /** Section heading this chunk belongs to, e.g. "7.2 Termination". Null when unnumbered. */
    sectionLabel: text("section_label"),
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    /** Offsets into contracts.fullText, so the UI can show the clause in context. */
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chunks_contract_idx").on(t.contractId, t.ordinal),
    index("chunks_user_idx").on(t.userId),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** Stable key from src/checklist.ts, e.g. "termination". */
    itemKey: text("item_key").notNull(),
    status: text("status").$type<FindingStatus>().notNull(),
    summary: text("summary").notNull(),
    quote: text("quote"),
    sectionLabel: text("section_label"),
    pageNumber: integer("page_number"),
    /**
     * False when the model returned a quote that does not appear in the contract. The pipeline
     * downgrades those to "unclear" rather than showing an invented clause.
     */
    quoteVerified: boolean("quote_verified").notNull().default(false),
    /** Offsets of the verified quote inside contracts.fullText. Null when unverified. */
    quoteCharStart: integer("quote_char_start"),
    quoteCharEnd: integer("quote_char_end"),
    chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("findings_contract_idx").on(t.contractId)],
);

export type Citation = {
  chunkId: string;
  quote: string;
  sectionLabel: string | null;
  pageNumber: number | null;
  verified: boolean;
};

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<Citation[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_contract_created_idx").on(t.contractId, t.createdAt)],
);

export type Contract = typeof contracts.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
