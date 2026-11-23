# Clause

Upload a contract, get it checked against eight things that matter, with the actual clause
quoted back at you and a page number so you can go and look.

The thing I cared most about: it should never make anything up. If a contract has no
auto-renewal clause, it says so. It does not tell you what contracts usually say.

---

## Running it

You need a Clerk app and a model provider key.

**Clerk:** make an app at https://dashboard.clerk.com, email sign-in is fine, copy the two keys
from the API keys page. Make two users while you are in there if you want to check the data
isolation yourself.

**Model provider:** either works.

- **Google AI Studio** (https://aistudio.google.com/apikey) is the default. Free, no card.
- **OpenRouter** (https://openrouter.ai/keys) is what the brief suggests and is fully
  supported. Fair warning about its free tier below.

Then:

```bash
cp .env.example .env     # fill in the keys
docker compose up --build
```

http://localhost:3000. The migrate container creates the schema before the app starts.

If you would rather run it directly:

```bash
docker compose up -d postgres redis
npm install
npm run db:push
npm run dev            # terminal 1
npm run dev:worker     # terminal 2
```

For that path set `DATABASE_URL` to `localhost:5433`, `REDIS_URL` to `localhost:6380` and
`UPLOAD_DIR` to `./data/uploads`. Host ports are deliberately off the defaults so this does not
fight with a Postgres you already have running. Do not run both paths at once, they both want
port 3000 and two workers on one queue will squabble over jobs.

```bash
npm test          # 52 tests
npm run evaluate  # runs the real pipeline over two contracts and scores it
```

Ten sample contracts live in [`samples/`](samples), in PDF, DOCX and TXT. They are deliberately
different from each other rather than ten variations of one agreement, and
[`samples/README.md`](samples/README.md) says what each is for. The three-page PDF is the
interesting one, because that is where page citations show up.

### About OpenRouter's free tier

Worth knowing before you pick it. OpenRouter caps `:free` models at **50 requests per account
per day** until the account has $10 of credits, and that cap is separate from the key's spending
budget. One contract costs about eleven requests, so a fresh free account gets you roughly four
contracts a day. I found that out by running out partway through building this.

That is why the provider is swappable and why Gemini is the default. The brief says another
provider is fine if you explain, so that is the explanation. Both speak the OpenAI shape, so
switching is one environment variable.

While I was in there I checked the model ids against each provider's live `/models` endpoint
rather than trusting the docs, which was worth the five minutes: `gemini-2.5-flash` 404s for new
accounts now, and two of the flash models were throwing 503s that day. I also measured the
embedding width with a real call instead of reading it, because the Postgres column type depends
on it.

---

## How it fits together

```
browser -> Next.js (pages + API) -> Postgres + pgvector
                     |
                     +-> Redis queue -> worker -> extract, chunk, embed, review
```

Upload does four cheap things and returns: validate, write the file, insert a row as
`processing`, put a job on the queue. Everything slow is the worker's problem. A 20 MB PDF takes
tens of seconds to parse and minutes to embed, and that has no business happening inside an HTTP
request. It also means a restart does not lose the work, which is the part I have been burned by
before.

```
app/        pages and API routes
src/
  checklist.ts    the eight items, each with its own search query
  services/       extract, chunk, retrieve, review, verify, chat, ingest, llm
  db/             schema, connection, migrations
  lib/            auth helpers, error handling
worker/     the queue consumer
samples/    ten contracts to try it on
tests/      52 of them
docs/       decisions, the test pass, and the demo recordings
```

Two things in [`docs/`](docs) worth more than this README if you want the detail.
[`decisions.md`](docs/decisions.md) is the long version: twenty decisions, what each one was
chosen over, and the measurement behind it where there was one. [`testing.md`](docs/testing.md)
is the pass I ran against the brief one requirement at a time, including the five defects it
found and what I did about them. [`docs/demo/`](docs/demo) has a recording of it running and a
short walk through the three files that matter, if that is easier than setting it up.

Stack is Next.js 15, Clerk, Postgres with pgvector, Drizzle, BullMQ, Tailwind. Nothing exotic.
Two choices worth a sentence each. The vectors stay in Postgres rather than in a separate vector
database, because then "this user's chunks" is one query with one WHERE clause and the database
enforces it. And migrations are plain idempotent SQL rather than `drizzle-kit push`, because
push asks interactive questions that hang in a container and sometimes answers them by dropping
your data.

---

## The part that actually matters

Three things make the difference between this working and not working.

### Chunking on clauses, not character counts

The obvious approach is a sliding window every thousand characters. It is wrong for contracts,
and it fails in a way you cannot recover from: it cuts "either party may terminate" away from
"on thirty days written notice", and once those are in separate chunks no retrieval strategy
will put the clause back together.

So the splits come from the document's own structure. Find the headings (numbered like `7.2`,
or `ARTICLE IV`, or a short line in capitals), make a chunk per section, and only split further
if a section is too long to embed, with overlap, keeping the heading attached.

Two things I only found by looking at real output. Contracts write clause numbers two ways,
`7. TERMINATION` on its own line versus `7.1 Either party may...` running straight into prose,
so trailing text is kept only when it reads like a title. And a bare number is only a clause
number if something follows it, otherwise "22 Finsbury Square, London" becomes "Section 22",
which it did.

There is a test asserting every chunk's stored offsets point at exactly its own text. An
off-by-one there gives you findings that look perfect and cite the wrong part of the document.

### Each checklist item gets its own search

This is the main reason accuracy is decent. Embedding the phrase "limitation of liability" does
not find a contract that says "neither party shall be liable for indirect damages". So every
item in [`src/checklist.ts`](src/checklist.ts) carries a query written to sound like the clause,
plus keywords:

```ts
{
  key: "limitation_of_liability",
  query: "Neither party shall be liable for indirect, incidental or consequential damages,
          and total aggregate liability shall not exceed the fees paid in the preceding
          twelve months.",
  keywords: ["liability", "aggregate liability", "shall not exceed", "consequential", ...],
}
```

Two searches run per item, semantic through pgvector and keyword through ILIKE, merged 65/35 in
favour of meaning. The keyword half is there to rescue clauses the embedding ranks badly, not to
drive the ranking.

A few items need extra handling. Term and termination collide constantly, so term carries
`negativeKeywords` for "terminate". Parties lives in the preamble, which usually has no heading
and often never uses the word "parties", so its keywords target recital grammar like "by and
between". Auto-renewal is the hard one, because it is normally a sentence buried inside the term
clause rather than its own section, so the instructions say explicitly that a term which simply
expires is "not found" and not "unclear".

The chat borrows all of this. If your question is clearly about one of the eight, it pulls that
item's query in too. Before I did that, asking "who are the parties?" got "the contract does not
cover this" on a contract whose preamble lists them by name.

### Checking the quote is real

This is what makes the rest trustworthy. The model proposes a quote, then the server goes and
looks for it in the contract. If it is not there, the finding drops to "unclear" and the made-up
text is not shown as a quotation.

The comparison has to be relaxed about punctuation and strict about words, because an honest
quote still differs from the source. PDF extraction mangles whitespace, models swap curly quotes
for straight and double for single, long quotes come back with an ellipsis in the middle. So
whitespace, quote marks, dashes and case are normalised, ellipses split the quote into segments
that must appear in order, and anything else is a rejection.

```
"thirty (30) days' prior written notice"                  accepted
"1.1 'Services' means the data processing"                accepted
"Either party can end this agreement with 30 days notice" rejected, that is a paraphrase
"Either party must terminate this Agreement"              rejected, one word changed
```

`npm run evaluate` scores the pipeline against known-correct results for two contracts. It sits
at **16/16 items correct, 13/13 found items carrying a verified quote**. It started at 13/16,
and every point since came from reading an actual failure rather than guessing: the free tier
answering a burst with an empty HTTP 200 instead of a 429, the daily cap, and a confidentiality
clause being called "unclear" because its survival period sat in a different sub-clause.

No item has ever come back "found" with an unverified quote. That is the invariant, and the
evaluation fails if it breaks.

---

## Keeping users apart

The brief asks that one user cannot reach another's contracts even by calling the API with a
known id. Four things, deliberately overlapping.

The user id comes from the verified Clerk session and nowhere else; no route reads it from a
body or a header. Middleware protects everything except three public routes, so a new route is
private unless somebody actively opens it. Every route gets its contract through one function,
`loadOwnedContract(id, userId)`, which puts both conditions in a single query and throws
otherwise, so no route can forget. And `user_id` sits on chunks, findings and chat messages too,
not just contracts, so the vector search carries its own tenant check rather than inheriting one
through a join.

Someone else's contract returns 404, not 403. A 403 tells you the id exists.

I checked this signed in as a second user holding the first user's contract id: GET, POST to
chat, and DELETE all came back 404, and the original contract was still there with its eight
findings.

This has more tests than anything else because I have watched it go wrong. A tenant filter built
as `cond && extra` where `extra` was undefined collapsed the whole expression, the ORM emitted
SQL with no tenant condition at all, nothing threw, nothing logged, and one account could read
another's data. Testing the return value would not have caught it, so one test here asserts on
the generated SQL instead.

---

## What it does not do

- No OCR, so a scanned PDF fails with that message rather than returning an empty review.
- Only two of the ten samples are actually scored. The rest I checked for extraction and
  chunking but not accuracy, because scoring them all is 66 model calls per run.
- Heading detection is regex over common conventions. The plain-English letter in `samples/` has
  no clause numbers at all and you can watch the section labels degrade on it. Findings stay
  right, citations get vaguer.
- No component or browser tests. The tests cover the places where a bug would be silent and
  expensive. The UI I checked by using it, which found six things reading the code had not.
- The Docker image is about 1.6 GB because it keeps dev dependencies. A multi-stage build with
  `--standalone` would cut that a lot. It works, so I left it.
- Uploads go to a local volume, not object storage, and delete unlinks rather than shreds.

If I had another day: diff two versions of the same contract and list what changed, which is the
feature a real reviewer would use most. Then twenty scored samples instead of two, because two
tells you the pipeline runs and twenty tells you whether a change helped.

---

## On AI tools

Used throughout, which the brief encourages. The architecture calls are mine: full-stack Next
rather than a separate API, a queue for the slow work, pgvector rather than a separate vector
store, hand-written migrations. So are the retrieval weighting, the per-item keyword lists, and
the decision to show an unverified quote as "unclear" rather than hide it.

Implementation was largely delegated and read back file by file. Debugging was not
conversational either. The empty-completion failures got solved by writing a probe that dumped
the whole response object, which showed a reasoning model burning 400 tokens before answering
and a free tier throttling with empty 200s.

The most useful habit was testing against the brief instead of against the happy path. That
found a 10 MB body limit quietly breaking the 20 MB upload requirement, `.env` being baked into
the Docker image by `COPY . .`, the chat failing on "who are the parties", address lines parsed
as clause headings, and a build that only worked because the secrets file was being copied in.
None of those were visible from reading the code.

I can walk through any file in here and tell you why it is that way.
