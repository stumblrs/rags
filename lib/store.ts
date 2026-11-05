import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Source } from "./db";

/** Chatbot personalization (§4.2). Stored locally; changing it never requires re-indexing. */
export type AvatarCategory = "chat" | "robot" | "neural" | "friendly" | "geometric" | "custom";

export interface ChatbotConfig {
  name: string;
  avatar: AvatarCategory;
  customAvatarUrl?: string; // Data URL for user-uploaded avatar (§4.2.B)
  personality: "professional" | "friendly" | "concise" | "academic";
  language: string;
  response_style: "simple" | "detailed" | "bullets" | "steps" | "technical" | "executive";
}

export type VoiceEngineMode = "auto" | "kokoro" | "elevenlabs" | "piper" | "voicebox" | "browser";

/** Tunable RAG, Model & Voice parameters (§4.7 & §9) */
export interface RagSettings {
  chunkSize: number; // default 800
  chunkOverlap: number; // default 140
  topK: number; // default 4
  similarityThreshold: number; // default 0.14
  selectedLlmId: string; // auto-detected or user-overridden
  userSelectedModel: boolean; // true if user manually overrode hardware recommendation
  enableOcr: boolean; // default true
  voiceEngine: VoiceEngineMode; // "auto" | "kokoro" | "elevenlabs" | "piper" | "voicebox" | "browser"
  elevenLabsApiKey: string; // optional personal API key for studio human voice
  elevenLabsVoiceId: string; // e.g. "21m00Tcm4TlvDq8ikWAM" (Rachel)
  elevenLabsModelId: string; // "eleven_flash_v2_5" | "eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_v3"
  piperVoiceId: string; // e.g. "en_US-hfc_female-medium", "en_US-lessac-medium", "en_GB-alba-medium"
  kokoroVoiceId: string; // e.g. "af_heart", "af_bella", "am_adam", "bf_emma", "bm_george"
  voiceboxUrl: string; // default "http://127.0.0.1:17493"
  voiceboxProfileId: string; // optional cloned voice profile ID in Voicebox.sh
  voiceSpeed: number; // 0.7 to 1.5 (default 1.0)
  voicePitch: number; // 0.7 to 1.3 (default 1.0)
  systemVoiceURI: string; // optional specific OS SpeechSynthesisVoice URI
  autoSendVoice: boolean; // whether finishing voice recording automatically submits the question
  voiceResponseMode: "spoken_bubble" | "spoken_and_text"; // "spoken_bubble" talks back without dumping a wall of text
  voiceConversational: boolean; // default true — contractions + spoken-form rewriting so replies sound like speech, not a document
  voicePauseScale: number; // 0.5 to 1.8 (default 1.0) — multiplies every natural pause between phrases (lower = brisker)
  voiceAutoStop: boolean; // default true — stop listening automatically once the person finishes talking
  voiceEndOfTurnMs: number; // 800 to 5000 (default 2000) — base silence before listening stops (longer if the sentence sounds unfinished)
}

/** One-tap conversation feel (§4.7). Applying a preset only writes the four values below. */
export type VoicePresetId = "natural" | "brisk" | "relaxed";

export interface VoicePresetOption {
  id: VoicePresetId;
  label: string;
  description: string;
  settings: Pick<RagSettings, "voiceSpeed" | "voicePitch" | "voicePauseScale" | "voiceEndOfTurnMs">;
}

export const VOICE_PRESETS: VoicePresetOption[] = [
  {
    id: "natural",
    label: "Natural (Default)",
    description: "Balanced pacing that feels like talking to a person.",
    settings: { voiceSpeed: 1.0, voicePitch: 1.0, voicePauseScale: 1.0, voiceEndOfTurnMs: 2000 },
  },
  {
    id: "brisk",
    label: "Brisk",
    description: "Quicker delivery and shorter pauses; replies as soon as you stop talking.",
    settings: { voiceSpeed: 1.1, voicePitch: 1.0, voicePauseScale: 0.7, voiceEndOfTurnMs: 1400 },
  },
  {
    id: "relaxed",
    label: "Relaxed",
    description: "Slower, thoughtful pacing with room for you to pause mid-thought.",
    settings: { voiceSpeed: 0.95, voicePitch: 1.0, voicePauseScale: 1.3, voiceEndOfTurnMs: 2800 },
  },
];

/** Hard bounds for numeric voice settings so a bad value (NaN, 0, 99) can never reach the synthesizer or recognizer. */
const RAG_NUMERIC_BOUNDS: Record<string, readonly [number, number]> = {
  voiceSpeed: [0.7, 1.5],
  voicePitch: [0.7, 1.3],
  voicePauseScale: [0.5, 1.8],
  voiceEndOfTurnMs: [800, 5000],
};

/** Text settings people commonly paste with stray spaces or newlines (an untrimmed API key is rejected as invalid). */
const RAG_TRIMMED_STRINGS = ["elevenLabsApiKey", "elevenLabsVoiceId", "elevenLabsModelId"] as const;

/** Clamps out-of-range numbers; drops non-numeric values so the previous/default value is kept instead. */
function sanitizeRagSettings<T extends Partial<RagSettings>>(settings: T): T {
  const next = { ...settings } as Record<string, unknown>;
  for (const key of RAG_TRIMMED_STRINGS) {
    if (typeof next[key] === "string") next[key] = (next[key] as string).trim();
  }
  for (const key of Object.keys(RAG_NUMERIC_BOUNDS)) {
    if (!(key in next) || next[key] === undefined) continue;
    const value = next[key];
    const [min, max] = RAG_NUMERIC_BOUNDS[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      next[key] = Math.min(max, Math.max(min, value));
    } else {
      delete next[key];
    }
  }
  return next as T;
}

export interface HardwareProfile {
  deviceId?: string;
  hardwareHash?: string;
  webgpu: boolean;
  gpuVendor: string;
  maxBufferMB: number;
  deviceMemoryGB: number;
  cores: number;
  recommendedModelId: string;
  tierLabel: string;
}

export type ThemeMode = "dark" | "light";
export type ModelStatus = "idle" | "downloading" | "ready" | "fallback" | "error";
export type ActiveModal = null | "onboarding" | "library" | "citation" | "settings";
export type WorkspaceTab = "overview" | "chat" | "documents";

interface AppState {
  chatbot: ChatbotConfig;
  ragSettings: RagSettings;
  hardware: HardwareProfile | null;
  theme: ThemeMode;
  onboarded: boolean;
  activeTab: WorkspaceTab;
  conversationId: string | null;
  activeSpaceId: string | null; // null = All documents
  selectedDocIds: string[]; // empty = all in scope
  activeModal: ActiveModal;
  activeCitation: Source | null;
  embedStatus: ModelStatus;
  embedProgress: string;
  llmStatus: ModelStatus;
  llmProgress: string;
  setChatbot: (c: Partial<ChatbotConfig>) => void;
  setRagSettings: (r: Partial<RagSettings>) => void;
  setVoicePreset: (id: VoicePresetId) => void;
  setHardware: (h: HardwareProfile) => void;
  setTheme: (t: ThemeMode) => void;
  setOnboarded: (v: boolean) => void;
  setActiveTab: (t: WorkspaceTab) => void;
  setConversation: (id: string | null) => void;
  setActiveSpace: (id: string | null) => void;
  toggleSelectedDoc: (docId: string) => void;
  clearSelectedDocs: () => void;
  openModal: (m: ActiveModal) => void;
  openCitation: (s: Source) => void;
  setEmbedStatus: (status: ModelStatus, progress?: string) => void;
  setLlmStatus: (status: ModelStatus, progress?: string) => void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      chatbot: {
        name: "mairag",
        avatar: "chat",
        personality: "friendly",
        language: "English",
        response_style: "detailed",
      },
      ragSettings: {
        chunkSize: 800,
        chunkOverlap: 140,
        topK: 4,
        similarityThreshold: 0.14,
        selectedLlmId: "SmolLM2-360M-Instruct-q4f16_1-MLC",
        userSelectedModel: false,
        enableOcr: true,
        voiceEngine: "kokoro",
        elevenLabsApiKey: "",
        elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
        elevenLabsModelId: "eleven_flash_v2_5",
        piperVoiceId: "en_US-hfc_female-medium",
        kokoroVoiceId: "af_heart",
        voiceboxUrl: "http://127.0.0.1:17493",
        voiceboxProfileId: "",
        voiceSpeed: 1.0,
        voicePitch: 1.0,
        systemVoiceURI: "",
        autoSendVoice: true,
        voiceResponseMode: "spoken_bubble",
        voiceConversational: true,
        voicePauseScale: 1.0,
        voiceAutoStop: true,
        voiceEndOfTurnMs: 2000,
      },
      hardware: null,
      theme: "dark",
      onboarded: false,
      activeTab: "overview",
      conversationId: null,
      activeSpaceId: null,
      selectedDocIds: [],
      activeModal: null,
      activeCitation: null,
      embedStatus: "idle",
      embedProgress: "",
      llmStatus: "idle",
      llmProgress: "",
      setChatbot: (c) => set((s) => ({ chatbot: { ...s.chatbot, ...c } })),
      setRagSettings: (r) => set((s) => ({ ragSettings: { ...s.ragSettings, ...sanitizeRagSettings(r) } })),
      setVoicePreset: (id) => {
        const preset = VOICE_PRESETS.find((p) => p.id === id);
        if (!preset) return;
        set((s) => ({ ragSettings: { ...s.ragSettings, ...preset.settings } }));
      },
      setHardware: (hardware) => set({ hardware }),
      setTheme: (theme) => set({ theme }),
      setOnboarded: (onboarded) => set({ onboarded }),
      setActiveTab: (activeTab) => set({ activeTab }),
      setConversation: (conversationId) => set({ conversationId }),
      setActiveSpace: (activeSpaceId) => set({ activeSpaceId, selectedDocIds: [] }),
      toggleSelectedDoc: (docId) =>
        set((s) => ({
          selectedDocIds: s.selectedDocIds.includes(docId)
            ? s.selectedDocIds.filter((id) => id !== docId)
            : [...s.selectedDocIds, docId],
        })),
      clearSelectedDocs: () => set({ selectedDocIds: [] }),
      openModal: (activeModal) => set({ activeModal }),
      openCitation: (activeCitation) => set({ activeCitation, activeModal: "citation" }),
      setEmbedStatus: (embedStatus, embedProgress = "") => set({ embedStatus, embedProgress }),
      setLlmStatus: (llmStatus, llmProgress = "") => set({ llmStatus, llmProgress }),
    }),
    {
      name: "pla-settings",
      partialize: (state) => ({
        chatbot: state.chatbot,
        ragSettings: state.ragSettings,
        theme: state.theme,
        onboarded: state.onboarded,
        activeTab: state.activeTab,
        conversationId: state.conversationId,
        activeSpaceId: state.activeSpaceId,
      }),
      // zustand's default merge is shallow, so a user who saved `ragSettings` before a setting existed would load an object
      // WITHOUT it. Merging nested objects over the defaults gives every existing install the new voice settings automatically.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        const savedChatbot = { ...current.chatbot, ...saved.chatbot };
        if (!savedChatbot.name || savedChatbot.name === "Cognitive AI") {
          savedChatbot.name = "mairag";
        }
        return {
          ...current,
          ...saved,
          chatbot: savedChatbot,
          ragSettings: sanitizeRagSettings({ ...current.ragSettings, ...saved.ragSettings }),
        };
      },
    }
  )
);