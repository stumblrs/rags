import Dexie, { type Table } from "dexie";

/** Local data model — mirrors §6.5 of the Product Concept Document. Everything stays in IndexedDB. */
export type DocStatus = "queued" | "extracting" | "chunking" | "embedding" | "indexed" | "error";

export interface DocumentRecord {
  document_id: string;
  filename: string;
  file_type: string;
  size: number;
  hash: string;
  status: DocStatus;
  progress: number; // 0..1
  uploaded_at: string;
  error?: string;
}
export interface ChunkRecord {
  chunk_id: string;
  document_id: string;
  index: number;
  text: string;
  page?: number;
  section?: string;
}
export interface EmbeddingRecord {
  chunk_id: string;
  document_id: string;
  vector: number[];
  model_id: string;
}
export interface SpaceRecord {
  space_id: string;
  name: string;
  description: string;
  created_at: string;
}
export interface SpaceDocumentRecord {
  id: string; // `${space_id}_${document_id}`
  space_id: string;
  document_id: string;
}
export interface Source {
  document_id: string;
  filename: string;
  chunk_index: number;
  page?: number;
  section?: string;
  excerpt: string;
  score: number;
}
export interface MessageRecord {
  message_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  voiceMode?: boolean; // true when asked via microphone -> assistant replies as a spoken audio bubble
  created_at: string;
}
export interface ConversationRecord {
  conversation_id: string;
  title: string;
  created_at: string;
}
export interface DeviceVaultRecord {
  id: string; // "primary"
  deviceId: string;
  hardwareHash: string;
  publicKeySpkiB64?: string;
  privateKey?: CryptoKey; // Non-extractable WebCrypto key sealed to browser origin
  optimalModelId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  visitCount: number;
}

class LocalDB extends Dexie {
  documents!: Table<DocumentRecord, string>;
  chunks!: Table<ChunkRecord, string>;
  embeddings!: Table<EmbeddingRecord, string>;
  spaces!: Table<SpaceRecord, string>;
  space_documents!: Table<SpaceDocumentRecord, string>;
  conversations!: Table<ConversationRecord, string>;
  messages!: Table<MessageRecord, string>;
  device_vault!: Table<DeviceVaultRecord, string>;

  constructor() {
    super("personal-local-ai");
    this.version(1).stores({
      documents: "document_id, hash, uploaded_at, status",
      chunks: "chunk_id, document_id",
      embeddings: "chunk_id, document_id",
      conversations: "conversation_id, created_at",
      messages: "message_id, conversation_id, created_at",
    });
    this.version(2).stores({
      documents: "document_id, hash, uploaded_at, status",
      chunks: "chunk_id, document_id",
      embeddings: "chunk_id, document_id",
      spaces: "space_id, name, created_at",
      space_documents: "id, space_id, document_id",
      conversations: "conversation_id, created_at",
      messages: "message_id, conversation_id, created_at",
    });
    this.version(3).stores({
      documents: "document_id, hash, uploaded_at, status",
      chunks: "chunk_id, document_id",
      embeddings: "chunk_id, document_id",
      spaces: "space_id, name, created_at",
      space_documents: "id, space_id, document_id",
      conversations: "conversation_id, created_at",
      messages: "message_id, conversation_id, created_at",
      device_vault: "id, deviceId, hardwareHash",
    });
  }
}

export const db = new LocalDB();
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Seed default Knowledge Spaces (§4.4) if none exist yet. */
export async function ensureDefaultSpaces() {
  if (typeof window === "undefined") return;
  const count = await db.spaces.count();
  if (count > 0) return;
  const now = new Date().toISOString();
  await db.spaces.bulkPut([
    { space_id: "space_business", name: "Business", description: "Business plans, sales reports & company records", created_at: now },
    { space_id: "space_education", name: "Education", description: "Textbooks, lecture notes & study materials", created_at: now },
    { space_id: "space_research", name: "Research", description: "Academic papers, notes & reference materials", created_at: now },
    { space_id: "space_personal", name: "Personal", description: "Personal notes, books & general knowledge", created_at: now },
  ]);
}
