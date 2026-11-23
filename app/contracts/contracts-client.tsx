"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type ContractRow = {
  id: string;
  filename: string;
  sizeBytes: number;
  status: "processing" | "reviewed" | "failed";
  statusDetail: string | null;
  pageCount: number | null;
  createdAt: string;
};

const MAX_MB = 20;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Open the file chooser.
 *
 * `showPicker()` is the explicit API for this and reports a real error when the browser refuses
 * - outside a user gesture, for instance - instead of silently doing nothing, which is exactly
 * the failure that is impossible to diagnose from the outside. `.click()` is the fallback for
 * browsers that do not have it.
 */
function openPicker(input: HTMLInputElement | null) {
  if (!input) return;
  try {
    if (typeof input.showPicker === "function") {
      input.showPicker();
      return;
    }
  } catch {
    // Fall through: some browsers throw when showPicker is unavailable in the current context.
  }
  input.click();
}

function extensionOf(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return ["pdf", "docx", "txt", "md"].includes(ext) ? ext.toUpperCase() : "DOC";
}

function StatusPill({ row }: { row: ContractRow }) {
  if (row.status === "reviewed") return <span className="status">Reviewed</span>;
  if (row.status === "failed") {
    return (
      <span className="status bad" title={row.statusDetail ?? undefined}>
        Failed
      </span>
    );
  }
  return (
    <span className="status warn pulse-soft" title={row.statusDetail ?? undefined}>
      {row.statusDetail ?? "Processing"}
    </span>
  );
}

export default function ContractsClient() {
  const [rows, setRows] = useState<ContractRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/contracts", { cache: "no-store" });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? "Could not load contracts.");
      }
      const data = (await res.json()) as { contracts: ContractRow[] };
      setRows(data.contracts);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is still being processed, and stop as soon as nothing is. A fixed
  // interval that never stops hammers the API all day for a list that does not change.
  useEffect(() => {
    if (!rows?.some((r) => r.status === "processing")) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [rows, load]);

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);

      if (file.size > MAX_MB * 1024 * 1024) {
        setUploadError(`That file is ${formatSize(file.size)}. The limit is ${MAX_MB} MB.`);
        return;
      }
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      if (!["pdf", "docx", "txt", "md"].includes(ext)) {
        setUploadError("Upload a PDF, DOCX or TXT file.");
        return;
      }

      setUploading(true);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/contracts", { method: "POST", body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Upload failed.");
        await load();
      } catch (err) {
        setUploadError((err as Error).message);
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [load],
  );

  const remove = useCallback(async (row: ContractRow) => {
    if (!confirm(`Delete "${row.filename}"? This also deletes its review and chat history.`)) {
      return;
    }
    setDeletingId(row.id);
    try {
      const res = await fetch(`/api/contracts/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? "Delete failed.");
      }
      setRows((current) => current?.filter((r) => r.id !== row.id) ?? null);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }, []);

  const reviewedCount = rows?.filter((r) => r.status === "reviewed").length ?? 0;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Your workspace</div>
          <h2>My contracts</h2>
          <p>Upload a contract and check it against the eight-point review checklist.</p>
        </div>
        {/* Jumps to the explainer itself, not the top of the page. */}
        <Link className="btn" href="/#how-it-works">
          How it works
        </Link>
      </div>

      {/*
        One large button, with drop as the quieter alternative underneath.

        A div rather than a label, because a label leaves no control in the accessibility tree:
        nothing to tab to, nothing for a screen reader to announce. The button is the control;
        the panel around it stays a drop target for people who drag.
      */}
      <div
        className={`drop${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,.txt,.md,application/pdf,text/plain"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          className="btn primary hero-cta"
          disabled={uploading}
          onClick={() => openPicker(fileInput.current)}
        >
          {uploading ? "Uploading..." : "Select a contract"}
        </button>
        <p className="drop-hint">{dragging ? "Drop it anywhere here" : "or drop one here"}</p>
        <p className="drop-limits">PDF, DOCX or TXT, up to {MAX_MB} MB</p>
      </div>

      {uploadError && (
        <p className="notice bad" role="alert" style={{ marginBottom: 18 }}>
          {uploadError}
        </p>
      )}

      {loadError && (
        <p className="notice bad" role="alert" style={{ marginBottom: 18 }}>
          {loadError}{" "}
          <button className="toggle" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      <div className="head head-inline">
        <div>
          <h3>Recent documents</h3>
          <p className="sub">Your uploaded contracts and review status</p>
        </div>
        {reviewedCount > 0 && <span className="status">{reviewedCount} reviewed</span>}
      </div>

      {rows === null && !loadError && (
        <div aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="contract">
              <div className="file">
                <div className="fileicon skeleton" />
                <div>
                  <div className="skeleton" style={{ width: 170, height: 14 }} />
                  <div className="skeleton" style={{ width: 110, height: 11, marginTop: 7 }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {rows?.length === 0 && (
        <div className="empty">
          <strong>No contracts yet</strong>
          <p className="sub" style={{ marginTop: 6 }}>
            Upload one above and the review starts straight away.
          </p>
        </div>
      )}

      {rows?.map((row) => (
        <div className="contract" key={row.id}>
          <div className="file">
            <div className="fileicon">{extensionOf(row.filename)}</div>
            <div style={{ minWidth: 0 }}>
              <b>{row.filename}</b>
              <small>
                {formatSize(row.sizeBytes)}
                {row.pageCount ? ` - ${row.pageCount} page${row.pageCount > 1 ? "s" : ""}` : ""}
                {" - "}
                {formatDate(row.createdAt)}
              </small>
            </div>
          </div>
          <div className="row">
            <StatusPill row={row} />
            <Link
              className="btn"
              href={`/contracts/${row.id}`}
              aria-disabled={row.status === "processing"}
            >
              {row.status === "reviewed" ? "Open review" : "Open"}
            </Link>
            <button
              className="toggle quiet"
              onClick={() => void remove(row)}
              disabled={deletingId === row.id}
            >
              {deletingId === row.id ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
