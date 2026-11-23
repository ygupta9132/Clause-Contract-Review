/**
 * Hybrid retrieval, always scoped to one user and one contract.
 *
 * Vector search alone misses clauses whose wording is unusual, and keyword search alone misses
 * clauses that never use the checklist's words. Both failures showed up immediately on real
 * contracts, so each query runs two cheap searches and merges them:
 *
 *   - semantic: cosine distance against the item's query embedding, done in Postgres by pgvector
 *   - lexical:  how many of the item's keywords appear in the chunk, done with ILIKE
 *
 * Every statement carries `user_id = $user AND contract_id = $contract`. Scoping by contract
 * alone would be enough to return the right rows, which is exactly why the user predicate is
 * there too: the one that is not needed for correctness is the one that catches a mistake
 * elsewhere. An id guessed from another account matches nothing.
 */
import { CHECKLIST, type ChecklistItem } from "@/checklist";
import { sql } from "@/db";

export type RetrievedChunk = {
  id: string;
  content: string;
  sectionLabel: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  charStart: number;
  charEnd: number;
  similarity: number;
  keywordHits: number;
  score: number;
};

type Row = {
  id: string;
  content: string;
  section_label: string | null;
  page_from: number | null;
  page_to: number | null;
  char_start: number;
  char_end: number;
  similarity: number | null;
};

const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;

export type RetrieveOptions = {
  userId: string;
  contractId: string;
  queryEmbedding: number[];
  keywords?: string[];
  negativeKeywords?: string[];
  limit?: number;
  /** How many candidates each half contributes before re-ranking. */
  candidates?: number;
};

export async function retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const {
    userId,
    contractId,
    queryEmbedding,
    keywords = [],
    negativeKeywords = [],
    limit = 6,
    candidates = 20,
  } = opts;

  const vec = toVectorLiteral(queryEmbedding);

  const semantic = (await sql`
    SELECT id, content, section_label, page_from, page_to, char_start, char_end,
           1 - (embedding <=> ${vec}::vector) AS similarity
    FROM chunks
    WHERE contract_id = ${contractId}
      AND user_id = ${userId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${candidates}
  `) as unknown as Row[];

  // Lexical half. ILIKE ANY over the keyword list, ranked by how many distinct keywords hit.
  let lexical: Row[] = [];
  if (keywords.length) {
    const patterns = keywords.map((k) => `%${k}%`);
    lexical = (await sql`
      SELECT id, content, section_label, page_from, page_to, char_start, char_end,
             NULL::float AS similarity
      FROM chunks
      WHERE contract_id = ${contractId}
        AND user_id = ${userId}
        AND content ILIKE ANY (${patterns})
      LIMIT ${candidates}
    `) as unknown as Row[];
  }

  const byId = new Map<string, RetrievedChunk>();
  const add = (row: Row) => {
    if (byId.has(row.id)) {
      // Already seen from the other half; keep the similarity if this row carries it.
      const existing = byId.get(row.id)!;
      if (row.similarity != null) existing.similarity = row.similarity;
      return;
    }
    byId.set(row.id, {
      id: row.id,
      content: row.content,
      sectionLabel: row.section_label,
      pageFrom: row.page_from,
      pageTo: row.page_to,
      charStart: row.char_start,
      charEnd: row.char_end,
      similarity: row.similarity ?? 0,
      keywordHits: 0,
      score: 0,
    });
  };
  semantic.forEach(add);
  lexical.forEach(add);

  const results = [...byId.values()];
  if (!results.length) return [];

  // Score. Similarity is already 0..1 for cosine on normalised vectors; clamp defensively
  // because a model that returns unnormalised vectors can push it outside that range.
  const maxHits = Math.max(1, keywords.length);
  for (const chunk of results) {
    const haystack = chunk.content.toLowerCase();
    chunk.keywordHits = keywords.filter((k) => haystack.includes(k.toLowerCase())).length;
    const penalty = negativeKeywords.filter((k) => haystack.includes(k.toLowerCase())).length;

    const semanticScore = Math.min(1, Math.max(0, chunk.similarity));
    const lexicalScore = chunk.keywordHits / maxHits;

    // 65/35 in favour of meaning. The lexical term is there to rescue clauses the embedding
    // ranks low, not to drive the ranking: a chunk that merely repeats the word "payment" many
    // times should not outrank the clause that states when payment is due.
    chunk.score = 0.65 * semanticScore + 0.35 * lexicalScore - 0.05 * penalty;
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Which checklist item, if any, is this question really about?
 *
 * The checklist items carry retrieval queries written to read like the clause, and those are
 * what make the review accurate. A chat question has only the user's own words, which is
 * measurably worse: "who are the parties to this agreement" found nothing on a contract whose
 * preamble never uses the word "parties" - it says "by and between X and Y". The review found
 * them easily, because its query describes the clause rather than naming it.
 *
 * So when a question is clearly about one of the eight, that item's vocabulary is borrowed.
 * Matching on the item's own keywords plus its label, and requiring two hits, keeps it from
 * firing on questions that merely share a common word.
 */
export function matchChecklistItem(question: string): ChecklistItem | null {
  const text = question.toLowerCase();
  const questionWords = text.split(/[^a-z]+/).filter(Boolean);
  let best: { item: ChecklistItem; score: number } | null = null;

  for (const item of CHECKLIST) {
    // Signals are namespaced, so a word appearing in both the keywords and the label counts
    // as the two independent pieces of evidence it is: "parties" is the only word that
    // identifies that item, and demanding two *different* words would never match it.
    const signals = new Set<string>();

    for (const keyword of item.keywords) {
      if (text.includes(keyword.toLowerCase())) signals.add(`kw:${keyword.toLowerCase()}`);
    }

    // Label words are matched on a stem, because a question conjugates them: the item is
    // "Governing law" and the question says "governs", the item is "Auto-renewal" and the
    // question says "automatically renew".
    for (const word of item.label.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3)) {
      const stem = word.slice(0, Math.max(5, word.length - 3));
      // Word-prefix match rather than a regex: `\b` inside a template literal is a backspace
      // character, not a word boundary, which is an easy way to write a pattern that silently
      // never matches.
      if (questionWords.some((w) => w.startsWith(stem))) signals.add(`lbl:${word}`);
    }

    // Two signals. One common word on its own - "company", "term" - is not enough to borrow a
    // whole item's vocabulary.
    const score = signals.size;
    if (score >= 2 && (!best || score > best.score)) best = { item, score };
  }

  return best?.item ?? null;
}

/** Used by the chat route, where the query is the user's question rather than a checklist item. */
export async function retrieveForQuestion(
  userId: string,
  contractId: string,
  queryEmbedding: number[],
  question: string,
  limit = 6,
): Promise<RetrievedChunk[]> {
  // Content words from the question become the lexical signal. Stopwords would match everything.
  const fromQuestion = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  // Borrow the matched checklist item's keywords, which are written for the clause rather than
  // for the way someone asks about it.
  const matched = matchChecklistItem(question);
  const keywords = Array.from(
    new Set([...fromQuestion, ...(matched ? matched.keywords : [])]),
  ).slice(0, 20);

  return retrieve({
    userId,
    contractId,
    queryEmbedding,
    keywords,
    negativeKeywords: matched?.negativeKeywords,
    limit,
  });
}

const STOPWORDS = new Set([
  "what", "when", "where", "which", "does", "this", "that", "they", "there", "their", "have",
  "has", "with", "from", "about", "into", "under", "over", "will", "would", "could", "should",
  "contract", "agreement", "clause", "tell", "give", "show", "explain", "please", "there's",
  "then", "than", "also", "much", "many", "long", "happens", "happen", "anything", "something",
]);
