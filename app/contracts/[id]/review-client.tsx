"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Finding = {
  itemKey: string;
  status: "found" | "not_found" | "unclear";
  summary: string;
  quote: string | null;
  sectionLabel: string | null;
  pageNumber: number | null;
  quoteVerified: boolean;
  clause: string | null;
};

type Item = {
  key: string;
  label: string;
  description: string;
  finding: Finding | null;
};

type ContractInfo = {
  id: string;
  filename: string;
  sizeBytes: number;
  status: "processing" | "reviewed" | "failed";
  statusDetail: string | null;
  pageCount: number | null;
  hasRealPages: boolean;
  createdAt: string;
};

type Citation = {
  quote: string;
  sectionLabel: string | null;
  pageNumber: number | null;
  verified: boolean;
};

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
};

const SUGGESTIONS = [
  "What are the payment terms?",
  "How can either party terminate?",
  "Does this contract auto-renew?",
];

/**
 * Strip the backslash escaping some models apply to quotation marks inside prose. The server
 * does the same before storing, but the live stream arrives raw, so the text being typed out on
 * screen needs it too - otherwise backslashes flicker in and then vanish when the reconciled
 * version loads.
 */
function cleanAnswer(text: string): string {
  return text.replace(/\\"/g, '"');
}

/**
 * Does this summary say anything the fixed "Not found in the contract." line does not?
 *
 * A model occasionally echoes the status token back as its summary, so the card rendered
 * "Not found in the contract." with "not_found" underneath it. The server strips those now,
 * but findings stored before that still exist, so the card checks too.
 */
function addsDetail(summary: string | undefined): boolean {
  const text = (summary ?? "").trim();
  if (!text) return false;
  if (/^(not[_\s-]?found|unclear|found|n\/a|none)[.!]?$/i.test(text)) return false;
  return text.toLowerCase() !== "not found in the contract.";
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

/**
 * Where a clause lives. The page number is suppressed for formats that have no fixed pages -
 * DOCX and TXT paginate at render time, so "page 1" there is an artefact of extraction rather
 * than a fact about the document, and citing it would contradict the note under the title.
 */
function where(section: string | null, page: number | null, hasRealPages?: boolean): string {
  return [section ? `Section ${section}` : null, page && hasRealPages ? `page ${page}` : null]
    .filter(Boolean)
    .join(", ");
}

function FindingCard({
  item,
  contractStatus,
  hasRealPages,
}: {
  item: Item;
  contractStatus?: ContractInfo["status"];
  hasRealPages?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const f = item.finding;
  // A contract that failed is not still being checked. Leaving the pulsing badge up forever is
  // a lie the UI tells for as long as the page is open.
  const abandoned = !f && contractStatus === "failed";

  const badge = !f ? (
    <span className={`status neutral${abandoned ? "" : " pulse-soft"}`}>
      {abandoned ? "Not checked" : "Checking"}
    </span>
  ) : f.status === "found" ? (
    <span className="status">Found</span>
  ) : f.status === "unclear" ? (
    <span className="status warn">Unclear</span>
  ) : (
    <span className="status neutral">Not found</span>
  );

  return (
    <article className="card">
      <div className="cardtop">
        <div>
          <h3>{item.label}</h3>
          <div className="hint">{item.description}</div>
        </div>
        {badge}
      </div>

      {!f && !abandoned && (
        <div className="skeleton" style={{ height: 14, width: "62%", marginTop: 14 }} />
      )}

      {abandoned && (
        <div className="summary muted">This item was not reached because processing failed.</div>
      )}

      {f && (
        <>
          <div className={`summary${f.status === "not_found" ? " muted" : ""}`}>
            {f.status === "not_found" ? "Not found in the contract." : f.summary}
          </div>

          {f.status === "not_found" && addsDetail(f.summary) && (
            <div className="hint">{f.summary}</div>
          )}

          {f.quote && (
            <div className="quote">
              {`“${open ? f.quote : truncate(f.quote, 240)}”`}
              <div className="qfoot">
                <b className="verified">{"✓"} Verified quote</b>
                {where(f.sectionLabel, f.pageNumber, hasRealPages) && (
                  <span>{where(f.sectionLabel, f.pageNumber, hasRealPages)}</span>
                )}
                {f.clause && (
                  <button className="toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                    {open ? "Hide full clause" : "Show full clause"}
                  </button>
                )}
              </div>
              {open && f.clause && <div className="full clause">{f.clause}</div>}
            </div>
          )}

          {f.status === "unclear" && !f.quote && (
            <div className="hint" style={{ color: "var(--amber)" }}>
              No quote from this contract could be verified for this item.
            </div>
          )}
        </>
      )}
    </article>
  );
}

export default function ReviewClient({ contractId }: { contractId: string }) {
  const [contract, setContract] = useState<ContractInfo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamed, setStreamed] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/${contractId}`, { cache: "no-store" });
      if (res.status === 404) throw new Error("This contract does not exist, or it is not yours.");
      if (!res.ok) {
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? "Could not load this contract.",
        );
      }
      const data = (await res.json()) as { contract: ContractInfo; items: Item[] };
      setContract(data.contract);
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [contractId]);

  const loadChat = useCallback(async () => {
    const res = await fetch(`/api/contracts/${contractId}/chat`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { messages: ChatTurn[] };
    setTurns(data.messages);
  }, [contractId]);

  useEffect(() => {
    void load();
    void loadChat();
  }, [load, loadChat]);

  // Findings appear one at a time as the worker finishes each item, so poll while it runs.
  useEffect(() => {
    if (contract?.status !== "processing") return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [contract?.status, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, streamed]);

  const send = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || streaming) return;

      setChatError(null);
      setStreaming(true);
      setStreamed("");
      setQuestion("");
      setTurns((t) => [
        ...t,
        { id: `local-${Date.now()}`, role: "user", content: q, citations: null },
      ]);

      try {
        const res = await fetch(`/api/contracts/${contractId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "The question could not be sent.");
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response stream.");
        const decoder = new TextDecoder();
        let buffer = "";
        let answer = "";

        // Newline-delimited JSON: a frame can be split across two network chunks, so only
        // complete lines are parsed and the remainder is carried over.
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;

            const frame = JSON.parse(line) as
              | { type: "delta"; text: string }
              | { type: "citations"; citations: Citation[] }
              | { type: "error"; error: string }
              | { type: "done" };

            if (frame.type === "delta") {
              answer += frame.text;
              setStreamed(answer);
            } else if (frame.type === "error") {
              setChatError(frame.error);
            }
          }
        }

        /**
         * Reconcile against the server rather than keeping the optimistic turns. While the
         * answer streams, the list is local state so the UI feels responsive. Once it is
         * complete the database is the authority, and re-reading it is what keeps the two from
         * drifting - and makes a refresh show exactly what was on screen.
         */
        setStreamed("");
        await loadChat();
      } catch (err) {
        setChatError((err as Error).message);
        setStreamed("");
        await loadChat().catch(() => {});
      } finally {
        setStreaming(false);
      }
    },
    [contractId, streaming, loadChat],
  );

  if (error) {
    return (
      <>
        <Link className="back" href="/contracts">
          {"←"} Back to my contracts
        </Link>
        <div className="empty">
          <strong style={{ color: "var(--danger)" }}>{error}</strong>
        </div>
      </>
    );
  }

  const reviewed = contract?.status === "reviewed";
  const answered = items.filter((i) => i.finding).length;
  const foundCount = items.filter((i) => i.finding?.status === "found").length;
  const progressPct = items.length ? Math.round((answered / items.length) * 100) : 0;

  return (
    <>
      <Link className="back" href="/contracts">
        {"←"} Back to my contracts
      </Link>

      <div className="reviewhead">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Contract review</div>
          <h2>{contract?.filename ?? "Loading..."}</h2>
          {contract && (
            <div className="sub">
              {contract.pageCount
                ? `${contract.pageCount} page${contract.pageCount > 1 ? "s" : ""} - `
                : ""}
              {contract.hasRealPages
                ? "findings cite page numbers"
                : "this format has no fixed pages, so findings cite sections"}
            </div>
          )}
        </div>

        <div className="progress">
          <small>
            <span>Review progress</span>
            <b>
              {contract?.status === "processing"
                ? `${answered} of ${items.length} checked`
                : `${foundCount} of ${items.length} found`}
            </b>
          </small>
          <div className="bar">
            <span style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      </div>

      {contract?.status === "failed" && (
        <div className="notice bad" role="alert" style={{ marginBottom: 22 }}>
          <strong>This contract could not be processed.</strong>
          <p className="sub" style={{ marginTop: 6 }}>
            {contract.statusDetail ?? "No reason was recorded."}
          </p>
        </div>
      )}

      <div className="section">REVIEW CHECKLIST - {items.length} ITEMS</div>
      <div className="findings">
        {items.map((item) => (
          <FindingCard
            key={item.key}
            item={item}
            contractStatus={contract?.status}
            hasRealPages={contract?.hasRealPages}
          />
        ))}
      </div>

      <div className="chat">
        <div className="eyebrow">Document-grounded assistant</div>
        <h2>Ask about this contract</h2>
        <p>
          Answers come from this contract only. If it does not cover something, the answer says so.
        </p>

        <div className="chatbox">
          <div className="messages">
            {turns.length === 0 && !streaming && (
              <p className="sub" style={{ margin: "auto", textAlign: "center" }}>
                {reviewed
                  ? "No questions yet. Try one of the suggestions below."
                  : "Chat opens once the review has finished."}
              </p>
            )}

            {turns.map((turn) => (
              <div key={turn.id} className={`msg ${turn.role === "user" ? "user" : "bot"}`}>
                <p className="clause">{cleanAnswer(turn.content)}</p>

                {turn.role === "assistant" && turn.citations && turn.citations.length > 0 && (
                  <div className="cite">
                    {turn.citations.map((c, i) => (
                      <div key={i}>
                        {c.verified ? (
                          <>
                            <b>{"✓"} Verified quote</b>
                            {where(c.sectionLabel, c.pageNumber, contract?.hasRealPages) &&
                              ` - ${where(c.sectionLabel, c.pageNumber, contract?.hasRealPages)}`}
                          </>
                        ) : (
                          <b className="bad">This quoted wording was not found in the contract.</b>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {streamed && (
              <div className="msg bot">
                <p className="clause">{cleanAnswer(streamed)}</p>
              </div>
            )}

            {streaming && !streamed && (
              <div className="msg bot pulse-soft">
                <p className="clause muted">Reading the contract...</p>
              </div>
            )}

            <div ref={endRef} />
          </div>

          {chatError && (
            <p className="cite" role="alert" style={{ padding: "10px 14px", margin: 0 }}>
              <b className="bad">{chatError}</b>
            </p>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(question);
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                reviewed
                  ? "Ask a question about this contract..."
                  : "Waiting for the review to finish"
              }
              disabled={!reviewed || streaming}
              autoComplete="off"
            />
            <button
              className="btn primary"
              type="submit"
              disabled={!reviewed || streaming || !question.trim()}
            >
              {streaming ? "Answering" : "Ask"}
            </button>
          </form>
        </div>

        <div className="suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => void send(s)} disabled={!reviewed || streaming}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
