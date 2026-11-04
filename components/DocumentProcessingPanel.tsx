"use client";
import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type DocumentRecord } from "@/lib/db";
import { deleteDocument, ingestFile, TEXT_EXT } from "@/lib/rag";
import { useApp } from "@/lib/store";
import { Dots, LockGlyph } from "./Icons";

/** Panel-local geometry from the reference (panel origin = 439,579). */
const STACKS = [
  { x: 108, y: 57, w: 157, h: 186, ref: "DOC_A.PDF", fill: 0.62 },
  { x: 360, y: 61, w: 142, h: 178, ref: "REPORT_B", fill: 0.6 },
  { x: 588, y: 57, w: 130, h: 172, ref: "ANALYSIS.DOC", fill: 0.6 },
];
const BARS = [{ x: 108, w: 150 }, { x: 354, w: 150 }, { x: 586, w: 130 }];
const ARROWS = [362, 586, 740];

function Stack({ x, y, w, h, name, back }: { x: number; y: number; w: number; h: number; name: string; back: string }) {
  const fw = w - 34, fh = h - 18;
  return (
    <div className="doc-stack" style={{ left: x, top: y, width: w, height: h }}>
      <div className="sheet" style={{ left: 0, top: 6, width: fw, height: fh, opacity: .55 }}><span className="back-label">{back}</span></div>
      <div className="sheet" style={{ left: 16, top: 12, width: fw, height: fh, opacity: .75 }}><span className="back-label">{back}</span></div>
      <div className="sheet front" style={{ left: 34, top: 18, width: fw, height: fh }}>
        <div className="fold" />
        <div className="name" title={name}>{name}</div>
        <div className="lines">
          {[0.82, 0.62, 0.75, 0.5, 0.82, 0.68, 0.45, 0.78, 0.6, 0.7].map((p, i) => <i key={i} style={{ width: `${p * 100}%` }} />)}
        </div>
        <div className="foot"><i /><i /><i /><i /></div>
      </div>
    </div>
  );
}

const STAGE_LABEL: Record<DocumentRecord["status"], string> = {
  queued: "Queued", extracting: "Text extraction", chunking: "Chunking", embedding: "Embedding", indexed: "Indexed", error: "Error",
};

export default function DocumentProcessingPanel() {
  const { openModal } = useApp();
  const docs = useLiveQuery(() => db.documents.orderBy("uploaded_at").reverse().limit(3).toArray(), []) ?? [];
  const total = useLiveQuery(() => db.documents.count(), []) ?? 0;
  const [drag, setDrag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function handle(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try { await ingestFile(f); } catch (e) { flash((e as Error).message); }
    }
  }
  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3500); }

  const ordered = [...docs].reverse();
  const latest = docs[0];

  return (
    <section
      className="panel proc"
      aria-label="Document processing"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files); }}
    >
      <h2 className="panel-title">Document Processing</h2>
      <button
        title="Open Document Library & Knowledge Spaces"
        onClick={() => openModal("library")}
        style={{ position: "absolute", left: 738, top: 12, width: 30, height: 24 }}
      >
        <Dots style={{ left: 10, top: 10 }} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={TEXT_EXT.map((e) => "." + e).join(",")}
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }}
      />

      <div className="proc-line" />
      <div className="start-node" />
      {ARROWS.map((x) => <div key={x} className="arrow" style={{ left: x, top: 143 }} />)}

      <div
        className="scanner"
        style={{ left: 274, top: 66, cursor: "pointer" }}
        onClick={() => openModal("settings")}
        title="Local Storage, Backup & AI Model Settings"
      >
        <div className="ring"><LockGlyph /></div>
      </div>
      <div className="caption" style={{ left: 272, top: 166 }}>{latest ? STAGE_LABEL[latest.status] : "Text extraction"}</div>
      <div className="caption-lines" style={{ left: 272, top: 186 }}><i style={{ width: 70 }} /><i style={{ width: 54 }} /></div>
      <div className="caption-lines" style={{ left: 510, top: 72 }}>{[60, 50, 60, 44, 56, 38].map((w, i) => <i key={i} style={{ width: w }} />)}</div>
      <div className="caption" style={{ left: 508, top: 166 }}>Indexing &amp; analysis</div>
      <div className="caption-lines" style={{ left: 508, top: 186 }}><i style={{ width: 62 }} /><i style={{ width: 50 }} /></div>

      {STACKS.map((s, i) => {
        const d = ordered[i];
        return (
          <div
            key={i}
            style={{ cursor: "pointer" }}
            onClick={() => (d ? openModal("library") : input.current?.click())}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (d) deleteDocument(d.document_id);
            }}
            title={
              d
                ? `${d.filename} — ${STAGE_LABEL[d.status]} (click to manage · double-click to delete)`
                : "Click to upload documents or drop files here"
            }
          >
            <Stack {...s} name={d ? d.filename : s.ref} back={d ? STAGE_LABEL[d.status].slice(0, 4).toUpperCase() : "ANA"} />
            <div className="progress" style={{ left: BARS[i].x, top: 259, width: BARS[i].w }}>
              <span style={{ width: `${(d ? d.progress : s.fill) * 100}%`, background: d?.status === "error" ? "#ff5c8a" : undefined }} />
            </div>
          </div>
        );
      })}

      <div className="proc-status" onClick={() => openModal("library")} style={{ cursor: "pointer" }}>
        {total ? `${total} document${total > 1 ? "s" : ""} · processed locally (click to manage)` : "Drop files here · PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, JSON, HTML"}
      </div>
      {drag && <div className="dropzone">Drop to process locally</div>}
      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}
