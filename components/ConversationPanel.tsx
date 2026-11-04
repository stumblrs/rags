"use client";
import { useState, useRef, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, uid, type ConversationRecord, type MessageRecord } from "@/lib/db";
import { retrieve } from "@/lib/rag";
import { ensureLlmEngine, generateGroundedAnswer, hasWebGPU } from "@/lib/ai";
import { useApp, type AvatarCategory, type ChatbotConfig } from "@/lib/store";
import { AvatarGlyph, Dots, SendGlyph, UserGlyph } from "./Icons";

/** Shown until the user starts a conversation — reproduces the reference layout with real copy. */
const DEMO: MessageRecord[] = [
  { message_id: "d1", conversation_id: "demo", role: "user", created_at: "", content: "Analyze the attached research documents for insights" },
  {
    message_id: "d2",
    conversation_id: "demo",
    role: "assistant",
    created_at: "",
    content:
      "Analyzing documents...\nextracting key entities,\nrelationships, and context.\n\nUpload PDF, Word, Excel, PowerPoint, CSV, Markdown, or text documents in the Document Processing panel, then ask a question. Everything runs locally on this device.",
  },
  {
    message_id: "d3",
    conversation_id: "demo",
    role: "assistant",
    created_at: "",
    content:
      "Generating synthesis from\nknowledge base...\n\nAnswers are grounded in your uploaded documents and include clickable page or section citations. If the information isn't in your documents, I'll say so.",
  },
];

function split(content: string) {
  const i = content.indexOf("\n\n");
  return i < 0 ? [content, ""] : [content.slice(0, i), content.slice(i + 2)];
}

function Title({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : null;
  return (
    <div className="brand-title">
      {parts.join(" ")}
      {last && <> <b>{last}</b></>}
    </div>
  );
}

export default function ConversationPanel() {
  const {
    chatbot,
    setChatbot,
    conversationId,
    setConversation,
    activeSpaceId,
    setActiveSpace,
    selectedDocIds,
    clearSelectedDocs,
    openModal,
    openCitation,
    embedStatus,
    embedProgress,
    llmStatus,
    llmProgress,
  } = useApp();

  const [mounted, setMounted] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);
  const botName = mounted ? chatbot.name : "Cognitive AI";
  const botAvatar: AvatarCategory = mounted ? chatbot.avatar : "chat";

  const messages = useLiveQuery<MessageRecord[]>(
    async () => (conversationId ? db.messages.where("conversation_id").equals(conversationId).sortBy("created_at") : []),
    [conversationId]
  );
  const conversations = useLiveQuery<ConversationRecord[]>(
    () => db.conversations.orderBy("created_at").reverse().toArray(),
    []
  );
  const spaces = useLiveQuery(() => db.spaces.orderBy("created_at").toArray(), []) ?? [];

  const shown = mounted && messages && messages.length ? messages : DEMO;
  const isDemo = shown === DEMO;

  useEffect(() => {
    listRef.current?.scrollTo({ top: 1e6, behavior: "smooth" });
  }, [messages?.length, streamText]);

  async function askQuestion(q: string, existingCid?: string | null) {
    setBusy(true);
    setStreamText("");
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
    const sources = await retrieve(q);
    const content = await generateGroundedAnswer(q, sources, chatbot, (partial) => setStreamText(partial));
    setStreamText("");
    await db.messages.add({
      message_id: uid("msg"),
      conversation_id: cid,
      role: "assistant",
      content,
      sources,
      created_at: new Date().toISOString(),
    });
    setBusy(false);
  }

  async function send() {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
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
      created_at: new Date().toISOString(),
    });
    await askQuestion(q, cid);
  }

  async function regenerate(assistantMsg: MessageRecord) {
    if (busy || !messages) return;
    const idx = messages.findIndex((m) => m.message_id === assistantMsg.message_id);
    if (idx <= 0) return;
    const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    if (!prevUser) return;
    await db.messages.delete(assistantMsg.message_id);
    await askQuestion(prevUser.content, assistantMsg.conversation_id);
  }

  function exportCurrentConversation() {
    const list = messages && messages.length ? messages : DEMO;
    const md = list
      .map((m) => {
        const who = m.role === "user" ? "You" : botName;
        const cites =
          m.sources && m.sources.length
            ? "\n\nSources:\n" +
              m.sources
                .map(
                  (s, i) =>
                    `- [${i + 1}] ${s.filename} (${s.section ?? (s.page ? `Page ${s.page}` : `Chunk ${s.chunk_index + 1}`)})`
                )
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

  async function clearCurrentConversation() {
    if (!conversationId) return;
    await db.transaction("rw", db.conversations, db.messages, async () => {
      await db.messages.where("conversation_id").equals(conversationId).delete();
      await db.conversations.delete(conversationId);
    });
    setConversation(null);
  }

  return (
    <section className="panel chat" aria-label="Conversation">
      <header className="chat-header">
        <div
          className="brand-icon"
          onClick={() => openModal("onboarding")}
          style={{ cursor: "pointer" }}
          title="Customize assistant name, avatar & personality"
        >
          <AvatarGlyph avatar={botAvatar} forHeader />
        </div>
        <Title name={botName} />
        <button
          title="Assistant settings & local AI models"
          onClick={() => setMenuOpen((o) => !o)}
          style={{ position: "absolute", left: 330, top: 26, width: 30, height: 30 }}
        >
          <Dots style={{ left: 10, top: 11 }} />
        </button>
      </header>

      {menuOpen && (
        <div className="chat-menu">
          <div className="chat-menu-row">
            <label>Conversation</label>
            <select
              value={conversationId ?? ""}
              onChange={(e) => setConversation(e.target.value || null)}
            >
              <option value="">+ New Conversation</option>
              {(conversations ?? []).map((c) => (
                <option key={c.conversation_id} value={c.conversation_id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>

          <div className="chat-menu-row">
            <label>Scope</label>
            <select
              value={activeSpaceId ?? ""}
              onChange={(e) => setActiveSpace(e.target.value || null)}
            >
              <option value="">All Documents</option>
              {spaces.map((s) => (
                <option key={s.space_id} value={s.space_id}>
                  Space: {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="chat-menu-row">
            <label>Personality</label>
            <select
              value={chatbot.personality}
              onChange={(e) => setChatbot({ personality: e.target.value as ChatbotConfig["personality"] })}
            >
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="concise">Concise</option>
              <option value="academic">Academic</option>
            </select>
          </div>

          <div className="chat-menu-row">
            <label>Style</label>
            <select
              value={chatbot.response_style}
              onChange={(e) => setChatbot({ response_style: e.target.value as ChatbotConfig["response_style"] })}
            >
              <option value="detailed">Detailed</option>
              <option value="simple">Simple</option>
              <option value="bullets">Bullet points</option>
              <option value="steps">Step-by-step</option>
              <option value="technical">Technical</option>
              <option value="executive">Executive summary</option>
            </select>
          </div>

          <div className="chat-menu-meta">
            <div>
              Embeddings: <b>{embedProgress || (embedStatus === "ready" ? "MiniLM-L6-v2" : "Auto on upload")}</b>
            </div>
            <div>
              SLM: <b>{llmProgress || (llmStatus === "ready" ? "SmolLM2 Ready" : "Grounded extractive")}</b>
            </div>
            {selectedDocIds.length > 0 && (
              <div>
                Filtered to <b>{selectedDocIds.length} doc(s)</b>{" "}
                <button className="link-btn" onClick={clearSelectedDocs}>
                  (reset)
                </button>
              </div>
            )}
          </div>

          <div className="chat-menu-actions">
            <button onClick={() => { setMenuOpen(false); openModal("onboarding"); }}>Personalize</button>
            <button onClick={() => { setMenuOpen(false); openModal("library"); }}>Documents</button>
            <button onClick={() => { setMenuOpen(false); openModal("settings"); }}>Storage &amp; Models</button>
          </div>

          <div className="chat-menu-actions">
            {llmStatus !== "ready" && llmStatus !== "downloading" && hasWebGPU() && (
              <button onClick={() => ensureLlmEngine()}>Load WebLLM</button>
            )}
            <button onClick={exportCurrentConversation}>Export Chat</button>
            {conversationId && <button onClick={clearCurrentConversation}>Clear Chat</button>}
          </div>
        </div>
      )}

      <div className="messages" ref={listRef}>
        {shown.map((m, idx) => {
          if (m.role === "user") {
            return (
              <div key={m.message_id} style={{ marginTop: idx ? 26 : 0 }}>
                <div className="msg-user">
                  <div className="bubble-user">
                    {m.content}
                    {isDemo && <small>(your question appears here)</small>}
                  </div>
                  <div className="avatar-user"><UserGlyph /></div>
                </div>
                <div className="user-name">You</div>
              </div>
            );
          }
          const [head, body] = split(m.content);
          return (
            <div key={m.message_id} className="msg-ai" style={idx > 0 && shown[idx - 1].role === "assistant" ? { marginTop: 27 } : undefined}>
              <div className="avatar-ai"><AvatarGlyph avatar={botAvatar} /></div>
              <div className="card-ai">
                <h4>{head}</h4>
                {body && <p>{body}</p>}
                {m.sources && m.sources.length > 0 && (
                  <div className="sources">
                    {m.sources.map((s, i) => {
                      const loc = s.section ? s.section : s.page ? `Page ${s.page}` : `chunk ${s.chunk_index + 1}`;
                      return (
                        <button
                          key={i}
                          className="source"
                          onClick={() => openCitation(s)}
                          title="Click to inspect source document & highlighted passage"
                        >
                          [{i + 1}] <b>{s.filename}</b> · {loc} · {(s.score * 100).toFixed(0)}%
                        </button>
                      );
                    })}
                  </div>
                )}
                {!isDemo && (
                  <div className="card-tools">
                    <button
                      onClick={() => {
                        navigator.clipboard?.writeText(m.content);
                        setCopiedId(m.message_id);
                        setTimeout(() => setCopiedId(null), 1500);
                      }}
                    >
                      {copiedId === m.message_id ? "Copied" : "Copy"}
                    </button>
                    <button onClick={() => regenerate(m)}>Regenerate</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="msg-ai" style={{ marginTop: 24 }}>
            <div className="avatar-ai"><AvatarGlyph avatar={botAvatar} /></div>
            <div className="card-ai">
              {streamText ? <p>{streamText}</p> : <div className="typing">{botName} is synthesizing from your documents…</div>}
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder=""
          aria-label={`Message ${botName}`}
        />
      </div>
      <button className="send" onClick={send} disabled={busy} aria-label="Send"><SendGlyph /></button>
    </section>
  );
}
