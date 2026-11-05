"use client";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, ensureDefaultSpaces, uid, type ConversationRecord, type DocumentRecord, type MessageRecord } from "@/lib/db";
import {
  assignDocToSpace,
  deleteDocument,
  ingestFile,
  isBroadOverviewQuery,
  renameDocument,
  reprocessDocument,
  resumeInterruptedDocuments,
  retrieve,
  TEXT_EXT,
  topTerms,
} from "@/lib/rag";
import { detectHardwareAndSelectModel, ensureLlmEngine, generateGroundedAnswer, hasWebGPU } from "@/lib/ai";
import {
  speakAnswer,
  startVoiceInput,
  stopSpeaking,
  KOKORO_VOICES,
  PIPER_VOICES,
  type VoiceRecorderSession,
} from "@/lib/voice";
import { formatBytes } from "@/lib/backup";
import { useApp, type AvatarCategory, type ChatbotConfig, type VoiceEngineMode } from "@/lib/store";
import { AvatarGlyph, SendGlyph, UserGlyph } from "./Icons";
import KnowledgeBasePanel from "./KnowledgeBasePanel";
import VectorDatabasePanel from "./VectorDatabasePanel";
import CitationModal from "./CitationModal";
import DocumentLibraryModal from "./DocumentLibraryModal";
import OnboardingModal from "./OnboardingModal";
import StorageSettingsModal from "./StorageSettingsModal";

function splitMessage(content: string) {
  const i = content.indexOf("\n\n");
  return i < 0 ? [content, ""] : [content.slice(0, i), content.slice(i + 2)];
}

export interface ThinkingStep {
  id: string;
  label: string;
  detail?: string;
  status: "pending" | "active" | "done";
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Dashboard() {
  const {
    chatbot,
    setChatbot,
    ragSettings,
    setRagSettings,
    hardware,
    theme,
    setTheme,
    onboarded,
    activeTab,
    setActiveTab,
    conversationId,
    setConversation,
    activeSpaceId,
    setActiveSpace,
    selectedDocIds,
    toggleSelectedDoc,
    clearSelectedDocs,
    openModal,
    openCitation,
    embedStatus,
    embedProgress,
    llmStatus,
    llmProgress,
  } = useApp();

  const [mounted, setMounted] = useState(false);
  const [mobilePlatform, setMobilePlatform] = useState<"ios" | "android" | "desktop">("desktop");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [installPromptEvent, setInstallPromptEvent] = useState<any>(null);

  // Chat state
  const [prompt, setPrompt] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [docPickerOpen, setDocPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<ThinkingStep[]>([]);
  const [liveSources, setLiveSources] = useState<MessageRecord["sources"]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [streamText, setStreamText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [handsFreeVoice, setHandsFreeVoice] = useState(false);
  const [voiceConfigOpen, setVoiceConfigOpen] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [revealedTranscripts, setRevealedTranscripts] = useState<Record<string, boolean>>({});
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const voiceSessionRef = useRef<VoiceRecorderSession | null>(null);
  const interruptedSnippetRef = useRef<string | null>(null);
  const handsFreeRef = useRef(false);
  const regenCountRef = useRef(0);
  const chatFeedRef = useRef<HTMLDivElement>(null);

  // Document & Space state
  const [drag, setDrag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live IndexedDB queries
  const docs = useLiveQuery(() => db.documents.orderBy("uploaded_at").reverse().toArray(), []) ?? [];
  const chunksCount = useLiveQuery(() => db.chunks.count(), []) ?? 0;
  const vectorsCount = useLiveQuery(() => db.embeddings.count(), []) ?? 0;
  const spaces = useLiveQuery(() => db.spaces.orderBy("created_at").toArray(), []) ?? [];
  const spaceDocs = useLiveQuery(() => db.space_documents.toArray(), []) ?? [];
  const conversations = useLiveQuery<ConversationRecord[]>(
    () => db.conversations.orderBy("created_at").reverse().toArray(),
    []
  ) ?? [];
  const allMessages = useLiveQuery<MessageRecord[]>(
    async () => (chatSearch.trim() ? db.messages.toArray() : []),
    [Boolean(chatSearch.trim())]
  ) ?? [];
  const messages = useLiveQuery<MessageRecord[]>(
    async () => (conversationId ? db.messages.where("conversation_id").equals(conversationId).sortBy("created_at") : []),
    [conversationId]
  ) ?? [];
  const previewChunks = useLiveQuery(
    async () => (previewDoc ? db.chunks.where("document_id").equals(previewDoc.document_id).sortBy("index") : []),
    [previewDoc?.document_id]
  ) ?? [];

  useEffect(() => {
    setMounted(true);

    // Detect OS platform for native iOS (Cupertino) vs Android (Material You) look & feel
    const detectOs = () => {
      const ua = navigator.userAgent || "";
      const isIOS =
        /iPhone|iPad|iPod/i.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const isAndroid = /Android/i.test(ua);
      if (isIOS) setMobilePlatform("ios");
      else if (isAndroid) setMobilePlatform("android");
      else if (window.innerWidth <= 960) setMobilePlatform("ios");
      else setMobilePlatform("desktop");
    };
    detectOs();
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(detectOs, 150);
    };
    window.addEventListener("resize", onResize, { passive: true });

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvent(e);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    ensureDefaultSpaces().catch(() => {});
    resumeInterruptedDocuments().catch(() => {});
    detectHardwareAndSelectModel(true).catch(() => {});

    // Auto-open onboarding wizard on first visit (§4.1)
    if (!useApp.getState().onboarded) {
      useApp.getState().openModal("onboarding");
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          // Check if there is already a waiting service worker
          if (reg.waiting) {
            waitingWorkerRef.current = reg.waiting;
            setUpdateAvailable(true);
          }

          // Check if a worker is currently installing
          if (reg.installing) {
            reg.installing.addEventListener("statechange", (e: any) => {
              if (e.target.state === "installed" && navigator.serviceWorker.controller) {
                waitingWorkerRef.current = reg.waiting || reg.installing;
                setUpdateAvailable(true);
              }
            });
          }

          // Listen for newly installed updates
          reg.addEventListener("updatefound", () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener("statechange", () => {
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                waitingWorkerRef.current = newWorker;
                setUpdateAvailable(true);
              }
            });
          });

          // Check for new updates immediately, then poll every 60 seconds
          reg.update().catch(() => {});
          const updateInterval = setInterval(() => {
            reg.update().catch(() => {});
          }, 60 * 1000);

          // Also check when user focuses or returns to the window
          const onVisibility = () => {
            if (document.visibilityState === "visible") {
              reg.update().catch(() => {});
            }
          };
          document.addEventListener("visibilitychange", onVisibility);
          window.addEventListener("focus", onVisibility);

          return () => {
            clearInterval(updateInterval);
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("focus", onVisibility);
          };
        })
        .catch(() => {});

      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    }

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      if (resizeTimer) clearTimeout(resizeTimer);
      stopSpeaking();
      voiceSessionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    handsFreeRef.current = handsFreeVoice;
    if (!handsFreeVoice) {
      stopSpeaking();
      setSpeakingId(null);
    }
  }, [handsFreeVoice]);

  useEffect(() => {
    if (activeTab !== "chat") {
      stopSpeaking();
      setSpeakingId(null);
    }
  }, [activeTab]);

  useEffect(() => {
    topTerms(8, activeSpaceId).then(setTerms);
  }, [docs.length, chunksCount, activeSpaceId]);

  useEffect(() => {
    chatFeedRef.current?.scrollTo({ top: 1e6, behavior: "smooth" });
  }, [messages.length, streamText, thinkingSteps, activeTab]);

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => clearInterval(id);
  }, [busy]);

  const botName = mounted ? chatbot.name : "Cognitive AI";
  const botAvatar: AvatarCategory = mounted ? chatbot.avatar : "chat";
  const botCustomUrl = mounted ? chatbot.customAvatarUrl : undefined;
  const currentTab = mounted ? activeTab : "overview";
  const currentTheme = mounted ? theme : "dark";

  const docSpaceMap = new Map<string, string>();
  for (const sd of spaceDocs) docSpaceMap.set(sd.document_id, sd.space_id);

  const scopedDocs = activeSpaceId
    ? docs.filter((d) => docSpaceMap.get(d.document_id) === activeSpaceId)
    : docs;

  const filteredDocs = scopedDocs.filter((d) =>
    search.trim() ? d.filename.toLowerCase().includes(search.trim().toLowerCase()) : true
  );

  // Filter conversations by title OR message content (§11 Phase 6)
  const filteredConversations = conversations.filter((c) => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return true;
    if (c.title.toLowerCase().includes(q)) return true;
    return allMessages.some(
      (m) => m.conversation_id === c.conversation_id && m.content.toLowerCase().includes(q)
    );
  });

  const totalBytes = docs.reduce((s, d) => s + (d.size || 0), 0);
  const activeSpaceName = activeSpaceId ? spaces.find((s) => s.space_id === activeSpaceId)?.name : null;

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length) return;
    for (const f of Array.from(files)) {
      try {
        await ingestFile(f, activeSpaceId);
        flash(`Indexed ${f.name}`);
      } catch (e) {
        flash((e as Error).message);
      }
    }
  }

  async function runQuestion(
    q: string,
    existingCid?: string | null,
    regenOpts?: { variation: number; previousResponse: string; fromVoice?: boolean }
  ) {
    setBusy(true);
    setStreamText("");
    setLiveSources([]);

    const variation = regenOpts?.variation ?? 0;
    const fromVoice = Boolean(regenOpts?.fromVoice);
    const isOverview = isBroadOverviewQuery(q);
    const scopeDesc =
      selectedDocIds.length > 0
        ? `${selectedDocIds.length} selected document(s)`
        : activeSpaceName
        ? `Knowledge Space #${activeSpaceName}`
        : `${docs.length || 0} indexed document(s)`;

    const initialSteps: ThinkingStep[] = [
      {
        id: "intent",
        label:
          variation > 0
            ? `Regenerating response (Variant #${variation}) · Exploring alternative angle`
            : isOverview
            ? "Analyzing request · Full-document synthesis mode"
            : "Analyzing question & embedding query vector (384-D)",
        detail: `Scope: ${scopeDesc}`,
        status: "active",
      },
      {
        id: "search",
        label: isOverview
          ? "Sampling representative sections across document span"
          : "Searching local vector database & hybrid keyword index",
        status: "pending",
      },
      {
        id: "rank",
        label: "Cross-referencing & ranking matched passages",
        status: "pending",
      },
      {
        id: "synth",
        label: `Synthesizing grounded response in ${chatbot.personality} (${chatbot.response_style}) style`,
        status: "pending",
      },
    ];
    setThinkingSteps(initialSteps);

    let cid = existingCid ?? conversationId;
    if (!cid) {
      cid = uid("conv");
      await db.conversations.add({
        conversation_id: cid,
        title: q.slice(0, 60),
        created_at: new Date().toISOString(),
      });
      setConversation(cid);
    }

    // Stage 1: Query analysis & vectorization
    await pause(480);
    setThinkingSteps((prev) =>
      prev.map((s) =>
        s.id === "intent" ? { ...s, status: "done" } : s.id === "search" ? { ...s, status: "active" } : s
      )
    );

    // Stage 2: Vector search & section sampling (passes variant on regeneration to sample fresh intermediate sections)
    const sources = await retrieve(q, undefined, undefined, { variant: variation });
    await pause(560);
    const uniqueFiles = [...new Set(sources.map((s) => s.filename))];
    setThinkingSteps((prev) =>
      prev.map((s) =>
        s.id === "search"
          ? {
              ...s,
              status: "done",
              detail: sources.length
                ? `Scanned ${vectorsCount} vectors · Matched ${sources.length} passage(s) in ${uniqueFiles.join(", ")}`
                : "No matching passages above similarity threshold",
            }
          : s.id === "rank"
          ? { ...s, status: "active" }
          : s
      )
    );

    // Stage 3: Ranking & passage extraction preview
    setLiveSources(sources);
    await pause(520);
    setThinkingSteps((prev) =>
      prev.map((s) =>
        s.id === "rank"
          ? {
              ...s,
              status: "done",
              detail: sources.length
                ? sources
                    .map((src, i) => `[${i + 1}] ${src.section ?? (src.page ? `Page ${src.page}` : `Chunk ${src.chunk_index + 1}`)}`)
                    .join(" · ")
                : undefined,
            }
          : s.id === "synth"
          ? { ...s, status: "active" }
          : s
      )
    );

    // Stage 4: Synthesis & streaming generation (with multi-turn recent conversation history + regeneration diversity)
    const priorMsgs = cid
      ? (await db.messages.where("conversation_id").equals(cid).sortBy("created_at"))
          .slice(0, -1)
          .slice(-4)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    const interruptedSnippet = interruptedSnippetRef.current;
    interruptedSnippetRef.current = null;

    const content = await generateGroundedAnswer(
      q,
      sources,
      chatbot,
      (partial) => {
        // When replying as a spoken audio bubble, don't flash a wall of streaming text
        if (!fromVoice || useApp.getState().ragSettings.voiceResponseMode === "spoken_and_text") {
          setStreamText(partial);
        }
      },
      priorMsgs,
      { ...regenOpts, interruptedSnippet: interruptedSnippet || undefined }
    );
    setStreamText("");
    setThinkingSteps([]);
    setLiveSources([]);

    const newMsgId = uid("msg");
    await db.messages.add({
      message_id: newMsgId,
      conversation_id: cid,
      role: "assistant",
      content,
      sources,
      voiceMode: fromVoice,
      created_at: new Date().toISOString(),
    });
    setBusy(false);

    // Automatically talk back whenever the user asked via the microphone OR when Hands-Free mode is active!
    if (fromVoice || handsFreeRef.current) {
      setSpeakingId(newMsgId);
      speakAnswer(content, chatbot, {
        onStatus: (st) => setVoiceStatus(st || null),
        onStart: () => {
          setVoiceStatus(null);
          setSpeakingId(newMsgId);
        },
        onEnd: () => {
          setVoiceStatus(null);
          setSpeakingId(null);
          if (handsFreeRef.current) {
            setTimeout(() => {
              if (handsFreeRef.current && !voiceSessionRef.current) {
                toggleVoiceInput(true);
              }
            }, 350);
          }
        },
      });
    }
  }

  function applyAppUpdate() {
    if (waitingWorkerRef.current) {
      waitingWorkerRef.current.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  }

  async function toggleVoiceInput(forceAutoSend?: boolean) {
    if (listening && voiceSessionRef.current) {
      voiceSessionRef.current.stop();
      voiceSessionRef.current = null;
      setListening(false);
      return;
    }

    if (speakingId) {
      const cutText = stopSpeaking();
      if (cutText && cutText.length > 10) {
        interruptedSnippetRef.current = cutText;
      }
    } else {
      stopSpeaking();
    }
    setSpeakingId(null);
    setListening(true);
    setVoiceStatus("Requesting microphone access…");

    try {
      const session = await startVoiceInput({
        language: chatbot.language,
        onStatus: (st) => setVoiceStatus(st),
        onInterim: (interimText) => {
          setPrompt(interimText);
        },
        onFinal: (finalText) => {
          voiceSessionRef.current = null;
          setListening(false);
          setVoiceStatus(null);
          if (finalText.trim()) {
            setPrompt(finalText.trim());
            const shouldAutoSend =
              forceAutoSend !== undefined
                ? forceAutoSend
                : Boolean(useApp.getState().ragSettings.autoSendVoice ?? true) || handsFreeRef.current;
            if (shouldAutoSend) {
              sendQuestion(finalText.trim(), true);
            }
          }
        },
        onError: (errMsg) => {
          voiceSessionRef.current = null;
          setListening(false);
          setVoiceStatus(null);
          flash(errMsg);
        },
      });
      voiceSessionRef.current = session;
    } catch (e) {
      voiceSessionRef.current = null;
      setListening(false);
      setVoiceStatus(null);
      flash((e as Error).message || "Could not start microphone");
    }
  }

  function cancelVoiceInput() {
    if (voiceSessionRef.current) {
      voiceSessionRef.current.cancel();
      voiceSessionRef.current = null;
    }
    setListening(false);
    setVoiceStatus(null);
  }

  function toggleSpeakMessage(msg: MessageRecord) {
    if (speakingId === msg.message_id) {
      stopSpeaking();
      setVoiceStatus(null);
      setSpeakingId(null);
      return;
    }
    setSpeakingId(msg.message_id);
    speakAnswer(msg.content, chatbot, {
      onStatus: (st) => setVoiceStatus(st || null),
      onStart: () => {
        setVoiceStatus(null);
        setSpeakingId(msg.message_id);
      },
      onEnd: () => {
        setVoiceStatus(null);
        setSpeakingId(null);
      },
    });
  }

  async function sendQuestion(overridePrompt?: string, fromVoice = false) {
    const q = (overridePrompt ?? prompt).trim();
    if (!q || busy) return;
    setPrompt("");
    if (currentTab !== "chat") setActiveTab("chat");

    let cid = conversationId;
    if (!cid) {
      cid = uid("conv");
      await db.conversations.add({
        conversation_id: cid,
        title: q.slice(0, 60),
        created_at: new Date().toISOString(),
      });
      setConversation(cid);
    }
    await db.messages.add({
      message_id: uid("msg"),
      conversation_id: cid,
      role: "user",
      content: q,
      voiceMode: fromVoice,
      created_at: new Date().toISOString(),
    });
    await runQuestion(q, cid, { variation: 0, previousResponse: "", fromVoice });
  }

  async function regenerate(assistantMsg: MessageRecord) {
    if (busy) return;
    const idx = messages.findIndex((m) => m.message_id === assistantMsg.message_id);
    if (idx <= 0) return;
    const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    if (!prevUser) return;
    regenCountRef.current += 1;
    const prevContent = assistantMsg.content;
    const wasVoice = Boolean(assistantMsg.voiceMode || prevUser.voiceMode);
    await db.messages.delete(assistantMsg.message_id);
    await runQuestion(prevUser.content, assistantMsg.conversation_id, {
      variation: regenCountRef.current,
      previousResponse: prevContent,
      fromVoice: wasVoice,
    });
  }

  function exportCurrentConversation() {
    if (!messages.length) return;
    const md = messages
      .map((m) => {
        const who = m.role === "user" ? "You" : botName;
        const cites =
          m.sources && m.sources.length
            ? "\n\nSources:\n" +
              m.sources
                .map((s, i) => `- [${i + 1}] ${s.filename} (${s.section ?? (s.page ? `Page ${s.page}` : `Chunk ${s.chunk_index + 1}`)})`)
                .join("\n")
            : "";
        return `### ${who}\n\n${m.content}${cites}`;
      })
      .join("\n\n---\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conversation-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

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

  async function deleteSpace(spaceId: string) {
    await db.transaction("rw", [db.spaces, db.space_documents], async () => {
      await db.space_documents.where("space_id").equals(spaceId).delete();
      await db.spaces.delete(spaceId);
    });
    if (activeSpaceId === spaceId) setActiveSpace(null);
  }

  return (
    <div
      className={`app-shell os-${mobilePlatform} ${currentTheme === "light" ? "theme-light" : ""} ${desktopSidebarCollapsed ? "sidebar-collapsed" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        handleUpload(e.dataTransfer.files);
      }}
    >
      {/* Hidden global file picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={TEXT_EXT.map((e) => "." + e).join(",")}
        onChange={(e) => {
          handleUpload(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Mobile Drawer Backdrop */}
      {mobileDrawerOpen && (
        <div className="mobile-drawer-backdrop" onClick={() => setMobileDrawerOpen(false)} />
      )}

      {/* Left Sidebar Navigation / Mobile Slide-Over Drawer (§5.2 of Product Concept Document) */}
      <aside className={`sidebar ${mobileDrawerOpen ? "open" : ""} ${desktopSidebarCollapsed ? "collapsed" : ""}`}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <div
            className="brand-row"
            style={{ flex: 1, minWidth: 0 }}
            onClick={() => {
              setMobileDrawerOpen(false);
              openModal("onboarding");
            }}
            title="Customize assistant identity"
          >
            <div className="brand-avatar" style={{ overflow: "hidden" }}>
              <AvatarGlyph avatar={botAvatar} customUrl={botCustomUrl} forHeader />
            </div>
            <div className="brand-meta">
              <div className="brand-name">{botName}</div>
              <div className="brand-tag">
                <span className="status-dot" />
                <span>Local Private AI</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-collapse-toggle hide-on-mobile"
            onClick={() => setDesktopSidebarCollapsed((prev) => !prev)}
            title={desktopSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {desktopSidebarCollapsed ? "⇥" : "⇤"}
          </button>
        </div>

        <nav className="nav-group">
          <div className="nav-label">Workspace</div>
          <button
            className={`nav-btn ${currentTab === "overview" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("overview");
              setMobileDrawerOpen(false);
            }}
          >
            <div className="nav-btn-left">
              <span>Dashboard</span>
            </div>
          </button>
          <button
            className={`nav-btn ${currentTab === "chat" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("chat");
              setMobileDrawerOpen(false);
            }}
          >
            <div className="nav-btn-left">
              <span>AI Chat</span>
            </div>
            {conversations.length > 0 && <span className="nav-badge">{conversations.length}</span>}
          </button>
          <button
            className={`nav-btn ${currentTab === "documents" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("documents");
              setMobileDrawerOpen(false);
            }}
          >
            <div className="nav-btn-left">
              <span>My Documents</span>
            </div>
            <span className="nav-badge">{docs.length}</span>
          </button>
        </nav>

        <nav className="nav-group">
          <div className="nav-label">Knowledge Spaces</div>
          <button
            className={`nav-btn ${!activeSpaceId ? "active" : ""}`}
            onClick={() => {
              setActiveSpace(null);
              setMobileDrawerOpen(false);
            }}
          >
            <div className="nav-btn-left">
              <span>All Documents</span>
            </div>
            <span className="nav-badge">{docs.length}</span>
          </button>
          {spaces.map((sp) => {
            const count = spaceDocs.filter((sd) => sd.space_id === sp.space_id).length;
            const isDefault = ["space_business", "space_education", "space_research", "space_personal"].includes(
              sp.space_id
            );
            return (
              <div key={sp.space_id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  style={{ flex: 1 }}
                  className={`nav-btn ${activeSpaceId === sp.space_id ? "active" : ""}`}
                  onClick={() => {
                    setActiveSpace(sp.space_id);
                    setMobileDrawerOpen(false);
                  }}
                >
                  <div className="nav-btn-left">
                    <span># {sp.name}</span>
                  </div>
                  <span className="nav-badge">{count}</span>
                </button>
                {!isDefault && (
                  <button
                    className="link-btn"
                    style={{ fontSize: 13, padding: "4px 6px", color: "var(--text-2)" }}
                    title={`Delete space #${sp.name} (keeps documents)`}
                    onClick={() => deleteSpace(sp.space_id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
          <div className="space-new" style={{ padding: "4px 4px 0" }}>
            <input
              placeholder="New space…"
              value={newSpaceName}
              onChange={(e) => setNewSpaceName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSpace()}
            />
            <button onClick={addSpace} title="Create Knowledge Space">+</button>
          </div>
        </nav>

        <nav className="nav-group">
          <div className="nav-label">Settings</div>
          <button className="nav-btn" onClick={() => openModal("onboarding")}>
            <div className="nav-btn-left">
              <span>Personalization</span>
            </div>
          </button>
          <button className="nav-btn" onClick={() => openModal("settings")}>
            <div className="nav-btn-left">
              <span>AI Models &amp; Storage</span>
            </div>
          </button>
          <button
            className="nav-btn"
            onClick={() => setTheme(currentTheme === "dark" ? "light" : "dark")}
          >
            <div className="nav-btn-left">
              <span>Theme: {currentTheme === "dark" ? "Dark" : "Light"}</span>
            </div>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="privacy-pill">
            <span className="status-dot" />
            <span>100% On-Device · Offline Ready</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-area">
        {/* Top Header Bar */}
        <header className="topbar">
          <div className="topbar-title">
            {desktopSidebarCollapsed && (
              <button
                type="button"
                className="desktop-sidebar-expand-btn hide-on-mobile"
                onClick={() => setDesktopSidebarCollapsed(false)}
                title="Expand sidebar"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
            )}
            <button
              className="mobile-menu-btn"
              onClick={() => setMobileDrawerOpen(true)}
              aria-label="Open menu and Knowledge Spaces"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <h1>
              {currentTab === "overview" && "Workspace"}
              {currentTab === "chat" && botName}
              {currentTab === "documents" && "Documents"}
            </h1>
            <div style={{ position: "relative" }}>
              <button
                className="scope-pill"
                onClick={() => setDocPickerOpen((o) => !o)}
                title="Click to choose specific documents or Knowledge Spaces for chat retrieval"
              >
                <span className="hide-on-xs">Scope:</span>
                <b>
                  {selectedDocIds.length > 0
                    ? `${selectedDocIds.length} Doc(s)`
                    : activeSpaceName
                    ? activeSpaceName
                    : "All Docs"}
                </b>
                <span style={{ fontSize: 10, opacity: 0.7 }}>▼</span>
              </button>

              {docPickerOpen && (
                <div className="scope-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="scope-dropdown-head">
                    <span>Filter Chat to Specific Documents</span>
                    {(selectedDocIds.length > 0 || activeSpaceId) && (
                      <button
                        className="link-btn"
                        onClick={() => {
                          clearSelectedDocs();
                          setActiveSpace(null);
                        }}
                      >
                        Reset to All
                      </button>
                    )}
                  </div>
                  <div className="scope-dropdown-list">
                    {docs.length === 0 ? (
                      <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-2)" }}>
                        No documents uploaded yet.
                      </div>
                    ) : (
                      docs.map((d) => {
                        const checked = selectedDocIds.includes(d.document_id);
                        return (
                          <label key={d.document_id} className={`scope-doc-item ${checked ? "active" : ""}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSelectedDoc(d.document_id)}
                            />
                            <span className="scope-doc-name">{d.filename}</span>
                            <small>{formatBytes(d.size)}</small>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="topbar-actions">
            {installPromptEvent && (
              <button
                className="btn-primary install-top-btn"
                onClick={async () => {
                  try {
                    await installPromptEvent.prompt();
                    setInstallPromptEvent(null);
                  } catch {}
                }}
                title="Install app to your device for offline and home screen access"
              >
                <span>⬇ Install</span>
                <span className="hide-on-xs"> App</span>
              </button>
            )}
            {updateAvailable && (
              <div className="pwa-update-pill">
                <span className="pwa-update-dot" />
                <span className="pwa-update-text">Update</span>
                <button className="pwa-update-btn" onClick={applyAppUpdate} title="Reload to update">
                  Now
                </button>
                <button
                  className="pwa-update-dismiss"
                  onClick={() => setUpdateAvailable(false)}
                  title="Dismiss notification"
                >
                  ✕
                </button>
              </div>
            )}
            {toast && <span className="inline-toast">{toast}</span>}
            {currentTab === "chat" && (
              <button
                className="btn-secondary mobile-only-btn"
                onClick={() => setMobileHistoryOpen((o) => !o)}
                title="Toggle chat history"
              >
                History ({conversations.length})
              </button>
            )}
            <select
              className="select-field hide-on-mobile"
              value={mounted ? chatbot.personality : "friendly"}
              onChange={(e) => setChatbot({ personality: e.target.value as ChatbotConfig["personality"] })}
              title="Assistant personality"
            >
              <option value="friendly">Tone: Friendly</option>
              <option value="professional">Tone: Professional</option>
              <option value="concise">Tone: Concise</option>
              <option value="academic">Tone: Academic</option>
            </select>
            <select
              className="select-field hide-on-mobile"
              value={mounted ? chatbot.response_style : "detailed"}
              onChange={(e) => setChatbot({ response_style: e.target.value as ChatbotConfig["response_style"] })}
              title="Response style"
            >
              <option value="detailed">Style: Detailed</option>
              <option value="simple">Style: Simple</option>
              <option value="bullets">Style: Bullet points</option>
              <option value="steps">Style: Step-by-step</option>
              <option value="technical">Style: Technical</option>
              <option value="executive">Style: Executive summary</option>
            </select>
            <button className="btn-primary upload-top-btn" onClick={() => fileInputRef.current?.click()}>
              <span>+ Upload</span>
              <span className="hide-on-xs"> Documents</span>
            </button>
          </div>
        </header>

        {/* TAB 1: Overview / Command Center */}
        {currentTab === "overview" && (
          <div className="view-scroll">
            <div className="overview-grid">
              <div className="hero-banner">
                <div>
                  <h2>Welcome to {botName}</h2>
                  <p>
                    Your private, local-first AI knowledge assistant. Upload PDFs (including scanned PDFs via local OCR), Word files, Excel spreadsheets, PowerPoint decks, RTF, images, CSVs, or Markdown notes — everything is indexed and answered directly inside your browser.
                  </p>
                  <div className="prompt-suggestions">
                    {[
                      "Summarize the key findings across my documents",
                      "Extract main entities, dates, and action items",
                      "Compare metrics or figures mentioned in my files",
                    ].map((s) => (
                      <button key={s} className="prompt-chip" onClick={() => sendQuestion(s)}>
                        “{s}”
                      </button>
                    ))}
                  </div>
                </div>
                <div className="hero-actions">
                  <button className="btn-primary" onClick={() => setActiveTab("chat")}>
                    Start a Conversation →
                  </button>
                  <button className="btn-secondary" onClick={() => openModal("onboarding")}>
                    Customize Assistant
                  </button>
                </div>
              </div>

              {/* KPI Metrics Row */}
              <div className="kpi-grid">
                <div className="kpi-card">
                  <span className="kpi-label">Indexed Documents</span>
                  <div className="kpi-val">{docs.filter((d) => d.status === "indexed").length}</div>
                  <span className="kpi-sub">
                    {docs.length} total · {spaces.length} Knowledge Spaces
                  </span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Vector Embeddings</span>
                  <div className="kpi-val">{vectorsCount}</div>
                  <span className="kpi-sub">
                    {embedProgress || (embedStatus === "ready" ? "384-D MiniLM-L6-v2" : "384-D Hybrid Index")}
                  </span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Local Storage Used</span>
                  <div className="kpi-val">{formatBytes(totalBytes)}</div>
                  <span className="kpi-sub">IndexedDB + OPFS Origin Vault</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Generation Engine</span>
                  <div className="kpi-val" style={{ fontSize: 16, paddingTop: 5 }}>
                    {!mounted
                      ? "Auto-Detecting…"
                      : llmStatus === "ready"
                      ? llmProgress || "WebLLM Active"
                      : llmStatus === "downloading"
                      ? llmProgress || "Downloading Model…"
                      : "Grounded Synthesis"}
                  </div>
                  <span className="kpi-sub">
                    {!mounted ? (
                      "Checking device GPU & RAM…"
                    ) : hardware ? (
                      hardware.tierLabel
                    ) : llmStatus === "ready" ? (
                      "Streaming local SLM active"
                    ) : hasWebGPU() ? (
                      <button className="link-btn" onClick={() => ensureLlmEngine()}>
                        {llmStatus === "downloading" ? llmProgress || "Loading…" : "Load Local WebLLM →"}
                      </button>
                    ) : (
                      "Deterministic citation mode"
                    )}
                  </span>
                </div>
              </div>

              {/* Bento Row 1: Responsive Knowledge Graph + Live 3D Vector Cloud */}
              <div className="bento-row">
                <div className="surface-card">
                  <div className="surface-head">
                    <h3>Knowledge Graph · Documents &amp; Extracted Topics</h3>
                    <span>Click any topic node to query</span>
                  </div>
                  <div className="surface-body" style={{ padding: "8px 12px" }}>
                    <KnowledgeBasePanel
                      onSelectTerm={(term) => sendQuestion(`What do my documents say about ${term}?`)}
                    />
                  </div>
                </div>

                <div className="surface-card">
                  <div className="surface-head">
                    <h3>3D Vector Embedding Space</h3>
                    <span>Real-time 384-D projection</span>
                  </div>
                  <div className="surface-body" style={{ padding: 0 }}>
                    <VectorDatabasePanel />
                  </div>
                </div>
              </div>

              {/* Bento Row 2: Document Ingestion Pipeline + Recent Conversations */}
              <div className="bento-row">
                <div className="surface-card">
                  <div className="surface-head">
                    <h3>Document Ingestion Pipeline</h3>
                    <button className="link-btn" onClick={() => setActiveTab("documents")}>
                      Manage all ({docs.length}) →
                    </button>
                  </div>
                  <div className="surface-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div
                      className={`drop-card ${drag ? "dragging" : ""}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <h4>Drop files here or click to browse</h4>
                      <p>Supports PDF, DOCX, XLSX, PPTX, RTF, PNG/JPG (OCR), CSV, Markdown, TXT, JSON &amp; HTML</p>
                    </div>

                    {scopedDocs.length === 0 ? (
                      <div className="empty-state" style={{ padding: 20 }}>
                        No documents uploaded yet. Drop a file above to build your local vector index.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {scopedDocs.slice(0, 4).map((d) => (
                          <div
                            key={d.document_id}
                            className="doc-row"
                            style={{ gridTemplateColumns: "1fr auto auto" }}
                          >
                            <div>
                              <div
                                className="doc-title"
                                onClick={() => {
                                  setPreviewDoc(d);
                                  setActiveTab("documents");
                                }}
                              >
                                {d.filename}
                              </div>
                              <div className="doc-meta">
                                {formatBytes(d.size)} · {d.status.toUpperCase()} · {Math.round(d.progress * 100)}%
                              </div>
                            </div>
                            <div style={{ width: 90, height: 6, background: "var(--bg-0)", borderRadius: 99, overflow: "hidden" }}>
                              <div
                                style={{
                                  width: `${d.progress * 100}%`,
                                  height: "100%",
                                  background: d.status === "error" ? "var(--rose)" : "var(--accent)",
                                }}
                              />
                            </div>
                            <button
                              className="btn-secondary"
                              style={{ padding: "4px 9px", fontSize: 11.5 }}
                              onClick={() => {
                                setPreviewDoc(d);
                                setActiveTab("documents");
                              }}
                            >
                              Inspect
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="surface-card">
                  <div className="surface-head">
                    <h3>Recent Conversations</h3>
                    <button
                      className="link-btn"
                      onClick={() => {
                        setConversation(null);
                        setActiveTab("chat");
                      }}
                    >
                      + New Chat
                    </button>
                  </div>
                  <div className="surface-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {conversations.length === 0 ? (
                      <div className="empty-state" style={{ padding: 24 }}>
                        No conversations yet. Ask a question or click a prompt above to start chatting.
                      </div>
                    ) : (
                      conversations.slice(0, 5).map((c) => (
                        <button
                          key={c.conversation_id}
                          className="conv-item"
                          style={{ background: "var(--bg-2)", padding: "10px 12px" }}
                          onClick={() => {
                            setConversation(c.conversation_id);
                            setActiveTab("chat");
                          }}
                        >
                          <div style={{ fontWeight: 500, color: "var(--text-0)" }}>{c.title}</div>
                          <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                            {new Date(c.created_at).toLocaleString()}
                          </div>
                        </button>
                      ))
                    )}

                    {terms.length > 0 && (
                      <>
                        <div className="modal-section-title" style={{ marginTop: 8 }}>Top Indexed Keywords</div>
                        <div className="preset-chips">
                          {terms.map((t) => (
                            <button
                              key={t}
                              className="chip"
                              onClick={() => sendQuestion(`What do my documents say about ${t}?`)}
                            >
                              #{t}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: Full-Screen Grounded AI Chat */}
        {currentTab === "chat" && (
          <div className="chat-layout">
            {mobileHistoryOpen && (
              <div className="mobile-drawer-backdrop" onClick={() => setMobileHistoryOpen(false)} />
            )}
            <aside className={`chat-history-rail ${mobileHistoryOpen ? "open" : ""}`}>
              <button
                className="btn-primary"
                style={{ width: "100%", justifyContent: "center" }}
                onClick={() => {
                  setConversation(null);
                  setMobileHistoryOpen(false);
                }}
              >
                + New Conversation
              </button>
              <input
                className="input-field"
                placeholder="Search chat history…"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                style={{ fontSize: 12, padding: "6px 9px" }}
              />
              <div className="nav-label" style={{ paddingTop: 4 }}>History ({filteredConversations.length})</div>
              {filteredConversations.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-2)", padding: "4px 8px" }}>
                  {chatSearch ? "No matching chats." : "Your local chats will appear here."}
                </div>
              ) : (
                filteredConversations.map((c) => (
                  <button
                    key={c.conversation_id}
                    className={`conv-item ${conversationId === c.conversation_id ? "active" : ""}`}
                    onClick={() => {
                      setConversation(c.conversation_id);
                      setMobileHistoryOpen(false);
                    }}
                  >
                    {c.title}
                  </button>
                ))
              )}
              {conversationId && (
                <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  <button className="btn-secondary" onClick={exportCurrentConversation}>
                    Export Chat (.md)
                  </button>
                  <button
                    className="btn-danger-outline"
                    onClick={async () => {
                      await db.transaction("rw", db.conversations, db.messages, async () => {
                        await db.messages.where("conversation_id").equals(conversationId).delete();
                        await db.conversations.delete(conversationId);
                      });
                      setConversation(null);
                    }}
                  >
                    Delete Conversation
                  </button>
                </div>
              )}
            </aside>

            <div className="chat-stage">
              <div className="chat-feed" ref={chatFeedRef}>
                {messages.length === 0 ? (
                  <div className="empty-state" style={{ margin: "auto 0" }}>
                    <h3 style={{ color: "var(--text-0)", fontSize: 17, marginBottom: 6 }}>
                      Ask {botName} anything about your documents
                    </h3>
                    <p style={{ maxWidth: 500, margin: "0 auto 14px" }}>
                      Every answer is strictly grounded in your local knowledge base ({scopedDocs.length} document
                      {scopedDocs.length === 1 ? "" : "s"} in current scope) with clickable page, slide, or row citations.
                    </p>
                    <div className="prompt-suggestions" style={{ justifyContent: "center" }}>
                      {[
                        "Give me an executive summary of the uploaded files",
                        "What are the main conclusions or recommendations?",
                        "List key figures, dates, or tables mentioned",
                      ].map((s) => (
                        <button key={s} className="prompt-chip" onClick={() => sendQuestion(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((m) => {
                    if (m.role === "user") {
                      return (
                        <div key={m.message_id} className="chat-bubble-row user">
                          <div className="chat-avatar">
                            <UserGlyph />
                          </div>
                          <div className="chat-card">
                            {m.voiceMode && (
                              <div className="voice-user-badge">
                                <span>🎙️ Voice query</span>
                              </div>
                            )}
                            <p>{m.content}</p>
                          </div>
                        </div>
                      );
                    }
                    const [head, body] = splitMessage(m.content);
                    const isSpokenBubble =
                      Boolean(m.voiceMode) && (ragSettings.voiceResponseMode ?? "spoken_bubble") === "spoken_bubble";
                    const showTranscript = !isSpokenBubble || Boolean(revealedTranscripts[m.message_id]);
                    const isCurrentlySpeaking = speakingId === m.message_id;
                    const wordCount = m.content.trim().split(/\s+/).length;
                    const approxSeconds = Math.max(2, Math.round(wordCount / 2.6));

                    return (
                      <div key={m.message_id} className="chat-bubble-row">
                        <div className="chat-avatar ai" style={{ overflow: "hidden" }}>
                          <AvatarGlyph avatar={botAvatar} customUrl={botCustomUrl} />
                        </div>
                        <div className="chat-card">
                          {isSpokenBubble && (
                            <div className={`voice-audio-bubble ${isCurrentlySpeaking ? "speaking" : ""}`}>
                              <button
                                type="button"
                                className="voice-play-btn"
                                onClick={() => toggleSpeakMessage(m)}
                                title={isCurrentlySpeaking ? "Stop speaking" : "Play spoken response"}
                              >
                                {isCurrentlySpeaking ? "⏹" : "▶"}
                              </button>
                              <div className="voice-wave-wrap">
                                <div className="voice-wave-top">
                                  <span className="voice-wave-title">
                                    {isCurrentlySpeaking
                                      ? `${botName} is speaking…`
                                      : `Spoken Reply from ${botName}`}
                                  </span>
                                  <span className="voice-wave-meta">
                                    ~{approxSeconds}s ·{" "}
                                    {ragSettings.voiceEngine === "piper" || !ragSettings.voiceEngine
                                      ? "Piper Neural TTS"
                                      : ragSettings.voiceEngine === "kokoro"
                                      ? "Kokoro-82M"
                                      : ragSettings.voiceEngine === "voicebox"
                                      ? "Voicebox Studio"
                                      : "Local TTS"}
                                  </span>
                                </div>
                                <div className={`voice-wave-bars ${isCurrentlySpeaking ? "active" : ""}`}>
                                  {Array.from({ length: 28 }).map((_, idx) => (
                                    <span
                                      key={idx}
                                      style={{
                                        height: `${Math.max(22, ((idx * 37 + 13) % 85) + 15)}%`,
                                        animationDelay: `${(idx % 7) * 0.09}s`,
                                      }}
                                    />
                                  ))}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="voice-transcript-toggle"
                                onClick={() =>
                                  setRevealedTranscripts((prev) => ({
                                    ...prev,
                                    [m.message_id]: !prev[m.message_id],
                                  }))
                                }
                              >
                                {showTranscript ? "Hide text" : "Show text"}
                              </button>
                            </div>
                          )}

                          {showTranscript && (
                            <>
                              <h4>{head}</h4>
                              {body && <p>{body}</p>}
                            </>
                          )}
                          {m.sources && m.sources.length > 0 && (
                            <div className="citations-container">
                              <button
                                type="button"
                                className="citations-toggle-btn"
                                onClick={() =>
                                  setExpandedSources((prev) => ({
                                    ...prev,
                                    [m.message_id]: !prev[m.message_id],
                                  }))
                                }
                              >
                                <span>{expandedSources[m.message_id] ? "▾ Hide sources" : `▸ Sources (${m.sources.length})`}</span>
                              </button>
                              {expandedSources[m.message_id] && (
                                <div className="citation-pills">
                                  {m.sources.map((s, i) => {
                                    const loc = s.section ? s.section : s.page ? `Page ${s.page}` : `Chunk ${s.chunk_index + 1}`;
                                    return (
                                      <button
                                        key={i}
                                        className="citation-pill"
                                        onClick={() => openCitation(s)}
                                        title="Click to inspect full document context & highlighted passage"
                                      >
                                        <span>[{i + 1}]</span>
                                        <b>{s.filename}</b>
                                        <span>· {loc}</span>
                                        <span className="mono">({(s.score * 100).toFixed(0)}%)</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                          <div className="card-tools" style={{ marginTop: 10 }}>
                            <button
                              className={speakingId === m.message_id ? "active-voice-tool" : ""}
                              onClick={() => toggleSpeakMessage(m)}
                              title="Listen to this response aloud (Local TTS)"
                            >
                              {speakingId === m.message_id ? "⏹ Stop speaking" : "🔊 Replay voice"}
                            </button>
                            <button
                              onClick={() => {
                                navigator.clipboard?.writeText(m.content);
                                setCopiedId(m.message_id);
                                setTimeout(() => setCopiedId(null), 1500);
                              }}
                            >
                              {copiedId === m.message_id ? "Copied" : "Copy response"}
                            </button>
                            <button onClick={() => regenerate(m)}>Regenerate</button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}

                {busy && (
                  <div className="chat-bubble-row">
                    <div className="chat-avatar ai" style={{ overflow: "hidden" }}>
                      <AvatarGlyph avatar={botAvatar} customUrl={botCustomUrl} />
                    </div>
                    <div className="chat-card" style={{ width: "100%" }}>
                      <div className="thinking-box">
                        <div className="thinking-header">
                          <div className="thinking-title">
                            <span className="thinking-pulse" />
                            <b>{botName} is working on your request…</b>
                          </div>
                          <span className="thinking-timer">{(elapsedMs / 1000).toFixed(1)}s</span>
                        </div>

                        <div className="thinking-steps">
                          {thinkingSteps.map((st) => (
                            <div key={st.id} className={`thinking-step ${st.status}`}>
                              <span className="thinking-icon">
                                {st.status === "done" ? "✓" : st.status === "active" ? "◎" : "○"}
                              </span>
                              <div className="thinking-step-body">
                                <div className="thinking-step-label">{st.label}</div>
                                {st.detail && <div className="thinking-step-detail">{st.detail}</div>}
                              </div>
                            </div>
                          ))}
                        </div>

                        {liveSources && liveSources.length > 0 && (
                          <div className="thinking-sources">
                            {liveSources.map((s, i) => (
                              <span key={i} className="thinking-source-chip">
                                [{i + 1}] {s.filename} · {s.section ?? (s.page ? `Page ${s.page}` : `Chunk ${s.chunk_index + 1}`)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {streamText && (
                        <div style={{ marginTop: 12 }}>
                          <p>{streamText}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="chat-composer-bar">
                {/* Active Document Filter Bar + Hands-Free Voice Toggle directly above the chat input */}
                <div className="chat-scope-bar">
                  <div className="chat-scope-scroll">
                    {docs.length > 0 && (
                      <>
                        <span className="chat-scope-label">In:</span>
                        <button
                          className={`chip ${selectedDocIds.length === 0 ? "active" : ""}`}
                          onClick={clearSelectedDocs}
                        >
                          {activeSpaceName ? `#${activeSpaceName}` : `All (${docs.length})`}
                        </button>
                        {scopedDocs.map((d) => {
                          const active = selectedDocIds.includes(d.document_id);
                          return (
                            <button
                              key={d.document_id}
                              className={`chip ${active ? "active" : ""}`}
                              onClick={() => toggleSelectedDoc(d.document_id)}
                              title="Click to toggle searching only this document"
                            >
                              {active ? "✓ " : ""}{d.filename}
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                  <div className="chat-scope-actions">
                    <button
                      className={`chip voice-mode-chip ${handsFreeVoice ? "active" : ""}`}
                      onClick={() => {
                        const next = !handsFreeVoice;
                        setHandsFreeVoice(next);
                        if (next && !listening && !busy) {
                          toggleVoiceInput(true);
                        }
                      }}
                      title="Hands-free voice conversation: speak your question, hear the grounded answer aloud, and continue talking automatically"
                    >
                      {handsFreeVoice ? "🎙️ ON" : "🎙️ Hands-Free"}
                    </button>

                    <button
                      className={`chip ${voiceConfigOpen ? "active" : ""}`}
                      onClick={() => setVoiceConfigOpen((o) => !o)}
                      title="Configure voice synthesis engine, voice persona, speed, and pitch"
                    >
                      🔊 Voice ▾
                    </button>

                    {voiceConfigOpen && (
                      <div
                        className="scope-dropdown voice-settings-popover"
                        style={{ right: 0, left: "auto", bottom: "calc(100% + 8px)", top: "auto", width: 320, zIndex: 70 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="scope-dropdown-head">
                          <span>Voice Synthesis &amp; Mic Config</span>
                          <button className="link-btn" onClick={() => setVoiceConfigOpen(false)}>
                            Done
                          </button>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 6px 4px" }}>
                          <div>
                            <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>When I Use the Mic</div>
                            <select
                              className="select-field"
                              style={{ width: "100%" }}
                              value={mounted ? ragSettings.voiceResponseMode || "spoken_bubble" : "spoken_bubble"}
                              onChange={(e) =>
                                setRagSettings({
                                  voiceResponseMode: e.target.value as "spoken_bubble" | "spoken_and_text",
                                })
                              }
                            >
                              <option value="spoken_bubble">Talk Back (Spoken Audio Bubble Only)</option>
                              <option value="spoken_and_text">Talk Back + Show Full Text</option>
                            </select>
                          </div>

                          <div>
                            <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>Synthesis Engine</div>
                            <select
                              className="select-field"
                              style={{ width: "100%" }}
                              value={mounted ? ragSettings.voiceEngine || "piper" : "piper"}
                              onChange={(e) => setRagSettings({ voiceEngine: e.target.value as VoiceEngineMode })}
                            >
                              <option value="piper">Piper Neural TTS (OPFS · Fast &amp; Multilingual)</option>
                              <option value="auto">Smart Auto (Voicebox → Piper → Kokoro → OS)</option>
                              <option value="kokoro">Kokoro-82M Neural Studio Voice</option>
                              <option value="voicebox">Voicebox.sh Local Studio (127.0.0.1:17493)</option>
                              <option value="browser">OS System Voice (Instant · 0MB)</option>
                            </select>
                          </div>

                          {mounted &&
                            (ragSettings.voiceEngine === "piper" ||
                              ragSettings.voiceEngine === "auto" ||
                              !ragSettings.voiceEngine) && (
                              <div>
                                <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>
                                  Piper Neural Voice (Cached in OPFS)
                                </div>
                                <select
                                  className="select-field"
                                  style={{ width: "100%" }}
                                  value={ragSettings.piperVoiceId || "en_US-hfc_female-medium"}
                                  onChange={(e) => setRagSettings({ piperVoiceId: e.target.value })}
                                >
                                  {PIPER_VOICES.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      {v.label} ({v.language})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}

                          {mounted && ragSettings.voiceEngine === "kokoro" && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>Kokoro-82M Neural Voice</div>
                              <select
                                className="select-field"
                                style={{ width: "100%" }}
                                value={ragSettings.kokoroVoiceId || "af_heart"}
                                onChange={(e) => setRagSettings({ kokoroVoiceId: e.target.value })}
                              >
                                {KOKORO_VOICES.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.label} ({v.accent})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                                Speed: <b style={{ color: "var(--text-0)" }}>{(mounted ? ragSettings.voiceSpeed ?? 1 : 1).toFixed(2)}x</b>
                              </div>
                              <input
                                type="range"
                                min={0.7}
                                max={1.4}
                                step={0.05}
                                style={{ width: "100%" }}
                                value={mounted ? ragSettings.voiceSpeed ?? 1.0 : 1.0}
                                onChange={(e) => setRagSettings({ voiceSpeed: Number(e.target.value) })}
                              />
                            </div>
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                                Pitch: <b style={{ color: "var(--text-0)" }}>{(mounted ? ragSettings.voicePitch ?? 1 : 1).toFixed(2)}</b>
                              </div>
                              <input
                                type="range"
                                min={0.75}
                                max={1.25}
                                step={0.05}
                                style={{ width: "100%" }}
                                value={mounted ? ragSettings.voicePitch ?? 1.0 : 1.0}
                                onChange={(e) => setRagSettings({ voicePitch: Number(e.target.value) })}
                              />
                            </div>
                          </div>

                          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-0)" }}>
                            <input
                              type="checkbox"
                              checked={mounted ? ragSettings.autoSendVoice ?? true : true}
                              onChange={(e) => setRagSettings({ autoSendVoice: e.target.checked })}
                            />
                            Auto-send message when finished speaking
                          </label>

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4 }}>
                            <button
                              className="btn-secondary"
                              style={{ fontSize: 11.5, padding: "5px 10px" }}
                              onClick={() =>
                                speakAnswer(
                                  `Hi! I am ${botName}. My voice synthesis is configured and ready.`,
                                  chatbot,
                                  { onStatus: (st) => setVoiceStatus(st || null) }
                                )
                              }
                            >
                              🔊 Preview Voice
                            </button>
                            <button
                              className="link-btn"
                              onClick={() => {
                                setVoiceConfigOpen(false);
                                openModal("settings");
                              }}
                            >
                              Full Studio Settings →
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {voiceStatus && (
                  <div className="voice-status-banner">
                    <span className="voice-pulse-dot" />
                    <span style={{ flex: 1 }}>{voiceStatus}</span>
                    {listening && (
                      <>
                        <button
                          className="btn-primary"
                          style={{ padding: "3px 10px", fontSize: 11.5 }}
                          onClick={() => toggleVoiceInput()}
                        >
                          ✓ Done
                        </button>
                        <button className="link-btn" onClick={cancelVoiceInput}>
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                )}

                <div className="chat-composer-inner">
                  <button
                    type="button"
                    className={`voice-mic-btn ${listening ? "listening" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleVoiceInput();
                    }}
                    disabled={busy}
                    title={listening ? "Finish speaking" : "Speak your question (Voice Input)"}
                    aria-label={listening ? "Finish speaking" : "Speak your question"}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="2" width="6" height="12" rx="3" />
                      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                      <line x1="12" y1="18" x2="12" y2="22" />
                      <line x1="8" y1="22" x2="16" y2="22" />
                    </svg>
                  </button>
                  <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
                    placeholder={
                      listening
                        ? voiceStatus || "Listening… speak your question"
                        : `Ask ${botName} a question about ${
                            selectedDocIds.length > 0
                              ? `${selectedDocIds.length} selected document(s)`
                              : activeSpaceName ?? "all your documents"
                          }…`
                    }
                  />
                  <button className="btn-primary" onClick={() => sendQuestion()} disabled={busy || !prompt.trim()}>
                    <span>Send</span>
                    <SendGlyph />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: Full Document Library & Inspector */}
        {currentTab === "documents" && (
          <div className="view-scroll">
            <div className="overview-grid">
              <div
                className={`drop-card ${drag ? "dragging" : ""}`}
                onClick={() => fileInputRef.current?.click()}
              >
                <h4>Upload Documents to {activeSpaceName ? `Space: ${activeSpaceName}` : "Your Knowledge Base"}</h4>
                <p>Drag &amp; drop or click to select PDF, DOCX, XLSX, PPTX, RTF, PNG/JPG (OCR), CSV, Markdown, TXT, JSON, or HTML files</p>
              </div>

              <div className="surface-card">
                <div className="surface-head">
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <h3>
                      {previewDoc
                        ? `Document Inspector · ${previewDoc.filename}`
                        : `Documents (${filteredDocs.length})`}
                    </h3>
                    {selectedDocIds.length > 0 && (
                      <span className="badge-pill">
                        {selectedDocIds.length} selected for scoped chat{" "}
                        <button className="link-btn" onClick={clearSelectedDocs}>
                          Clear
                        </button>
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {!previewDoc ? (
                      <input
                        className="input-field"
                        placeholder="Filter by filename…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        style={{ width: 240 }}
                      />
                    ) : (
                      <button className="btn-secondary" onClick={() => setPreviewDoc(null)}>
                        ← Back to Document List
                      </button>
                    )}
                  </div>
                </div>

                <div className="surface-body">
                  {previewDoc ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div className="doc-preview-head">
                        <span>
                          <b>{previewDoc.filename}</b> · {formatBytes(previewDoc.size)} · {previewChunks.length} indexed chunks
                        </span>
                        <button
                          className="btn-primary"
                          onClick={() => {
                            if (!selectedDocIds.includes(previewDoc.document_id)) {
                              toggleSelectedDoc(previewDoc.document_id);
                            }
                            setActiveTab("chat");
                          }}
                        >
                          Chat with this document →
                        </button>
                      </div>
                      <div className="citation-scroll" style={{ maxHeight: 480 }}>
                        {previewChunks.map((c) => (
                          <div key={c.chunk_id} className="citation-chunk">
                            <div className="citation-chunk-meta">
                              Chunk #{c.index + 1} {c.section ? `· ${c.section}` : c.page ? `· Page ${c.page}` : ""}
                            </div>
                            <div className="citation-chunk-text">{c.text}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : filteredDocs.length === 0 ? (
                    <div className="empty-state">
                      No documents match the current filter. Upload a document above or switch Knowledge Spaces in the sidebar.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {filteredDocs.map((d) => {
                        const checked = selectedDocIds.includes(d.document_id);
                        const assignedSpace = docSpaceMap.get(d.document_id) ?? "";
                        return (
                          <div key={d.document_id} className={`doc-row ${checked ? "selected" : ""}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSelectedDoc(d.document_id)}
                              title="Select document to scope chat retrieval"
                            />
                            <div>
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
                                {d.error ? ` (${d.error})` : ""} · Uploaded {new Date(d.uploaded_at).toLocaleDateString()}
                              </div>
                            </div>

                            <select
                              className="doc-space-select"
                              value={assignedSpace}
                              onChange={(e) => assignDocToSpace(d.document_id, e.target.value || null)}
                            >
                              <option value="">No Space</option>
                              {spaces.map((s) => (
                                <option key={s.space_id} value={s.space_id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>

                            <div className="doc-actions">
                              <button onClick={() => setPreviewDoc(d)}>Preview Chunks</button>
                              <button
                                onClick={() => {
                                  setEditingId(d.document_id);
                                  setEditingName(d.filename);
                                }}
                              >
                                Rename
                              </button>
                              <button onClick={() => reprocessDocument(d.document_id)}>Reprocess</button>
                              <button className="danger" onClick={() => deleteDocument(d.document_id)}>
                                Delete
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Native Mobile Bottom Navigation Bar (iOS Tab Bar / Android Material 3 Navigation Bar) */}
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button
          className={`mobile-tab-item ${currentTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          <span className="mobile-tab-indicator">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </span>
          <span className="mobile-tab-label">Home</span>
        </button>

        <button
          className={`mobile-tab-item ${currentTab === "chat" ? "active" : ""}`}
          onClick={() => setActiveTab("chat")}
        >
          <span className="mobile-tab-indicator">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <span className="mobile-tab-label">AI Chat</span>
        </button>

        <button
          className={`mobile-tab-item ${currentTab === "documents" ? "active" : ""}`}
          onClick={() => setActiveTab("documents")}
        >
          <span className="mobile-tab-indicator">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span className="mobile-tab-label">Docs ({docs.length})</span>
        </button>

        <button
          className="mobile-tab-item"
          onClick={() => openModal("settings")}
        >
          <span className="mobile-tab-indicator">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </span>
          <span className="mobile-tab-label">Settings</span>
        </button>
      </nav>

      {/* Shared Modals */}
      <CitationModal />
      <DocumentLibraryModal />
      <OnboardingModal />
      <StorageSettingsModal />
    </div>
  );
}
