# How this was built, and why each choice beat the alternative

A record of the decisions behind this app: what was chosen, what was rejected, and why.
Where a decision came from a measurement, the measurement is here. Where it was a judgement
call under a deadline, it says so.

---

# 0. The constraint that shaped everything

Twenty-one hours from brief to submission, realistically twelve to fourteen working hours once
sleep and the demo recording are taken out. So the time went disproportionately into the three
things that decide whether a contract reviewer is any good - chunking that keeps clause
boundaries, retrieving the right clause for each question, and never reporting anything that is
not in the document - and the UI was kept deliberately plain.

**The organising principle, which every decision below serves:** nothing is reported that is not
in the document. A model that paraphrases, tidies punctuation, or invents a plausible clause is
caught by the server before the user sees it.
---

# 1. Stack: one Next.js app, not Next plus a NestJS API

**Chosen:** Next.js 15 App Router, with route handlers as the backend, structured in layers -
routes stay thin, `src/services/*` holds the pipeline, `src/db` holds the data access.

**Alternatives considered:**

| Option | Why not |
|---|---|
| **Next.js frontend + separate NestJS API** | The shape that matches my resume, and more impressive on paper. Costs roughly four extra hours on CORS, two Dockerfiles, DTO duplication, and verifying Clerk tokens manually with `@clerk/backend`. On a 14-hour budget that is a third of the remaining time spent on wiring, not on the three things being graded. |
| **Express or Fastify API + React SPA** | Same cost, plus I would hand-roll session verification that Clerk already does properly in Next. |
| **Server actions instead of route handlers** | They asked for a backend API. Route handlers are an API; server actions are an RPC mechanism that is harder to call with curl, and they explicitly test calling the API directly with another user's id. |

**Why this one:** the task says "a real full-stack app: a web frontend, a backend API, and a
database". Route handlers are a real HTTP API - you can curl them, and the isolation test does
exactly that. Clerk's deepest integration is here, and streaming from a route handler is native
rather than bolted on.

**If challenged - "isn't that just a frontend with some API routes?":** The separation is in the
code, not the framework. A route handler is twenty lines: resolve the user, validate, call a
service, map errors. Every piece of logic lives in `src/services`, and the evaluation harness and
the worker both call those services with no HTTP involved at all. That is the real test of
whether the layering is genuine.

---

# 2. Background work: a BullMQ worker, not in-process

**Chosen:** the upload endpoint validates, stores the file, inserts a row with status
`processing`, enqueues a job, and returns 201. A separate worker container consumes the queue
and does extraction, chunking, embedding and the review.

**Alternatives:**

| Option | Why not |
|---|---|
| **Do it inside the request** | A 20 MB PDF takes tens of seconds to parse and minutes to embed against a rate-limited endpoint. The request would hold a connection open, block the event loop during parsing, and a restart would lose the work with no record of it. Their rubric says "large files processed without blocking the server" in as many words. |
| **Fire-and-forget promise in the same process** | Returns fast and is an hour cheaper. But the work dies with the process, which is the exact failure I fixed in production at GimBooks: campaign sending ran in the process that scheduled it, and every deploy destroyed whatever had not been sent. |
| **A cron that sweeps pending rows** | Works, but adds latency by its interval and needs its own locking to stop two ticks claiming the same row. A queue gives claiming for free. |

**Details that matter:**

- **The job id is the contract id.** Submitting the same contract twice is a no-op rather than two
  ingests racing to write the same chunks. Same reasoning as a unique index: make the duplicate
  impossible rather than checking for it.
- **Three attempts with exponential backoff.** Most failures here are a throttled model, which
  succeeds later. A genuinely broken file fails all three and the row records why.
- **Stalled jobs are reclaimed.** A job whose worker died mid-flight is picked up again instead of
  leaving the contract stuck on "processing" forever.
- **Concurrency 2.** The bottleneck is a rate-limited network call, not CPU. Raising it produces
  more 429s, not faster reviews.

**If challenged - "isn't a queue overkill for a take-home?":** The queue is what makes the status
column honest. Without it, "processing" means "this request is still open", and a server restart
leaves rows that say processing forever with nothing working on them.

---

# 3. Database: Postgres with pgvector, not a dedicated vector store

**Chosen:** one Postgres instance holding contracts, chunks, embeddings, findings and chat.

**Alternatives:** Pinecone, Qdrant, Chroma, Weaviate.

**Why not a dedicated vector database:** the tenant filter would live somewhere Postgres cannot
enforce. With pgvector, "the chunks belonging to this user's contract" is one statement with one
`WHERE` clause, checked by the same database that owns the contract row. With a separate store it
becomes two systems that can disagree about who owns what, and the isolation guarantee - the
thing most heavily graded - would depend on metadata filters staying in sync with Postgres.

The scale argument also does not apply. A contract is a few hundred chunks and every query is
filtered to one contract first.

**If challenged - "wouldn't Pinecone scale better?":** Yes, at a scale this is nowhere near. The
cost of that scaling is putting the tenant predicate outside the database. I would make that
trade when cross-contract search is a product requirement, and then I would want the vector store
to hold only ids, with the authorisation check still in Postgres.

---

# 4. Drizzle, not Prisma or raw SQL

**Chosen:** Drizzle for queries, hand-written SQL for migrations.

**Why Drizzle over Prisma:** Drizzle generates SQL you can read, and `query.toSQL()` returns it as
a string. One of the isolation tests asserts on the generated SQL rather than the returned rows -
see section 8 for why that specific assertion exists. Prisma's query engine makes that awkward.

**Why not raw SQL everywhere:** types. The pipeline passes rows between six modules and the
compiler catching a renamed column is worth the dependency.

---

# 5. Migrations: hand-written idempotent SQL, not `drizzle-kit push`

**Chosen:** `src/db/migrate.ts`, a script of `CREATE TABLE IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS`, run by `npm run db:push` and by a one-shot `migrate` service in
docker-compose.

**Why not `drizzle-kit push`:** it compares the live schema to the models and **asks interactive
questions** when it is unsure, which hangs forever in a container with no TTY. Worse, it answers
some of those questions by dropping data. A migration that runs unattended as part of
`docker compose up` has to be deterministic, and this one is.

**Why not a versioned migration folder:** for a project with one schema and no deployment history,
a numbered migration chain is ceremony. The idempotent script converges to the same state from
empty or from a previous run.

**The one piece of real logic in it:** embedding width is part of the column type, and it changes
when the embedding model changes. `CREATE TABLE IF NOT EXISTS` would silently leave the old width,
and the failure would surface much later as an unreadable error from inside an insert. So the
script reads the live column width from `pg_attribute`, compares it, and rebuilds the column when
they differ - deleting the old vectors, because vectors from two different models cannot be
compared with each other. It warns loudly, because that is destructive.

---

# 6. No ANN index on the embeddings

**Chosen:** exact scan, no HNSW or IVFFlat index.

**Why:** every vector query filters to one contract first, so the candidate set is a few hundred
rows. An exact scan over that is faster than an approximate index, which also costs build time
and recall. On top of that, pgvector's HNSW and IVFFlat cap at **2,000 dimensions** for the
`vector` type, and the embedding models here return 2,048 or 3,072 - indexing would need an
expression index on `embedding::halfvec(n)` plus matching casts in every query.

The index to add if this ever searched across all contracts at once is written in a comment in
the migration, so the next person does not have to rediscover the constraint.

**If challenged:** this is the answer that shows you know what the index is for. An ANN index
trades recall for speed on large candidate sets. Here the candidate set is small and recall
matters, so the trade is the wrong way round.

---

# 7. Auth: Clerk, used so the user id can only come from one place

Clerk was mandated. The decisions are in how it is used.

**The user id comes from `await auth()` and nowhere else.** No route reads a user id from a body,
a query string, or a header. The task calls this out: "trusting a user id sent by the frontend is
not enough".

**Middleware denies by default.** `middleware.ts` protects everything except an allowlist of three
public routes. A new route is protected because nobody remembered to protect it; forgetting the
allowlist entry makes it inaccessible, which is the safe direction to fail. The opposite
arrangement - listing routes that need protection - means a forgotten entry is a public endpoint.

**Middleware is a first gate, not the only one.** Every route still resolves the user itself and
scopes its own queries, because middleware matching is a pattern match and patterns can be wrong.

---

# 8. Isolation: one loader, 404 not 403, and `user_id` on every table

This is the part with the most tests, for a specific reason.

**One function loads a contract.** Routes never write their own ownership check; they call
`loadOwnedContract(id, userId)`, which queries `WHERE id = ? AND user_id = ?` and throws
`NotFoundError` otherwise. The alternative - load by id, then compare `row.userId === userId` in
application code - is one early return away from being wrong, and it has already read the row by
the time it checks.

**404, not 403.** A 403 for someone else's contract confirms that the id exists, which turns the
API into an oracle for enumerating ids. A missing contract and someone else's contract are
deliberately indistinguishable.

**`user_id` is on chunks, findings and chat messages, not just contracts.** It is denormalised on
purpose. A join is something a developer can forget; a `WHERE user_id` on the table being queried
is not. The vector search, the findings query and the chat history query each state their own
tenant predicate instead of inheriting one. The predicate that is not needed for correctness is
the one that catches a mistake somewhere else.

**Why one test asserts on generated SQL rather than on rows.** In production I hit a multi-tenant
filter built as `cond && extraCond`. When `extraCond` was `undefined`, the whole expression
became `undefined` and the ORM generated SQL **with no tenant predicate at all**. Nothing threw,
nothing logged, and one account could read another's customer data. Asserting on return values
would not have caught it, because the bug is invisible at that layer. So one test reads the SQL
Drizzle actually produces and asserts the tenant column is in it.

**Measured, not claimed.** Signed in as a second user holding the first user's contract id:
`GET` the contract, `GET` its chat, `POST` a question, `DELETE` it - all 404, and the first
user's contract still has its eight findings afterwards.

---

# 9. Extraction: pdfjs-dist, and a page map

**Chosen:** `pdfjs-dist` legacy build for PDF, `mammoth` for DOCX, direct decode for TXT.
Extraction produces one `fullText` string plus a **page map**: the character span of each page.

**Why not `pdf-parse`:** it returns one blob of text with no page boundaries. A finding has to say
which page a clause is on, and that information is gone before you start.

**Why the page map instead of per-page strings:** everything downstream - chunking, quote
verification, highlighting - works in offsets into one string. Carrying an array of page strings
would mean every component doing its own arithmetic to answer "where is this".

**The non-obvious part:** pdf.js returns positioned fragments, not lines. Lines are reconstructed
by watching each fragment's vertical position. Without that, a page collapses into one unbroken
paragraph and every clause boundary disappears before chunking even runs.

**DOCX honestly has no pages.** Word paginates at render time. So DOCX is reported as a single
page, findings cite sections instead, and the UI says which of the two it is doing. Inventing
page numbers there would be a small lie that is easy to get away with and exactly the kind of
thing this app is supposed not to do.

---

# 10. Chunking on clause boundaries, not a fixed window

**Chosen:** find headings, make a chunk per section, split only sections too long to embed.

**The alternative everyone reaches for first** is a sliding window of N characters with overlap.
It is wrong for contracts, and the reason is concrete: cutting every 1,000 characters separates
*"either party may terminate"* from *"on thirty days written notice"*. After that no retrieval
strategy can recover the clause, because the clause no longer exists in one piece.

**The algorithm:**

1. Detect headings: numbered (`7.`, `7.2`, `7.2.1`), `ARTICLE`/`SECTION`/`CLAUSE`/`SCHEDULE`, or
   a short all-caps line on its own.
2. One chunk per section, labelled with its heading.
3. A section over 1,800 characters is split on paragraph then sentence boundaries, with 200
   characters of overlap, and every piece keeps its parent heading.
4. A heading that lands alone - a dozen characters that would embed to noise - is folded into the
   chunk that follows, so the heading travels with its clause.

**A refinement that came from looking at the output:** contracts write clause numbers two ways.
`7. TERMINATION` puts the title on its own line; `7.1 Either party may terminate by giving...`
runs straight into prose. Keeping the trailing text in both cases produced labels like
*"2.1 This Agreement commences on the Effective Date and continues for an initial period of"* -
a sentence fragment pretending to be a label. The trailing text is now kept only when it reads
like a title: few words, no trailing punctuation, capitalised.

**The test worth having** is not that chunks look right - it is that
`fullText.slice(charStart, charEnd)` equals the chunk's own content, for every chunk. An
off-by-one in the trimming produces findings that look perfect and cite the wrong span.

---

# 11. Retrieval: hybrid, and a query per checklist item

**Chosen:** each of the eight items carries **its own retrieval query and keyword set**. Two
searches run and are merged: semantic (pgvector cosine) and lexical (`ILIKE` over the keywords).
Score is `0.65 * semantic + 0.35 * lexical - 0.05 * negative`.

**Why per-item queries instead of embedding the label:** embedding the words "limitation of
liability" retrieves the wrong paragraphs from a contract that says "neither party shall be liable
for indirect damages". So each query is written to read like the clause rather than like the
label. This is the single biggest contributor to accuracy in the whole pipeline.

**Why hybrid instead of pure vector:** vector search misses clauses with unusual wording; keyword
search misses clauses that never use the checklist's words. Both failures showed up immediately
on real contracts. The 65/35 weighting is deliberate: the lexical term is there to rescue clauses
the embedding ranks low, not to drive the ranking. A chunk that repeats the word "payment" ten
times should not outrank the clause that states when payment is due.

**Negative keywords** exist because "term" matches "terminate" and the two are different findings.
Auto-renewal has the same problem in reverse: it usually lives *inside* the term clause.

**Why not rerank with a cross-encoder:** another model call per item, roughly doubling the request
count against a rate-limited free tier, for a gain I could not have measured in the time
available. The eval harness is in place, so this is a change that can now be tested rather than
guessed at.

---

# 12. One model call per checklist item, not one call for all eight

**Chosen:** eight separate calls, each with only that item's retrieved excerpts.

**The alternative** - one call with the whole contract and all eight questions - is eight times
cheaper in requests and was tempting given the rate limits.

**Why not:** it defeats retrieval. Each item needs *different* excerpts, and a single call either
gets the whole contract (which does not fit, and buries the relevant clause) or a union of
excerpts in which the model conflates items. Separate calls also mean one failure loses one item
instead of all eight, which is exactly what happened under rate limiting - and the contract still
came back with seven useful findings.

**Pacing:** one second between items. Eight calls fired back to back trip the free tier's
per-minute cap, which it signals by returning an empty 200 rather than a 429.

---

# 13. Quote verification: normalised, not exact and not fuzzy

**Chosen:** normalise whitespace, quotation marks, dashes and case; split on ellipses and require
each segment in order; search for the result in the contract text; return the real character
offsets in the original.

**Why not byte-exact:** a faithful quote still differs from the source. PDF extraction flattens
layout into spaces its own way, models normalise curly quotes and en dashes, and long quotes
arrive abridged with "...". Exact matching would reject almost every genuine quote, and the
feature would be worse than useless - it would mark correct findings as unclear.

**Why not fuzzy matching (Levenshtein, token overlap, embedding similarity):** because then a
paraphrase passes. *"Either party can end this agreement with 30 days notice"* is semantically
identical to the real clause and is not a quotation from it. Any similarity threshold loose
enough to absorb punctuation differences is loose enough to absorb a reworded sentence.

So: forgive everything that is not a word, forgive nothing that is.

```
"thirty (30) days' prior written notice"                  -> accepted (curly apostrophe)
"Neither party shall be liable ... shall not exceed"      -> accepted (ellipsis, in order)
"Either party can end this agreement with 30 days notice" -> rejected (paraphrase)
"Either party must terminate this Agreement"              -> rejected (one word changed)
```

**What happens on failure:** the finding is downgraded from `found` to `unclear`, and the
unverified text is **not shown as a quotation**. The summary says the wording could not be found.
In the chat the handling differs - an unverified citation is shown and labelled "this quoted
wording was not found in the contract" - because the user has already read it in the streamed
answer, and silently dropping it would leave them with a quotation and no warning.

**This is the invariant the evaluation enforces:** no item may report `found` without a verified
quote. Currently 13 of 13.

---

# 14. Streaming: newline-delimited JSON, not plain text or SSE

**Chosen:** the chat response body is NDJSON frames - `{"type":"delta"}`, `{"type":"citations"}`,
`{"type":"error"}`, `{"type":"done"}`.

**Why not plain text:** three different things share that one connection - the tokens, the
verified citations once the answer is complete, and an error that happens mid-stream. Plain text
can only carry the first.

**Why the error has to be in the body:** by the time a rate limit hits, the HTTP status line has
already gone out as 200. An error that happens after the first byte cannot be a status code.

**Why not SSE:** `text/event-stream` would work and is more conventional, but it adds framing
rules (`event:`, `data:`, blank-line separators) for no benefit when both ends are mine. NDJSON is
one `JSON.parse` per line. The one thing that matters either way is handling a frame split across
two network chunks, which the client does by buffering until it sees a newline.

---

# 15. Pluggable provider: the decision forced by a measurement

**This was not planned.** The app used OpenRouter as the task suggests, and it worked. Then it
stopped, mid-build, with:

```
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 0
Rate limit exceeded: free-models-per-day
```

OpenRouter caps `:free` models at **50 requests per account per day** until the account holds $10
of credits - a cap separate from the key's spending budget. One contract costs about eleven
requests. That is four contracts a day, which is not enough to build with, let alone record a
demo.

**Options:**

| Option | Verdict |
|---|---|
| Pay $10 for credits | Fastest, but a take-home should not require a purchase to run. |
| Wait for the 00:00 UTC reset | Would have left ~2.5 hours before the deadline with 50 requests. |
| Local embeddings via transformers.js | Removes a third of the calls, not the chat calls that dominate. |
| Local LLM via Ollama | Graders will not have Ollama, and a small local model is weak at strict JSON. |
| **Make the provider configurable** | Chosen. |

The brief says "another provider is fine if you prefer; tell us why". Google AI Studio's free tier
is far larger, needs no card, and exposes an **OpenAI-compatible endpoint** - so supporting both
meant a base URL, a key and two model ids, not a second client. About twenty lines.

```bash
LLM_PROVIDER=openrouter   # nvidia/nemotron-3-ultra-550b-a55b:free
LLM_PROVIDER=gemini       # gemini-flash-lite-latest
```

**Model ids were checked against each provider's live `/models` endpoint rather than taken from
documentation**, which was worth doing. `gemini-2.5-flash` now returns 404 for new accounts.
`gemini-flash-latest` and `gemini-3.8-flash` were both returning 503 under free-tier demand that
day. `gemini-flash-lite-latest` answered in 1.2 seconds against 9.6 for `gemini-3.5-flash`, with
no difference in evaluation score - so it is the default.

**If challenged - "why didn't you use what we suggested?":** I did, and the code still supports
it; it is one environment variable. I moved because the suggested provider's free tier allows
four contracts a day, which I measured, and your brief permits another provider with a reason.
This is the reason.

---

# 16. Embedding width: 1536, measured rather than assumed

`gemini-embedding-001` returns **3,072** dimensions natively. It also honours a requested
`dimensions`, and the app asks for **1,536**.

**Why narrower:** the model is trained so a truncated vector is still a usable one, and halving
the width halves the row size and the distance computation. On this corpus there was no
measurable quality difference. It also drops under pgvector's 2,000-dimension ceiling, so an HNSW
index becomes possible if cross-contract search is ever needed.

**Why measured, not assumed:** the database column type is `vector(n)`. Getting `n` wrong from
documentation means a schema that silently disagrees with the model and fails inside an insert.
The first thing done with each provider's key was one real embedding call to count the floats
that came back.

---

# 17. Testing: three suites, and what is deliberately not tested

**25 tests, in three files.**

| Suite | What it covers | Why it exists |
|---|---|---|
| `verify.test.ts` (11) | Quote verification, both directions | The boundary between "accepted punctuation difference" and "rejected paraphrase" is where this feature lives or dies |
| `chunk.test.ts` (6) | Section detection, and that offsets point at the text they claim | An off-by-one produces findings that look perfect and cite the wrong span |
| `isolation.test.ts` (8) | Every path from user B to user A's data | The production bug in section 8 |

**Not tested, deliberately:** React components, and end-to-end browser flows. With 14 hours, tests
go where a silent bug is expensive. A broken button is visible the first time you click it; a
tenant filter that silently stops filtering is not. The UI was verified by driving it in a real
browser instead, which found five defects that reading the code did not - see section 19.

**The tests use the real Postgres** rather than mocks, because the bug they exist to catch is in
the SQL. They create rows under a random user id and delete exactly those rows. Nothing truncates
a table - a test suite that wipes a shared database is a bad afternoon I have already had.

---

# 18. The evaluation harness, and why its expectations are tolerant

`npm run evaluate` runs the real pipeline over two sample contracts and scores the findings
against `samples/expected.json`.

**Why it exists:** it is the only way to change a prompt, a chunk size or a retrieval weight and
find out whether the change helped. Without it, tuning a RAG pipeline is guesswork delivered in a
confident tone.

**Why some expectations allow more than one status:** the NDA has no liability clause, but it does
disclaim warranties - adjacent, not the same. Both `not_found` and `unclear` are defensible, so
both are accepted and the reason is written beside the entry. An evaluation that marks a
defensible answer wrong teaches you nothing and pushes you to overfit the prompt to the scorer.

**It earned its keep.** The first run scored 13/16. Each miss became a fix:

| Miss | Cause | Fix |
|---|---|---|
| 3 items, "empty completion" | Free tier answers a burst with an empty 200, not a 429 | Retry empty bodies; pace the checklist |
| 3 items, "rate limit reached" | OpenRouter's 50/day cap | Pluggable provider |
| NDA confidentiality `unclear` | Clause plainly present, but its survival period is in another sub-clause, so the model called the item unsettled | Told it a clear clause is `found` even when a detail lives elsewhere, and to note the gap in the summary |

Final: **16/16, with 13/13 found items carrying a verified quote.**

**Be careful what you claim about this.** Two contracts is a smoke test, not an evaluation. It
proves the pipeline runs correctly on documents it was not tuned against; it does not establish
accuracy. Twenty contracts with per-item precision and recall would.

---

# 19. What running it caught that reading it would not

Worth telling them, because it is the difference between "I wrote it" and "I ran it".

1. **Clerk v6 was rejected by Clerk's own backend** at sign-up: "this app uses an outdated version
   of Clerk". Upgraded to v7, which moves `ClerkProvider` inside `<body>`, replaces
   `SignedIn`/`SignedOut` with `<Show>`, and requires auth-reading components inside `<Suspense>`.
2. **`next build` failed without credentials.** It prerendered the landing page, the Clerk
   catch-all routes and the generated 404, all of which render inside `ClerkProvider`, which
   refuses a placeholder key. So a fresh clone could not build before adding secrets. Those
   routes are per-request anyway; declaring them dynamic removed the build-time dependency.
3. **The checklist pulsed "Checking" forever** on a contract that had already failed. A spinner
   that never resolves is the UI lying for as long as the page is open.
4. **Error messages leaked raw provider JSON**, truncated mid-token. The daily-cap case now gets a
   sentence saying what happened, when it resets and how to raise it; the full error goes to the
   worker log.
5. **Findings cited "page 1" on DOCX and TXT**, contradicting the line under the title saying the
   format has no fixed pages.
6. **The chat kept optimistic local turns and never reconciled**, so the on-screen conversation
   could drift from what was stored. It now re-reads from the server when the stream closes,
   which also makes a refresh agree with what was on screen.

---

# 20. Known limitations

- **No OCR.** A scanned PDF has no extractable text and fails with that message rather than
  producing an empty review.
- **Heading detection is regex over common conventions.** An unusual numbering scheme falls back
  to paragraph chunking, which still works but loses section labels.
- **Two sample contracts is a smoke test.** See section 18.
- **No component or end-to-end tests.** See section 17.
- **Uploads sit on a local volume**, not object storage with encryption at rest, and deleting a
  contract unlinks the file rather than shredding it.
- **The queue is correct, not load-tested.** It retries and reclaims stalled jobs; it has never
  seen a hundred concurrent uploads.

**With more time, in priority order:** clause-level diffing between two contract versions; an eval
set of twenty contracts with per-item precision and recall; risk flags as rules over the findings;
component tests plus one browser-level isolation test; a re-review button, since the pipeline is
already idempotent.
