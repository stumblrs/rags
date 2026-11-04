"use client";
import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, uid, type DocumentRecord } from "@/lib/db";
import {
  assignDocToSpace,
  deleteDocument,
  ingestFile,
  renameDocument,
  reprocessDocument,
  TEXT_EXT,
} from "@/lib/rag";
import { formatBytes } from "@/lib/backup";
import { useApp } from "@/lib/store";

export default function DocumentLibraryModal() {
  const {
    activeModal,
    openModal,
    activeSpaceId,
    setActiveSpace,
    selectedDocIds,
    toggleSelectedDoc,
    clearSelectedDocs,
  } = useApp();

  const docs = useLiveQuery(() => db.documents.orderBy("uploaded_at").reverse().toArray(), []) ?? [];
  const spaces = useLiveQuery(() => db.spaces.orderBy("created_at").toArray(), []) ?? [];
  const spaceDocs = useLiveQuery(() => db.space_documents.toArray(), []) ?? [];

  const [search, setSearch] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const previewChunks = useLiveQuery(
    async () =>
      previewDoc ? db.chunks.where("document_id").equals(previewDoc.document_id).sortBy("index") : [],
    [previewDoc?.document_id]
  );

  if (activeModal !== "library") return null;

  const docSpaceMap = new Map<string, string>();
  for (const sd of spaceDocs) docSpaceMap.set(sd.document_id, sd.space_id);

  const filtered = docs.filter((d) => {
    if (activeSpaceId && docSpaceMap.get(d.document_id) !== activeSpaceId) return false;
    if (search.trim() && !d.filename.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  async function addSpace() {
    const name = newSpaceName.trim();
    if (!name) return;
    const id = uid("space");
    await db.spaces.put({
      space_id: id,
      name,
      description: "Custom Knowledge Space",
      created_at: new Date().toISOString(),
    });
    setNewSpaceName("");
    setActiveSpace(id);
  }

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        await ingestFile(f, activeSpaceId);
      } catch (e) {
        setToast((e as Error).message);
        setTimeout(() => setToast(null), 3500);
      }
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => openModal(null)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 880, height: 680 }}>
        <header className="modal-header">
          <div>
            <h3>Knowledge Base · Documents &amp; Spaces</h3>
            <span className="modal-sub">
              {docs.length} total documents · Active scope:{" "}
              <b>
                {selectedDocIds.length > 0
                  ? `${selectedDocIds.length} selected document(s)`
                  : activeSpaceId
                  ? spaces.find((s) => s.space_id === activeSpaceId)?.name ?? "Space"
                  : "All documents"}
              </b>
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-neon" onClick={() => fileRef.current?.click()}>+ Upload Documents</button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={TEXT_EXT.map((e) => "." + e).join(",")}
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button className="modal-close" onClick={() => openModal(null)}>✕</button>
          </div>
        </header>

        <div className="modal-body library-grid">
          {/* Left column: Knowledge Spaces */}
          <aside className="spaces-rail">
            <div className="modal-section-title">Knowledge Spaces</div>
            <button
              className={`space-item ${!activeSpaceId ? "active" : ""}`}
              onClick={() => setActiveSpace(null)}
            >
              <span>All Documents</span>
              <small>{docs.length}</small>
            </button>
            {spaces.map((sp) => {
              const count = spaceDocs.filter((sd) => sd.space_id === sp.space_id).length;
              return (
                <button
                  key={sp.space_id}
                  className={`space-item ${activeSpaceId === sp.space_id ? "active" : ""}`}
                  onClick={() => setActiveSpace(sp.space_id)}
                >
                  <span>{sp.name}</span>
                  <small>{count}</small>
                </button>
              );
            })}

            <div className="space-new">
              <input
                placeholder="New space name…"
                value={newSpaceName}
                onChange={(e) => setNewSpaceName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSpace()}
              />
              <button onClick={addSpace}>+</button>
            </div>

            {selectedDocIds.length > 0 && (
              <button className="btn-ghost" onClick={clearSelectedDocs} style={{ marginTop: 8 }}>
                Clear {selectedDocIds.length} doc filter
              </button>
            )}
          </aside>

          {/* Right column: Document list or preview */}
          <div className="docs-main">
            <div className="docs-toolbar">
              <input
                className="docs-search"
                placeholder="Search document library by filename…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {previewDoc && (
                <button className="btn-ghost" onClick={() => setPreviewDoc(null)}>
                  ← Back to list
                </button>
              )}
            </div>

            {toast && <div className="inline-toast">{toast}</div>}

            {previewDoc ? (
              <div className="doc-preview-pane">
                <div className="doc-preview-head">
                  <b>{previewDoc.filename}</b>
                  <span>
                    {formatBytes(previewDoc.size)} · {previewChunks?.length ?? 0} chunks · {previewDoc.status}
                  </span>
                </div>
                <div className="citation-scroll">
                  {(previewChunks ?? []).map((c) => (
                    <div key={c.chunk_id} className="citation-chunk">
                      <div className="citation-chunk-meta">
                        Chunk #{c.index + 1} {c.section ? `· ${c.section}` : c.page ? `· Page ${c.page}` : ""}
                      </div>
                      <div className="citation-chunk-text">{c.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="docs-list">
                {filtered.length === 0 ? (
                  <div className="empty-state">
                    No documents in this view. Click <b>+ Upload Documents</b> or drop PDF, DOCX, XLSX, PPTX, CSV, MD, or TXT files.
                  </div>
                ) : (
                  filtered.map((d) => {
                    const checked = selectedDocIds.includes(d.document_id);
                    const assignedSpace = docSpaceMap.get(d.document_id) ?? "";
                    return (
                      <div key={d.document_id} className={`doc-row ${checked ? "selected" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelectedDoc(d.document_id)}
                          title="Filter chat retrieval to this document"
                        />
                        <div className="doc-info">
                          {editingId === d.document_id ? (
                            <input
                              className="doc-rename-input"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onBlur={async () => {
                                await renameDocument(d.document_id, editingName);
                                setEditingId(null);
                              }}
                              onKeyDown={async (e) => {
                                if (e.key === "Enter") {
                                  await renameDocument(d.document_id, editingName);
                                  setEditingId(null);
                                }
                              }}
                              autoFocus
                            />
                          ) : (
                            <div className="doc-title" onClick={() => setPreviewDoc(d)}>
                              {d.filename}
                            </div>
                          )}
                          <div className="doc-meta">
                            {formatBytes(d.size)} · {d.status.toUpperCase()}
                            {d.error ? ` (${d.error})` : ""} · {new Date(d.uploaded_at).toLocaleDateString()}
                          </div>
                        </div>

                        <select
                          className="doc-space-select"
                          value={assignedSpace}
                          onChange={(e) => assignDocToSpace(d.document_id, e.target.value || null)}
                          title="Assign to Knowledge Space"
                        >
                          <option value="">Unassigned</option>
                          {spaces.map((s) => (
                            <option key={s.space_id} value={s.space_id}>{s.name}</option>
                          ))}
                        </select>

                        <div className="doc-actions">
                          <button onClick={() => setPreviewDoc(d)} title="Preview extracted chunks">Preview</button>
                          <button
                            onClick={() => {
                              setEditingId(d.document_id);
                              setEditingName(d.filename);
                            }}
                            title="Rename document"
                          >
                            Rename
                          </button>
                          <button onClick={() => reprocessDocument(d.document_id)} title="Reprocess & re-index">
                            Reprocess
                          </button>
                          <button
                            className="danger"
                            onClick={() => deleteDocument(d.document_id)}
                            title="Delete document"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

