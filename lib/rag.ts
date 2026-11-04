import { db, uid, type ChunkRecord, type DocumentRecord, type EmbeddingRecord, type Source } from "./db";
import { extractDocumentSections, SUPPORTED_EXT, type ExtractedSection } from "./extract";
import { embedText, fallbackEmbed, tokenize, TRANSFORMERS_MODEL_ID } from "./ai";
import { saveOriginalFile, readOriginalFile, removeOriginalFile } from "./opfs";
import { useApp } from "./store";

export { SUPPORTED_EXT as TEXT_EXT, tokenize };
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const cosine = (a: number[], b: number[]) => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
};

async function sha(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ChunkWithMeta {
  text: string;
  page?: number;
  section?: string;
}

export function chunkSections(sections: ExtractedSection[], size?: number, overlap?: number): ChunkWithMeta[] {
  const { ragSettings } = useApp.getState();
  const cSize = Math.max(200, size ?? ragSettings.chunkSize ?? 800);
  const cOverlap = Math.min(Math.floor(cSize / 2), overlap ?? ragSettings.chunkOverlap ?? 140);

  const out: ChunkWithMeta[] = [];
  for (const sec of sections) {
    const clean = sec.text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) continue;
    for (let i = 0; i < clean.length; i += cSize - cOverlap) {
      out.push({
        text: clean.slice(i, i + cSize),
        page: sec.page,
        section: sec.section,
      });
      if (i + cSize >= clean.length) break;
    }
  }
  return out;
}

async function processBufferForDoc(id: string, filename: string, buf: ArrayBuffer) {
  const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));
  const sections = await extractDocumentSections(filename, buf);
  await db.documents.update(id, { status: "chunking", progress: 0.32, error: undefined });
  await yieldToMain();

  const chunks = chunkSections(sections);
  if (!chunks.length) {
    throw new Error("No extractable text found in document");
  }
  await db.documents.update(id, { status: "embedding", progress: 0.45 });

  await db.transaction("rw", db.chunks, db.embeddings, async () => {
    await db.chunks.where("document_id").equals(id).delete();
    await db.embeddings.where("document_id").equals(id).delete();
  });

  // Process embeddings and IndexedDB writes in batches of 8 with main-thread yields
  // so large PDFs never freeze UI scrolling or trigger excess IndexedDB reactive re-renders.
  const BATCH_SIZE = 8;
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const slice = chunks.slice(start, start + BATCH_SIZE);
    const chunkRows: ChunkRecord[] = [];
    const embRows: EmbeddingRecord[] = [];

    for (let j = 0; j < slice.length; j++) {
      const i = start + j;
      const c = slice[j];
      const chunk_id = `${id}_${i}`;
      const { vector, model_id } = await embedText(c.text);
      chunkRows.push({
        chunk_id,
        document_id: id,
        index: i,
        text: c.text,
        page: c.page,
        section: c.section,
      });
      embRows.push({
        chunk_id,
        document_id: id,
        vector,
        model_id,
      });
      // Yield between neural embedding inferences to keep 60fps UI responsiveness
      await yieldToMain();
    }

    await db.transaction("rw", db.chunks, db.embeddings, async () => {
      await db.chunks.bulkPut(chunkRows);
      await db.embeddings.bulkPut(embRows);
    });

    const pct = 0.45 + (Math.min(chunks.length, start + BATCH_SIZE) / chunks.length) * 0.52;
    await db.documents.update(id, { progress: Math.min(0.98, pct) });
  }

  await db.documents.update(id, { status: "indexed", progress: 1 });
}

export async function ingestFile(file: File, spaceId?: string | null): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!SUPPORTED_EXT.includes(ext)) {
    throw new Error(`.${ext} is not supported. Supported: ${SUPPORTED_EXT.map((e) => "." + e).join(", ")}`);
  }
  if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds 25 MB limit");

  const buf = await file.arrayBuffer();
  const hash = await sha(buf);
  if (await db.documents.where("hash").equals(hash).count()) {
    throw new Error(`${file.name} is already in your knowledge base`);
  }

  const id = uid("doc");
  const rec: DocumentRecord = {
    document_id: id,
    filename: file.name,
    file_type: file.type || ext,
    size: file.size,
    hash,
    status: "extracting",
    progress: 0.12,
    uploaded_at: new Date().toISOString(),
  };
  await db.documents.add(rec);

  const targetSpace = spaceId !== undefined ? spaceId : useApp.getState().activeSpaceId;
  if (targetSpace) {
    await assignDocToSpace(id, targetSpace);
  }

  try {
    await saveOriginalFile(id, file.name, buf);
    await processBufferForDoc(id, file.name, buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.documents.update(id, { status: "error", error: msg });
    throw e;
  }
  return id;
}

export async function reprocessDocument(id: string): Promise<void> {
  const doc = await db.documents.get(id);
  if (!doc) return;
  await db.documents.update(id, { status: "extracting", progress: 0.15, error: undefined });

  const buf = await readOriginalFile(id, doc.filename);
  if (buf) {
    try {
      await processBufferForDoc(id, doc.filename, buf);
      return;
    } catch (e) {
      await db.documents.update(id, { status: "error", error: String(e) });
      return;
    }
  }

  const existingChunks = await db.chunks.where("document_id").equals(id).sortBy("index");
  if (!existingChunks.length) {
    await db.documents.update(id, { status: "error", error: "Original binary not cached in OPFS" });
    return;
  }
  await db.documents.update(id, { status: "embedding", progress: 0.45 });
  for (let i = 0; i < existingChunks.length; i++) {
    const c = existingChunks[i];
    const { vector, model_id } = await embedText(c.text);
    await db.embeddings.put({ chunk_id: c.chunk_id, document_id: id, vector, model_id });
    await db.documents.update(id, { progress: 0.45 + ((i + 1) / existingChunks.length) * 0.52 });
  }
  await db.documents.update(id, { status: "indexed", progress: 1 });
}

export async function resumeInterruptedDocuments(): Promise<void> {
  if (typeof window === "undefined") return;
  const all = await db.documents.toArray();
  const interrupted = all.filter((d) => ["queued", "extracting", "chunking", "embedding"].includes(d.status));
  for (const doc of interrupted) {
    await reprocessDocument(doc.document_id).catch(() => {});
  }
}

export async function renameDocument(id: string, newName: string): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed) return;
  await db.documents.update(id, { filename: trimmed });
}

export async function assignDocToSpace(documentId: string, spaceId: string | null): Promise<void> {
  await db.space_documents.where("document_id").equals(documentId).delete();
  if (spaceId) {
    await db.space_documents.put({
      id: `${spaceId}_${documentId}`,
      space_id: spaceId,
      document_id: documentId,
    });
  }
}

export async function deleteDocument(id: string) {
  const doc = await db.documents.get(id);
  if (doc) await removeOriginalFile(id, doc.filename);
  await db.transaction("rw", db.documents, db.chunks, db.embeddings, db.space_documents, async () => {
    await db.documents.delete(id);
    await db.chunks.where("document_id").equals(id).delete();
    await db.embeddings.where("document_id").equals(id).delete();
    await db.space_documents.where("document_id").equals(id).delete();
  });
}

export interface RetrieveScope {
  spaceId?: string | null;
  documentIds?: string[];
  variant?: number;
}

/**
 * Detects whether a user prompt is asking for a broad summary / overview / takeaways
 * rather than a narrow needle-in-a-haystack fact lookup.
 */
export function isBroadOverviewQuery(query: string): boolean {
  return /\b(summar(y|ize|ise)|overview|about|main\s+(points|ideas|findings|conclusions|takeaways|topics)|key\s+(points|findings|insights|takeaways)|tl;?dr|outline|explain\s+(the|this)\s+(document|file|pdf|paper|report)|what\s+is\s+this\s+(document|file|pdf|paper|report))\b/i.test(
    query
  );
}

export async function retrieve(query: string, k?: number, threshold?: number, scope?: RetrieveScope): Promise<Source[]> {
  const { ragSettings } = useApp.getState();
  const topK = k ?? ragSettings.topK ?? 4;
  const minThreshold = threshold ?? ragSettings.similarityThreshold ?? 0.14;

  const activeSpaceId = scope?.spaceId !== undefined ? scope.spaceId : useApp.getState().activeSpaceId;
  const selectedDocIds = scope?.documentIds !== undefined ? scope.documentIds : useApp.getState().selectedDocIds;

  let allowedDocIds: string[] | null = null;
  if (selectedDocIds && selectedDocIds.length > 0) {
    allowedDocIds = selectedDocIds;
  } else if (activeSpaceId) {
    const spaceDocs = await db.space_documents.where("space_id").equals(activeSpaceId).toArray();
    allowedDocIds = spaceDocs.map((sd) => sd.document_id);
    if (!allowedDocIds.length) return [];
  }

  const [filteredEmbs, docs, scopedChunks] = await Promise.all([
    allowedDocIds ? db.embeddings.where("document_id").anyOf(allowedDocIds).toArray() : db.embeddings.toArray(),
    db.documents.toArray(),
    allowedDocIds ? db.chunks.where("document_id").anyOf(allowedDocIds).toArray() : db.chunks.toArray(),
  ]);
  if (!filteredEmbs.length) return [];

  const names = new Map(docs.map((d) => [d.document_id, d.filename]));
  const chunkMap = new Map(scopedChunks.map((c) => [c.chunk_id, c]));

  const primaryQuery = await embedText(query);
  const fallbackQueryVec = fallbackEmbed(query);
  const queryTokens = new Set(tokenize(query));
  const broadQuery = isBroadOverviewQuery(query);
  const variant = scope?.variant ?? 0;

  const scored = filteredEmbs.map((e) => {
    const qVec =
      e.model_id === TRANSFORMERS_MODEL_ID && primaryQuery.model_id === TRANSFORMERS_MODEL_ID
        ? primaryQuery.vector
        : fallbackQueryVec;
    let score = cosine(qVec, e.vector);

    const ch = chunkMap.get(e.chunk_id);
    if (ch && queryTokens.size > 0) {
      const chTokens = tokenize(ch.text);
      let hits = 0;
      for (const w of chTokens) if (queryTokens.has(w)) hits++;
      if (hits > 0) score += Math.min(0.25, (hits / queryTokens.size) * 0.18);
    }
    return { e, ch, score };
  });

  // For broad summary/overview queries, sample representative chunks evenly across the document(s)
  // (beginning, middle sections, conclusion) + top semantic matches, while filtering out bibliography/footnote junk.
  if (broadQuery) {
    const isBibliographyOrFootnoteChunk = (text: string) => {
      const clean = text.trim();
      if (/^(references|bibliography|works cited|notes|footnotes|endnotes|sources)\b/i.test(clean)) return true;
      const yearHits = (clean.match(/\b(18|19|20)\d{2}\b/g) || []).length;
      const pressHits = (
        clean.match(/\b(Press|Publisher|Publishing|Journal|Vol\.|pp\.|ibid|op\.\s*cit|University\s+Press|archive|CA\/|NA\/)\b/gi) ||
        []
      ).length;
      return yearHits >= 5 && pressHits >= 2;
    };

    const allValid = scored.filter((x) => x.ch).sort((a, b) => a.ch!.index - b.ch!.index);
    const proseValid = allValid.filter((x) => !isBibliographyOrFootnoteChunk(x.ch!.text));
    const valid = proseValid.length >= 2 ? proseValid : allValid;

    const targetCount = Math.max(topK, 6);
    const picked = new Map<string, (typeof valid)[number]>();

    // Group by document so multi-doc or single-doc summaries cover the full span of each document
    const byDoc = new Map<string, typeof valid>();
    for (const item of valid) {
      const list = byDoc.get(item.e.document_id) ?? [];
      list.push(item);
      byDoc.set(item.e.document_id, list);
    }

    const perDocQuota = Math.max(2, Math.ceil(targetCount / Math.max(1, byDoc.size)));
    for (const [, docItems] of byDoc) {
      // Always include the opening chunk (introduction/abstract) and second chunk if available
      if (docItems[0]) picked.set(docItems[0].e.chunk_id, docItems[0]);
      if (docItems.length > 2 && variant === 0 && docItems[1]) {
        picked.set(docItems[1].e.chunk_id, docItems[1]);
      }

      if (docItems.length <= perDocQuota) {
        for (const it of docItems) picked.set(it.e.chunk_id, it);
      } else {
        // Sample across the first 88% of prose chunks (avoiding trailing reference lists on the last page)
        const maxSpanIdx = Math.max(1, Math.floor((docItems.length - 1) * 0.88));
        for (let i = 0; i < perDocQuota; i++) {
          const baseIdx = Math.round((i * maxSpanIdx) / Math.max(1, perDocQuota - 1));
          const shiftedIdx =
            variant > 0 && i > 0 && i < perDocQuota - 1
              ? (baseIdx + variant) % (maxSpanIdx + 1)
              : baseIdx;
          const it = docItems[shiftedIdx];
          if (it) picked.set(it.e.chunk_id, it);
        }
      }
    }

    // Fill any remaining slots with highest semantic score chunks
    const byScore = [...valid].sort((a, b) => b.score - a.score);
    for (const it of byScore) {
      if (picked.size >= targetCount) break;
      picked.set(it.e.chunk_id, it);
    }

    const finalItems = [...picked.values()].sort((a, b) => a.ch!.index - b.ch!.index);
    return finalItems.map((t) => ({
      document_id: t.e.document_id,
      filename: names.get(t.e.document_id) ?? "Unknown",
      chunk_index: t.ch!.index,
      page: t.ch!.page,
      section: t.ch!.section,
      excerpt: t.ch!.text.slice(0, 650),
      score: Math.max(0.25, Math.min(0.99, t.score)),
    }));
  }

  let top = scored
    .filter((x) => x.score >= minThreshold && x.ch)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // If threshold was too strict for a natural-language question, fall back to the top-ranked passages
  if (!top.length) {
    top = scored
      .filter((x) => x.ch && x.score > 0.04)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  return top.map((t) => ({
    document_id: t.e.document_id,
    filename: names.get(t.e.document_id) ?? "Unknown",
    chunk_index: t.ch!.index,
    page: t.ch!.page,
    section: t.ch!.section,
    excerpt: t.ch!.text.slice(0, 650),
    score: Math.min(0.99, t.score),
  }));
}

export async function topTerms(n = 7, spaceId?: string | null) {
  const counts = new Map<string, number>();
  let chunks;
  if (spaceId) {
    const sds = await db.space_documents.where("space_id").equals(spaceId).toArray();
    const docIds = sds.map((s) => s.document_id);
    if (!docIds.length) return [];
    chunks = await db.chunks.where("document_id").anyOf(docIds).limit(200).toArray();
  } else {
    chunks = await db.chunks.limit(200).toArray();
  }
  for (const c of chunks) {
    for (const w of tokenize(c.text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}
