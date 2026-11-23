# Demo recordings

Three screen recordings of the app running under `docker compose up`, recorded 23 November 2026
at 1366x860. Silent, and split so there is no dead air while a contract is being processed.

| File | Length | What it shows |
|---|---|---|
| `01-sign-in-and-upload.mp4` | ~90 s | The landing page and the eight checked items, signing in, the contracts list, uploading `mutual-nda.txt`, and the status moving from **Embedding 25 clauses** to **Running the checklist** |
| `02-review-and-chat.mp4` | ~2 min | The three-page PDF. All eight findings, citing pages 1, 2 and 3 and sections 2.1, 4.2, 8.1, 7.2, 6.1 and 9.1, with auto-renewal honestly not found. A full clause expanded, then two questions asked live: one answered with a verified quote on page 2, one correctly refused |
| `03-second-user-isolation.mp4` | ~60 s | Signing out, signing in as a second user, an empty contracts list, then opening the first user's contract URL and being refused. The same clip also shows `GET` and `DELETE` on that contract id returning 404 through the API, not just a hidden row in the UI |

Clip 2 deliberately uses the three-page PDF rather than a text file, because that is where the
page citations become checkable: governing law is on page 3, termination on page 2, the parties
on page 1.

The browser shows Clerk's development-mode badge, which is expected on a Clerk development
instance.
