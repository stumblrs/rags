"use client";
import { useEffect, useRef, useState } from "react";
import {
  clearAllApplicationData,
  clearConversationHistoryOnly,
  exportKnowledgeBaseBackup,
  formatBytes,
  getStorageBreakdown,
  importKnowledgeBaseBackup,
  type StorageBreakdown,
} from "@/lib/backup";
import { detectHardwareAndSelectModel, ensureLlmEngine, hasWebGPU, SUPPORTED_LLMS } from "@/lib/ai";
import {
  ELEVENLABS_MODELS,
  ELEVENLABS_VOICES,
  getAvailableSystemVoices,
  KOKORO_VOICES,
  PIPER_VOICES,
  probeElevenLabsKey,
  probeVoiceboxServer,
  speakAnswer,
  stopSpeaking,
  type SystemVoiceOption,
  type VoiceboxProfile,
} from "@/lib/voice";
import { useApp, type VoiceEngineMode } from "@/lib/store";

export default function StorageSettingsModal() {
  const {
    activeModal,
    openModal,
    chatbot,
    ragSettings,
    setRagSettings,
    hardware,
    theme,
    setTheme,
    embedStatus,
    embedProgress,
    llmStatus,
    llmProgress,
  } = useApp();

  const [info, setInfo] = useState<StorageBreakdown | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmClearChats, setConfirmClearChats] = useState(false);
  const [showPerDoc, setShowPerDoc] = useState(false);
  const [voiceboxOnline, setVoiceboxOnline] = useState<boolean | null>(null);
  const [voiceboxProfiles, setVoiceboxProfiles] = useState<VoiceboxProfile[]>([]);
  const [systemVoices, setSystemVoices] = useState<SystemVoiceOption[]>([]);
  const [testingVoice, setTestingVoice] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyValidation, setKeyValidation] = useState<{ valid: boolean; error?: string; userTier?: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [customVoiceIdMode, setCustomVoiceIdMode] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setInfo(await getStorageBreakdown());
    setSystemVoices(getAvailableSystemVoices());
    const vb = await probeVoiceboxServer();
    setVoiceboxOnline(vb.online);
    setVoiceboxProfiles(vb.profiles);
  }

  useEffect(() => {
    if (activeModal === "settings") {
      refresh();
      setConfirmWipe(false);
      setConfirmClearChats(false);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.onvoiceschanged = () => {
          setSystemVoices(getAvailableSystemVoices());
        };
      }
    } else {
      stopSpeaking();
      setTestingVoice(false);
    }
  }, [activeModal]);

  if (activeModal !== "settings") return null;

  async function requestPersistence() {
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      setStatusMsg(granted ? "Persistent browser storage granted." : "Browser manages storage persistence automatically.");
      await refresh();
    }
  }

  async function onExport() {
    await exportKnowledgeBaseBackup(passphrase);
    setStatusMsg(
      passphrase.trim()
        ? "Exported AES-256-GCM encrypted Knowledge Base backup."
        : "Exported Knowledge Base backup (.json)."
    );
  }

  async function onImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const res = await importKnowledgeBaseBackup(file, passphrase);
      setStatusMsg(`Imported ${res.docs} documents (${res.chunks} chunks).`);
      await refresh();
    } catch (e) {
      setStatusMsg(`Import failed: ${(e as Error).message}`);
    }
  }

  async function onClearChats() {
    await clearConversationHistoryOnly();
    setConfirmClearChats(false);
    setStatusMsg("All conversation history deleted (documents and embeddings kept intact).");
    await refresh();
  }

  async function onWipe() {
    await clearAllApplicationData();
    setConfirmWipe(false);
    setStatusMsg("All local documents, embeddings, and chat history deleted.");
    await refresh();
  }

  const webgpu = hasWebGPU();
  const activeModelSpec = SUPPORTED_LLMS.find((m) => m.id === ragSettings.selectedLlmId) ?? SUPPORTED_LLMS[1];

  return (
    <div className="modal-backdrop" onClick={() => openModal(null)}>
      <div className="modal-card" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h3>AI Models, RAG Parameters, Storage &amp; Privacy</h3>
            <span className="modal-sub">
              Origin-isolated local database (IndexedDB + OPFS) · Zero external telemetry
            </span>
          </div>
          <button className="modal-close" onClick={() => openModal(null)}>✕</button>
        </header>

        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {statusMsg && <div className="inline-toast">{statusMsg}</div>}

          {/* 1. Local AI Model Catalogue (§4.7) */}
          <div className="modal-section-title">1. Local AI Models &amp; Hardware Compatibility</div>
          <div className="model-cards">
            <div className="model-card">
              <div>
                <b>Embedding Model · Xenova/all-MiniLM-L6-v2</b>
                <span>384-dim semantic vectors · ~23 MB quantized (q8) · Cached in browser</span>
              </div>
              <span className="badge-pill">
                {embedProgress || (embedStatus === "ready" ? "Ready" : embedStatus === "fallback" ? "Lexical Fallback" : "Auto on ingest")}
              </span>
            </div>

            <div className="model-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <b>
                    Local Small Language Model (SLM) ·{" "}
                    {hardware
                      ? `${hardware.tierLabel} (${hardware.cores} cores, ~${hardware.deviceMemoryGB}GB RAM${
                          hardware.maxBufferMB ? `, ${hardware.maxBufferMB}MB GPU buffer` : ""
                        })`
                      : `WebGPU: ${webgpu ? "Supported" : "Unavailable"}`}
                  </b>
                  <span>
                    {activeModelSpec.params} params · {activeModelSpec.downloadSize} · {activeModelSpec.vramRequired} · Quantization {activeModelSpec.quantization} · {activeModelSpec.languages}
                  </span>
                </div>
                {webgpu ? (
                  <button
                    className="btn-neon"
                    disabled={llmStatus === "downloading"}
                    onClick={() => ensureLlmEngine(ragSettings.selectedLlmId)}
                  >
                    {llmStatus === "downloading"
                      ? llmProgress || "Downloading…"
                      : llmStatus === "ready"
                      ? "Reload / Switch Model"
                      : "Load Selected LLM"}
                  </button>
                ) : (
                  <span className="badge-pill">Extractive Synthesis</span>
                )}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <select
                  className="select-field"
                  style={{ flex: 1 }}
                  value={ragSettings.selectedLlmId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setRagSettings({ selectedLlmId: nextId, userSelectedModel: true });
                    if (webgpu) ensureLlmEngine(nextId);
                  }}
                >
                  {SUPPORTED_LLMS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id === hardware?.recommendedModelId ? "★ Auto-Matched: " : ""}
                      {m.name} — {m.downloadSize} ({m.vramRequired}, {m.languages})
                    </option>
                  ))}
                </select>
                {ragSettings.userSelectedModel && (
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setRagSettings({ userSelectedModel: false });
                      detectHardwareAndSelectModel(true);
                    }}
                    title="Reset to automatic hardware-matched model"
                  >
                    Auto-Match Hardware
                  </button>
                )}
              </div>
            </div>

            {/* Neural Voice Synthesis & Speech Studio (Piper TTS + Kokoro-82M + Voicebox.sh + System Voice) */}
            <div className="model-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <b>
                    Voice Synthesis &amp; Speech Configuration ·{" "}
                    {voiceboxOnline
                      ? "Voicebox.sh Studio Connected (127.0.0.1:17493)"
                      : "Piper Neural TTS (OPFS) + Kokoro-82M + System Speech"}
                  </b>
                  <span>
                    When you ask a question using the mic, your assistant automatically talks back using Piper Neural TTS
                  </span>
                </div>
                <button
                  className={testingVoice ? "btn-danger" : "btn-neon"}
                  onClick={() => {
                    if (testingVoice) {
                      stopSpeaking();
                      setTestingVoice(false);
                      return;
                    }
                    setTestingVoice(true);
                    speakAnswer(
                      `Hello! I am ${chatbot.name}, your private local AI assistant. Whenever you speak to me with the microphone, I will talk right back to you.`,
                      chatbot,
                      {
                        onStatus: (st) => {
                          if (st) setStatusMsg(st);
                        },
                        onStart: () => setStatusMsg("Playing voice preview…"),
                        onEnd: () => {
                          setTestingVoice(false);
                          setStatusMsg(null);
                        },
                      }
                    );
                  }}
                >
                  {testingVoice ? "⏹ Stop Preview" : "🔊 Test Voice"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <select
                  className="select-field"
                  value={ragSettings.voiceEngine || "kokoro"}
                  onChange={(e) => setRagSettings({ voiceEngine: e.target.value as VoiceEngineMode })}
                  title="Choose voice synthesis engine"
                >
                  <option value="kokoro">Engine: Kokoro-82M Neural TTS (Free · Offline)</option>
                  <option value="elevenlabs">Engine: ElevenLabs Studio (Ultra-Realistic Cloud API)</option>
                  <option value="auto">Engine: Smart Auto (ElevenLabs → Kokoro → Piper → OS)</option>
                  <option value="piper">Engine: Piper Neural TTS (OPFS · Multilingual)</option>
                  <option value="voicebox">Engine: Voicebox.sh Local Studio (127.0.0.1:17493)</option>
                  <option value="browser">Engine: OS System Voice (0MB · Battery Saver)</option>
                </select>

                {ragSettings.voiceEngine === "elevenlabs" ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <select
                      className="select-field"
                      style={{ flex: 1 }}
                      value={customVoiceIdMode ? "custom" : ragSettings.elevenLabsVoiceId || "21m00Tcm4TlvDq8ikWAM"}
                      onChange={(e) => {
                        if (e.target.value === "custom") {
                          setCustomVoiceIdMode(true);
                        } else {
                          setCustomVoiceIdMode(false);
                          setRagSettings({ elevenLabsVoiceId: e.target.value });
                        }
                      }}
                      title="Select ElevenLabs human voice"
                    >
                      {ELEVENLABS_VOICES.map((v) => (
                        <option key={v.id} value={v.id}>
                          ElevenLabs: {v.name} ({v.gender} · {v.description})
                        </option>
                      ))}
                      <option value="custom">✎ Custom / Cloned Voice ID…</option>
                    </select>
                  </div>
                ) : (ragSettings.voiceEngine === "voicebox" || (voiceboxOnline && ragSettings.voiceEngine === "auto")) ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="input-field"
                      placeholder="http://127.0.0.1:17493"
                      value={ragSettings.voiceboxUrl || "http://127.0.0.1:17493"}
                      onChange={(e) => setRagSettings({ voiceboxUrl: e.target.value })}
                      style={{ flex: 1 }}
                    />
                    {voiceboxProfiles.length > 0 && (
                      <select
                        className="select-field"
                        value={ragSettings.voiceboxProfileId || ""}
                        onChange={(e) => setRagSettings({ voiceboxProfileId: e.target.value })}
                        title="Select cloned voice profile from Voicebox.sh"
                      >
                        <option value="">Default Voicebox Profile</option>
                        {voiceboxProfiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      className="btn-secondary"
                      onClick={async () => {
                        const vb = await probeVoiceboxServer(ragSettings.voiceboxUrl);
                        setVoiceboxOnline(vb.online);
                        setVoiceboxProfiles(vb.profiles);
                        setStatusMsg(
                          vb.online
                            ? `Connected to Voicebox.sh (${vb.profiles.length} voice profile(s) found).`
                            : "Voicebox.sh desktop server not detected on port 17493. Falling back to in-browser Piper Neural TTS."
                        );
                      }}
                    >
                      Probe
                    </button>
                  </div>
                ) : ragSettings.voiceEngine === "browser" ? (
                  <select
                    className="select-field"
                    value={ragSettings.systemVoiceURI || ""}
                    onChange={(e) => setRagSettings({ systemVoiceURI: e.target.value })}
                    title="Select OS system speech synthesis voice"
                  >
                    <option value="">Auto-Match Best OS Voice ({chatbot.language})</option>
                    {systemVoices.map((sv) => (
                      <option key={sv.uri} value={sv.uri}>
                        {sv.name} ({sv.lang}{sv.local ? " · Local" : ""})
                      </option>
                    ))}
                  </select>
                ) : ragSettings.voiceEngine === "kokoro" ? (
                  <select
                    className="select-field"
                    value={ragSettings.kokoroVoiceId || "af_heart"}
                    onChange={(e) => setRagSettings({ kokoroVoiceId: e.target.value })}
                    title="Select Kokoro-82M neural voice persona"
                  >
                    {KOKORO_VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        Kokoro Voice: {v.label} ({v.accent})
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    className="select-field"
                    value={ragSettings.piperVoiceId || "en_US-hfc_female-medium"}
                    onChange={(e) => setRagSettings({ piperVoiceId: e.target.value })}
                    title="Select Piper neural voice model (cached in OPFS)"
                  >
                    {PIPER_VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        Piper Voice: {v.label} ({v.language})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* ElevenLabs API Key & Settings Configuration */}
              {(ragSettings.voiceEngine === "elevenlabs" || ragSettings.voiceEngine === "auto") && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--surface-raised, rgba(255,255,255,0.04))",
                    borderRadius: "8px",
                    border: "1px solid var(--border-color)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>🎙️ ElevenLabs API Configuration</span>
                      {keyValidation?.valid && (
                        <span style={{ fontSize: 11, color: "#10b981", background: "rgba(16,185,129,0.12)", padding: "1px 6px", borderRadius: 4 }}>
                          ✓ Connected ({keyValidation.userTier})
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: "var(--text-2)" }}>Keys stored only in local browser</span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 6 }}>
                    <div style={{ position: "relative" }}>
                      <input
                        type={showApiKey ? "text" : "password"}
                        className="input-field"
                        placeholder="Paste your ElevenLabs API Key (e.g. sk_...)"
                        value={ragSettings.elevenLabsApiKey || ""}
                        onChange={(e) => {
                          setRagSettings({ elevenLabsApiKey: e.target.value.trim() });
                          setKeyValidation(null);
                        }}
                        style={{ width: "100%", paddingRight: 32, fontFamily: "monospace", fontSize: 12 }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        style={{
                          position: "absolute",
                          right: 6,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          opacity: 0.6,
                          fontSize: 12,
                        }}
                        title={showApiKey ? "Hide key" : "Show key"}
                      >
                        {showApiKey ? "🙈" : "👁️"}
                      </button>
                    </div>

                    <button
                      className="btn-secondary"
                      disabled={testingKey || !ragSettings.elevenLabsApiKey}
                      onClick={async () => {
                        setTestingKey(true);
                        const result = await probeElevenLabsKey(ragSettings.elevenLabsApiKey || "");
                        setTestingKey(false);
                        setKeyValidation(result);
                        setStatusMsg(
                          result.valid
                            ? `ElevenLabs connected successfully! Tier: ${result.userTier}.`
                            : `ElevenLabs check failed: ${result.error}`
                        );
                      }}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {testingKey ? "Checking…" : "Validate Key"}
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 3 }}>ElevenLabs Model</div>
                      <select
                        className="select-field"
                        style={{ width: "100%" }}
                        value={ragSettings.elevenLabsModelId || "eleven_turbo_v2_5"}
                        onChange={(e) => setRagSettings({ elevenLabsModelId: e.target.value })}
                      >
                        {ELEVENLABS_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 3 }}>Voice ID</div>
                      <input
                        className="input-field"
                        style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
                        placeholder="21m00Tcm4TlvDq8ikWAM (Rachel)"
                        value={ragSettings.elevenLabsVoiceId || ""}
                        onChange={(e) => setRagSettings({ elevenLabsVoiceId: e.target.value.trim() })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Speed, Pitch & Mic Reply Style Controls */}
              <div className="stats-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginTop: 2 }}>
                <div className="stat-box">
                  <span>Speaking Speed: <b>{(ragSettings.voiceSpeed ?? 1.0).toFixed(2)}x</b></span>
                  <input
                    type="range"
                    min={0.7}
                    max={1.4}
                    step={0.05}
                    value={ragSettings.voiceSpeed ?? 1.0}
                    onChange={(e) => setRagSettings({ voiceSpeed: Number(e.target.value) })}
                  />
                  <small>Applies to Piper, Kokoro, Voicebox &amp; OS</small>
                </div>

                <div className="stat-box">
                  <span>Voice Pitch: <b>{(ragSettings.voicePitch ?? 1.0).toFixed(2)}</b></span>
                  <input
                    type="range"
                    min={0.75}
                    max={1.25}
                    step={0.05}
                    value={ragSettings.voicePitch ?? 1.0}
                    onChange={(e) => setRagSettings({ voicePitch: Number(e.target.value) })}
                  />
                  <small>Tunes OS speech pitch cadence</small>
                </div>

                <div className="stat-box" style={{ justifyContent: "space-between", gap: 4 }}>
                  <span>When I Use the Mic</span>
                  <select
                    className="select-field"
                    style={{ padding: "4px 8px", fontSize: 11.5 }}
                    value={ragSettings.voiceResponseMode || "spoken_bubble"}
                    onChange={(e) =>
                      setRagSettings({
                        voiceResponseMode: e.target.value as "spoken_bubble" | "spoken_and_text",
                      })
                    }
                  >
                    <option value="spoken_bubble">Talk Back (Audio Bubble Only)</option>
                    <option value="spoken_and_text">Talk Back + Full Text</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-0)" }}>
                    <input
                      type="checkbox"
                      checked={ragSettings.autoSendVoice ?? true}
                      onChange={(e) => setRagSettings({ autoSendVoice: e.target.checked })}
                    />
                    Auto-send after speaking
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* 2. Knowledge Base Retrieval & Chunking Settings (§9) */}
          <div className="modal-section-title">2. Knowledge Base Retrieval &amp; OCR Settings</div>
          <div className="stats-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <div className="stat-box">
              <span>Chunk Size: <b>{ragSettings.chunkSize} chars</b> (Overlap: {ragSettings.chunkOverlap})</span>
              <input
                type="range"
                min={300}
                max={1600}
                step={100}
                value={ragSettings.chunkSize}
                onChange={(e) => {
                  const sz = Number(e.target.value);
                  setRagSettings({ chunkSize: sz, chunkOverlap: Math.round(sz * 0.18) });
                }}
              />
              <small>Applies to newly uploaded or reprocessed documents</small>
            </div>

            <div className="stat-box">
              <span>Retrieved Chunks (Top-K): <b>{ragSettings.topK}</b></span>
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={ragSettings.topK}
                onChange={(e) => setRagSettings({ topK: Number(e.target.value) })}
              />
              <small>Number of document passages passed to synthesis</small>
            </div>

            <div className="stat-box">
              <span>Similarity Threshold: <b>{Math.round(ragSettings.similarityThreshold * 100)}%</b></span>
              <input
                type="range"
                min={0.05}
                max={0.45}
                step={0.02}
                value={ragSettings.similarityThreshold}
                onChange={(e) => setRagSettings({ similarityThreshold: Number(e.target.value) })}
              />
              <small>Higher values enforce stricter no-answer detection</small>
            </div>

            <div className="stat-box" style={{ justifyContent: "space-between" }}>
              <span>Local OCR &amp; Theme</span>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-0)" }}>
                  <input
                    type="checkbox"
                    checked={ragSettings.enableOcr}
                    onChange={(e) => setRagSettings({ enableOcr: e.target.checked })}
                  />
                  OCR for images &amp; scanned PDFs
                </label>
                <button
                  className="btn-secondary"
                  style={{ padding: "4px 9px", fontSize: 11.5 }}
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                >
                  Theme: {theme === "dark" ? "Dark" : "Light"}
                </button>
              </div>
              <small>Uses local Tesseract.js OCR engine</small>
            </div>
          </div>

          {/* 3. Local Storage Breakdown */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="modal-section-title">3. Local Storage Breakdown (§4.8)</div>
            {info && info.perDocumentSizes.length > 0 && (
              <button className="link-btn" onClick={() => setShowPerDoc((s) => !s)}>
                {showPerDoc ? "Hide individual document sizes ▲" : `View individual document sizes (${info.perDocumentSizes.length}) ▼`}
              </button>
            )}
          </div>
          <div className="stats-grid">
            <div className="stat-box">
              <span>Total Browser Usage</span>
              <b>{info ? formatBytes(info.totalBytes) : "…"}</b>
              <small>{info?.quotaBytes ? `of ${formatBytes(info.quotaBytes)} quota` : "Origin storage"}</small>
            </div>
            <div className="stat-box">
              <span>Uploaded Documents</span>
              <b>{info?.documentsCount ?? 0}</b>
              <small>{info ? formatBytes(info.documentsBytes) : "0 B"} raw size</small>
            </div>
            <div className="stat-box">
              <span>Model &amp; Vector Cache</span>
              <b>{info ? formatBytes(info.modelCacheBytes) : "…"}</b>
              <small>{info?.vectorsCount ?? 0} vectors (384-D)</small>
            </div>
            <div className="stat-box">
              <span>Persistent Storage</span>
              <b>{info?.persisted ? "Active" : "Standard"}</b>
              <small>
                <button className="link-btn" onClick={requestPersistence}>Request persistence</button>
              </small>
            </div>
          </div>

          {showPerDoc && info && info.perDocumentSizes.length > 0 && (
            <div className="citation-scroll" style={{ maxHeight: 150, padding: 8 }}>
              {info.perDocumentSizes.map((d) => (
                <div
                  key={d.document_id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                    padding: "5px 8px",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span style={{ color: "var(--text-0)", fontWeight: 500 }}>{d.filename}</span>
                  <span className="mono" style={{ color: "var(--text-1)" }}>
                    {formatBytes(d.size)} · {d.status.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 4. Backup, Optional AES Encryption & Wipe (§4.8 & §7) */}
          <div className="modal-section-title">4. Backup, Optional Encryption &amp; Data Ownership</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="password"
              className="input-field"
              placeholder="Optional passphrase for AES-256 backup encryption…"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              style={{ flex: 1, minWidth: 230 }}
            />
            <button className="btn-neon" onClick={onExport}>
              {passphrase.trim() ? "Export Encrypted Backup" : "Export Backup (.json)"}
            </button>
            <button className="btn-ghost" onClick={() => importRef.current?.click()}>
              Import Backup
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                onImport(e.target.files);
                e.target.value = "";
              }}
            />
            {!confirmClearChats ? (
              <button className="btn-secondary" onClick={() => setConfirmClearChats(true)}>
                Delete Chat History ({info?.conversationsCount ?? 0})
              </button>
            ) : (
              <button className="btn-danger" onClick={onClearChats}>
                Confirm Delete Chats
              </button>
            )}
            {!confirmWipe ? (
              <button className="btn-danger" onClick={() => setConfirmWipe(true)}>
                Clear All Data
              </button>
            ) : (
              <button className="btn-danger" onClick={onWipe}>
                Confirm Permanent Wipe
              </button>
            )}
          </div>

          {/* 5. Privacy Architecture, PWA Guidance & Shared Device Notice (§7 & §9) */}
          <div className="stat-box" style={{ background: "rgba(56, 189, 248, 0.05)", borderColor: "var(--border-strong)" }}>
            <span style={{ color: "var(--text-0)", fontWeight: 600 }}>
              Privacy &amp; Data Ownership Notice (§4.8 &amp; §7)
            </span>
            <small style={{ lineHeight: 1.5, color: "var(--text-1)" }}>
              • <b>100% Local Execution:</b> Documents, embeddings, chat history, and AI weights never leave your browser.
              <br />
              • <b>Backup Warning:</b> Clearing browser site data, uninstalling the PWA, or losing your device will erase your local knowledge base unless you export a backup above.
              <br />
              • <b>Shared Devices:</b> Isolation is enforced per browser profile/origin. On shared computers, use separate OS/browser profiles or clear data when finished.
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}
