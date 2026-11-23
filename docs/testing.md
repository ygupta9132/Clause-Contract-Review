# Acceptance test against the IntelliBooks brief

Run 23 November 2026, 16:55 to 17:30 IST, against the running app with Gemini as the provider.
Every row was executed, not reasoned about. Where something failed it is written down, with
what was done about it.

---

## The ten functional requirements

| # | Requirement | Result |
|---|---|---|
| 1 | Sign up, sign in, sign out with Clerk | **Pass.** Two users created through the UI; sign-out and re-sign-in exercised. |
| 2 | A user cannot read, review or delete another's contracts, even via the API with a known id | **Pass.** As user B holding user A's id: GET contract 404, GET chat 404, POST chat 404, DELETE 404, and A's contract still intact with its 8 findings. |
| 3 | Upload PDF, DOCX or TXT up to 20 MB | **Failed, then fixed.** Anything over ~10 MB was rejected with a misleading parse error. See "Defects found" below. Now: 12 MB and 19 MB accepted, 21 MB rejected with the size message. |
| 4 | List with name, size, upload date and status | **Pass.** Status moves Queued -> Embedding n clauses -> Running the checklist -> Reviewed, polled live and the polling stops when nothing is processing. |
| 5 | Delete a contract | **Pass.** Four deleted through the API, all 200, rows gone, cascade removed chunks, findings and chat. Deleting the same id twice returns 404, not 500. |
| 6 | All eight checklist items checked | **Pass.** All eight resolve on every sample. |
| 7 | Per item: status, one-line summary, word-for-word quote with page or section, click for the full clause, honest "not found" | **Pass.** On a three-page PDF: 7 found with verified quotes citing pages 1, 2 and 3 and sections 2.1, 4.2, 8.1, 7.2, 6.1, 9.1; auto-renewal correctly not found. |
| 8 | Backend verifies every quote and marks the item unclear when it does not match | **Pass.** 23 tests cover the boundary in both directions. Observed live: a quote stitched from clauses 4.1 and 4.2 was rejected and the item downgraded to unclear. |
| 9 | Chat, grounded in the contract, with the clause quoted, streamed | **Pass**, after a fix. A longer answer arrived in 8 frames over 773 ms, so it genuinely streams. Citations carry page numbers. An unanswerable question returns "The contract does not cover this." |
| 10 | Review and chat history persist per contract across a refresh | **Pass.** Four chat messages re-read from the server with roles and citations intact. |

## Technology requirements

| Requirement | Result |
|---|---|
| Clerk session verified on the backend, every request | **Pass.** `auth()` server-side; no route reads a user id from the client. |
| All data scoped to the signed-in user, including vector search | **Pass.** `user_id` predicate on every statement, including the pgvector query. Asserted on the generated SQL, not just the rows. |
| Embeddings sent in batches | **Pass.** 16 per request with a pause between batches. |
| A clear message when rate-limited | **Pass.** Observed for real when OpenRouter's daily cap hit: the contract is marked failed with a sentence saying what happened, when it resets and how to raise it. |
| Docker Compose, one command | **Pass.** `docker compose up -d --build` brings up all four services; migrate runs and exits, worker listens, web serves a production build. A DOCX uploaded through the containerised stack went processing -> reviewed with 6 found, 6 verified quotes and 2 honestly not found. |
| Secrets in .env, .env.example committed | **Pass**, after a fix. `.env` is git-ignored and `.env.example` documents every variable. |

## Bonus items

| Item | State |
|---|---|
| Evaluation script | **Done.** `npm run evaluate` scores the real pipeline against expected results: 16/16 items, 13/13 found items with a verified quote. |
| Compare two versions of a contract | Not done. |
| Risk flags | Not done. |

---

# Defects found by this pass

Five, four of them invisible from reading the code.

### 1. Uploads over 10 MB were rejected, with a misleading message

The brief asks for 20 MB. Middleware matches `/api/*`, so Next buffers the request body for it,
and that buffer defaults to 10 MB. Over the limit the body is truncated, the handler sees
malformed multipart, and the user is told to "send the file as multipart/form-data" - wrong, and
impossible to act on.

Fixed with `experimental.middlewareClientMaxBodySize`, plus a Content-Length check so a
genuinely oversized file gets "That file is 21.0 MB. The limit is 20 MB."

**Measured after the fix:** 12 MB accepted, 19 MB accepted, 21 MB rejected correctly.

### 2. The Docker image contained the .env file

There was no `.dockerignore`, so `COPY . .` baked the real `.env` - Clerk secret key and model
provider key - into the image, where it survives every later layer and ships with the image.
Confirmed by running `ls -la /app/.env` inside the built container.

Fixed by adding a `.dockerignore`. Secrets reach the container through `env_file` at run time,
never through the build. Confirmed absent from the rebuilt image, which also shrank from
2.5 GB to 1.59 GB.

### 2b. The build itself required DATABASE_URL, and only passed because .env was being copied

Adding the `.dockerignore` exposed this immediately: the next build failed with "DATABASE_URL
is not set". The database client read the variable and threw when the module was imported, and
Next imports every route module during `next build` to collect page data - so the build
depended on run-time configuration and had been passing only because the secrets file was in
the image.

The client is now created on first use. A clone builds with no credentials at all, and a
missing URL is reported on the first query, where it is actionable. This is the same class of
problem as the Clerk key blocking `next build` earlier, found the same way: by removing
something that should not have been there and seeing what fell over.

### 3. The chat could not answer "who are the parties?"

It returned "The contract does not cover this." on a contract whose parties the checklist had
already found on page 1. The cause is worth keeping: the preamble never uses the word "parties",
it says "by and between X and Y". The review finds it because that checklist item carries a
query written to read like the clause; the chat had only the user's words.

Fixed by matching a question to a checklist item when the evidence is there, and borrowing that
item's query and keywords. No extra model call - the item's query is embedded together with the
question.

**After:** "Who are the parties..." answers correctly with a verified quote on page 1, while
"What is the penalty for late delivery?" still honestly returns "does not cover this."

### 4. Address lines were being read as clause headings

Found by chunking all ten samples. "22 Finsbury Square, London" and "14 April 2026" matched the
numbered-heading pattern, so findings cited "Section 22" and "Section 14 April 2026". A decimal
is always a clause number; a bare integer only counts when a separator follows it.

### 5. A summary that only echoed the status

The model sometimes answers the summary field with the literal string `not_found`, and the card
rendered "Not found in the contract." with "not_found" printed underneath.

---

# What is still not covered

Stated plainly, because a test report that claims everything is fine is not worth reading.

- **One environment hazard, not an app defect, worth knowing.** The first DOCX upload through
  Docker failed with `ENOENT: no such file or directory, open 'D:\data\uploads\...'` - a
  Windows path, reported by a Linux container. Four host workers left over from development
  were still consuming the same Redis queue; one grabbed the job and tried to read the
  container's `/data/uploads/...` path, which Windows resolves against the current drive.
  BullMQ retried and the container worker finished it, so the contract recovered on its own,
  which is the retry policy doing exactly what it exists for. The coupling underneath is real
  though: `storage_path` is absolute, so the web server and the worker must share a filesystem
  and the same path. Inside compose they do, through the shared volume.
- **No browser-level test of the isolation**, only the data layer and the HTTP API. Both were
  exercised as a second signed-in user, which is the thing that matters, but there is no
  automated regression test at the browser level.
- **Two sample contracts are scored, not ten.** The other eight were checked for extraction and
  chunking, not for checklist accuracy; adding them would cost 66 model requests per run.
- **Scanned PDFs are out of scope.** No OCR. A PDF with no extractable text fails with that
  message rather than producing an empty review.
- **The image is large** at 1.59 GB, because it installs dev dependencies and keeps the build
  toolchain. A multi-stage build with `next build --standalone` would cut it to a few hundred
  megabytes. Not done; it builds and runs correctly as it is.
