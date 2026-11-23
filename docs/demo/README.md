# Demo

Two recordings, both of the app running under `docker compose up`.

| File | What it covers |
|---|---|
| [`demo.mp4`](demo.mp4) | The app end to end: signing in, uploading a contract, the eight checklist findings with their quotes and page citations, two follow-up questions (one answered, one correctly refused), and a second user being refused access to the first user's contract through both the page and the API |
| [`code-walkthrough.mp4`](code-walkthrough.mp4) | The three files that carry the design: `src/checklist.ts` for the per-item retrieval query, `src/services/chunk.ts` for clause-boundary chunking, and `src/services/verify.ts` for the quote check |

They are split because a browser screen recording cannot capture an editor, not because they are
meant to be watched separately. Watch `demo.mp4` first.

The review in `demo.mp4` runs against the three page PDF in [`samples/`](../../samples)
rather than a text file, because that is where the page citations become checkable: governing
law is on page 3, termination on page 2, the parties on page 1.

The browser shows Clerk's development-mode badge, which is expected on a Clerk development
instance.
