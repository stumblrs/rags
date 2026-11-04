"use client";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { readOriginalFile } from "@/lib/opfs";
import { useApp } from "@/lib/store";

export default function CitationModal() {
  const { activeModal, activeCitation, openModal } = useApp();
  const activeChunkRef = useRef<HTMLDivElement>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);

  const chunks = useLiveQuery(
    async () =>
      activeCitation
        ? db.chunks.where("document_id").equals(activeCitation.document_id).sortBy("index")
        : [],
    [activeCitation?.document_id]
  );

  // Auto-scroll to the highlighted chunk when the citation modal opens (§4.6)
  useEffect(() => {
    if (activeModal === "citation" && chunks && chunks.length > 0) {
      const timer = setTimeout(() => {
        activeChunkRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [activeModal, activeCitation?.chunk_index, chunks?.length]);

  if (activeModal !== "citation" || !activeCitation) return null;

  const loc = activeCitation.section
    ? activeCitation.section
    : activeCitation.page
    ? `Page ${activeCitation.page}`
    : `Chunk ${activeCitation.chunk_index + 1}`;

  async function openOriginalFromOpfs() {
    if (!activeCitation) return;
    const buf = await readOriginalFile(activeCitation.document_id, activeCitation.filename);
    if (!buf) {
      setDownloadNote("Original binary not in OPFS (synthetic or imported backup document).");
      setTimeout(() => setDownloadNote(null), 3000);
      return;
    }
    const docRecord = await db.documents.get(activeCitation.document_id);
    const blob = new Blob([buf], { type: docRecord?.file_type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeCitation.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return (
    <div className="modal-backdrop" onClick={() => openModal(null)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 680, maxHeight: 720 }}>
        <header className="modal-header">
          <div>
            <h3>Source Citation · {activeCitation.filename}</h3>
            <span className="modal-sub">
              {loc} · Match confidence {(activeCitation.score * 100).toFixed(0)}%
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="btn-secondary" onClick={openOriginalFromOpfs} title="Download original file from local OPFS vault">
              Download Original File
            </button>
            <button className="modal-close" onClick={() => openModal(null)}>✕</button>
          </div>
        </header>

        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {downloadNote && <div className="inline-toast">{downloadNote}</div>}

          <div className="citation-highlight">
            <div className="citation-badge">Matched Passage ({loc} · Chunk #{activeCitation.chunk_index + 1})</div>
            <p>{activeCitation.excerpt}</p>
          </div>

          <div className="modal-section-title">Full Document Context ({chunks?.length ?? 0} chunks · Auto-scrolled to match)</div>
          <div className="citation-scroll">
            {(chunks ?? []).map((c) => {
              const active = c.index === activeCitation.chunk_index;
              return (
                <div
                  key={c.chunk_id}
                  ref={active ? activeChunkRef : undefined}
                  className={`citation-chunk ${active ? "active" : ""}`}
                >
                  <div className="citation-chunk-meta">
                    Chunk #{c.index + 1} {c.section ? `· ${c.section}` : c.page ? `· Page ${c.page}` : ""}
                  </div>
                  <div className="citation-chunk-text">{c.text}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

