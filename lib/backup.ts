/**
 * Local storage inspection, Knowledge Base export/import backup (with optional AES-GCM encryption), and full data wipe (§4.8 & §7).
 */

import { db, ensureDefaultSpaces } from "./db";
import { recognizeDevice } from "./device";
import { detectHardwareAndSelectModel } from "./ai";
import { clearAllOpfsFiles } from "./opfs";
import { useApp, type ChatbotConfig, type RagSettings } from "./store";

export interface StorageBreakdown {
  totalBytes: number;
  quotaBytes: number;
  documentsBytes: number;
  modelCacheBytes: number;
  documentsCount: number;
  chunksCount: number;
  vectorsCount: number;
  conversationsCount: number;
  persisted: boolean;
  perDocumentSizes: { document_id: string; filename: string; size: number; status: string }[];
}

export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  const [rawDocs, chunksCount, vectorsCount, conversationsCount] = await Promise.all([
    db.documents.toArray(),
    db.chunks.count(),
    db.embeddings.count(),
    db.conversations.count(),
  ]);
  const docs = [...rawDocs].sort((a, b) => (b.size || 0) - (a.size || 0));
  const documentsBytes = docs.reduce((s, d) => s + (d.size || 0), 0);

  let totalBytes = documentsBytes;
  let quotaBytes = 0;
  let persisted = false;

  if (typeof navigator !== "undefined" && navigator.storage) {
    try {
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        if (est.usage) totalBytes = Math.max(totalBytes, est.usage);
        if (est.quota) quotaBytes = est.quota;
      }
      if (navigator.storage.persisted) {
        persisted = await navigator.storage.persisted();
      }
    } catch {
      // ignore storage estimate errors
    }
  }

  // Estimate model & asset cache storage usage (total browser usage minus raw documents & vector overhead)
  const vectorOverhead = vectorsCount * 384 * 4;
  const modelCacheBytes = Math.max(0, totalBytes - documentsBytes - vectorOverhead);

  return {
    totalBytes,
    quotaBytes,
    documentsBytes,
    modelCacheBytes,
    documentsCount: docs.length,
    chunksCount,
    vectorsCount,
    conversationsCount,
    persisted,
    perDocumentSizes: docs.map((d) => ({
      document_id: d.document_id,
      filename: d.filename,
      size: d.size || 0,
      status: d.status,
    })),
  };
}

export async function clearConversationHistoryOnly(): Promise<void> {
  await db.transaction("rw", [db.conversations, db.messages], async () => {
    await db.conversations.clear();
    await db.messages.clear();
  });
  useApp.getState().setConversation(null);
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 120000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function exportKnowledgeBaseBackup(passphrase?: string): Promise<void> {
  const [documents, chunks, embeddings, spaces, space_documents, conversations, messages] = await Promise.all([
    db.documents.toArray(),
    db.chunks.toArray(),
    db.embeddings.toArray(),
    db.spaces.toArray(),
    db.space_documents.toArray(),
    db.conversations.toArray(),
    db.messages.toArray(),
  ]);

  const { chatbot, ragSettings, hardware } = useApp.getState();
  const recognized = await recognizeDevice().catch(() => null);
  const innerPayload = {
    version: 3,
    exported_at: new Date().toISOString(),
    originDevice: {
      deviceId: recognized?.deviceId ?? hardware?.deviceId,
      hardwareHash: recognized?.hardwareHash ?? hardware?.hardwareHash,
    },
    chatbot,
    ragSettings,
    documents,
    chunks,
    embeddings,
    spaces,
    space_documents,
    conversations,
    messages,
  };

  let finalJson = JSON.stringify(innerPayload, null, 2);

  if (passphrase && passphrase.trim()) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase.trim(), salt);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(finalJson)
    );
    finalJson = JSON.stringify(
      {
        encrypted: true,
        kdf: "PBKDF2-SHA256-120000",
        cipher: "AES-256-GCM",
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(cipherBuf)),
      },
      null,
      2
    );
  }

  const blob = new Blob([finalJson], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `personal-local-ai-backup-${new Date().toISOString().slice(0, 10)}${passphrase?.trim() ? ".enc" : ""}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importKnowledgeBaseBackup(
  file: File,
  passphrase?: string
): Promise<{ docs: number; chunks: number }> {
  const raw = await file.text();
  let data = JSON.parse(raw);

  if (data?.encrypted) {
    if (!passphrase || !passphrase.trim()) {
      throw new Error("This backup is encrypted. Enter the backup passphrase first.");
    }
    try {
      const salt = fromBase64(data.salt);
      const iv = fromBase64(data.iv);
      const ciphertext = fromBase64(data.ciphertext);
      const key = await deriveAesKey(passphrase.trim(), salt);
      const plainBuf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        key,
        ciphertext as BufferSource
      );
      data = JSON.parse(new TextDecoder().decode(plainBuf));
    } catch {
      throw new Error("Decryption failed. Incorrect passphrase or corrupted backup.");
    }
  }

  if (!data || !Array.isArray(data.documents) || !Array.isArray(data.chunks)) {
    throw new Error("Invalid backup file format");
  }

  await db.transaction(
    "rw",
    [db.documents, db.chunks, db.embeddings, db.spaces, db.space_documents, db.conversations, db.messages],
    async () => {
      if (data.documents?.length) await db.documents.bulkPut(data.documents);
      if (data.chunks?.length) await db.chunks.bulkPut(data.chunks);
      if (data.embeddings?.length) await db.embeddings.bulkPut(data.embeddings);
      if (data.spaces?.length) await db.spaces.bulkPut(data.spaces);
      if (data.space_documents?.length) await db.space_documents.bulkPut(data.space_documents);
      if (data.conversations?.length) await db.conversations.bulkPut(data.conversations);
      if (data.messages?.length) await db.messages.bulkPut(data.messages);
    }
  );

  if (data.chatbot) {
    useApp.getState().setChatbot(data.chatbot as Partial<ChatbotConfig>);
  }
  if (data.ragSettings) {
    const currentDevice = await recognizeDevice().catch(() => null);
    const backupHw = data.originDevice?.hardwareHash;
    const isSameHardware =
      !backupHw || !currentDevice?.hardwareHash || backupHw === currentDevice.hardwareHash;

    if (isSameHardware) {
      useApp.getState().setRagSettings(data.ragSettings as Partial<RagSettings>);
    } else {
      // Silently adapt model selection to the current device's hardware when restoring across different machines
      const { selectedLlmId: _omitModel, userSelectedModel: _omitLock, ...portableRagSettings } =
        data.ragSettings as Partial<RagSettings>;
      void _omitModel;
      void _omitLock;
      useApp.getState().setRagSettings({ ...portableRagSettings, userSelectedModel: false });
      detectHardwareAndSelectModel(false).catch(() => {});
    }
  }
  return { docs: data.documents.length, chunks: data.chunks.length };
}

export async function clearAllApplicationData(): Promise<void> {
  await db.transaction(
    "rw",
    [db.documents, db.chunks, db.embeddings, db.spaces, db.space_documents, db.conversations, db.messages],
    async () => {
      await db.documents.clear();
      await db.chunks.clear();
      await db.embeddings.clear();
      await db.spaces.clear();
      await db.space_documents.clear();
      await db.conversations.clear();
      await db.messages.clear();
    }
  );
  await clearAllOpfsFiles();
  await ensureDefaultSpaces();
  useApp.getState().setConversation(null);
  useApp.getState().setActiveSpace(null);
  useApp.getState().clearSelectedDocs();
}
