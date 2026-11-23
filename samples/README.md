# Sample contracts

Eight documents for trying the app, chosen so that each one fails or passes the checklist in a
*different* way. Eight variations of the same agreement would prove nothing.

All of them are invented. Every company, person, address and figure is fictional.

| File | Shape | What it exercises |
|---|---|---|
| `services-agreement.txt` | Master services agreement, fully formed | Seven items present, **auto-renewal genuinely absent** - the clean "not found" case |
| `mutual-nda.txt` | Mutual NDA | **Has** auto-renewal, has no payment terms and no liability cap - the inverse of the above |
| `employment-agreement.txt` | Employment contract | Different vocabulary for the same items: "remuneration" not payment terms, probation inside the term clause, two notice periods for termination |
| `saas-subscription.txt` | SaaS subscription, US style | Auto-renewal with a notice window, a liability cap with carve-outs, a Delaware governing law clause. Numbered sub-clauses throughout |
| `commercial-lease.txt` | Indian leave and licence deed | Recitals and "WHEREAS" preamble, a lock-in period, escalation, deposit. Parties are in the preamble, not under a heading |
| `supply-agreement.txt` | Cross-border goods supply | `ARTICLE I` numbering rather than decimals, Incoterms, arbitration instead of a court. Tests the non-decimal heading pattern |
| `software-licence.txt` | Perpetual licence | **A term that never expires** - the right answer for "start date and term" is not a date range. Revocation rather than termination |
| `consultancy-letter.txt` | Plain-English engagement letter | **No clause numbers at all** and informal headings ("What we will pay", "Ending the engagement"). Tests the fallback when heading detection has nothing to work with |
| `sparse-memorandum.txt` | Non-binding MOU | Most of the checklist is honestly absent. Should produce mostly "not found" rather than inventing clauses |

## The ones worth watching

**`consultancy-letter.txt`** is the hardest. It has no numbering, so clause-aware chunking falls
back to paragraph boundaries and section labels are mostly empty. The findings should still be
correct; only the "Section" citations degrade.

**`software-licence.txt`** is a trap for a model that pattern-matches. The licence is perpetual,
so the honest answer for term is that it does not expire - not a missing finding, and not an
invented end date.

**`sparse-memorandum.txt`** is the discipline test. It is not a contract at all and says so. A
system that wants to be helpful will hallucinate a termination clause here; the right output is
a page of "not found".

## Scored expectations

`expected.json` holds expected statuses for the two contracts used by `npm run evaluate`
(`services-agreement.txt` and `mutual-nda.txt`). The other six are for manual exploration and
for the demo - adding them to the evaluation would mean another 66 model requests per run,
which is more than a free tier allows in a day.

If you do extend the evaluation, keep the existing convention: a list of acceptable statuses
per item, with a note explaining any entry that allows more than one. An evaluation that marks
a defensible answer wrong teaches you nothing.
