"use client";
import { useRef, useState } from "react";
import { detectHardwareAndSelectModel } from "@/lib/ai";
import { useApp, type AvatarCategory, type ChatbotConfig } from "@/lib/store";
import { AvatarGlyph } from "./Icons";

const AVATARS: { id: AvatarCategory; label: string }[] = [
  { id: "chat", label: "Cognitive Chat" },
  { id: "robot", label: "AI Robot" },
  { id: "neural", label: "Neural Knot" },
  { id: "friendly", label: "Friendly" },
  { id: "geometric", label: "Geometric" },
];

const PERSONALITIES: { id: ChatbotConfig["personality"]; label: string; desc: string }[] = [
  { id: "friendly", label: "Friendly", desc: "Warm, conversational and approachable" },
  { id: "professional", label: "Professional", desc: "Formal, structured and business-oriented" },
  { id: "concise", label: "Concise", desc: "Short, direct and focused" },
  { id: "academic", label: "Academic", desc: "Analytical, detailed and evidence-oriented" },
];

const STYLES: { id: ChatbotConfig["response_style"]; label: string; desc: string }[] = [
  { id: "detailed", label: "Detailed", desc: "Thorough answers with context" },
  { id: "simple", label: "Simple", desc: "Easy-to-understand explanations" },
  { id: "bullets", label: "Bullet points", desc: "Organized lists" },
  { id: "steps", label: "Step-by-step", desc: "Sequential explanations" },
  { id: "technical", label: "Technical", desc: "Technical terminology and precision" },
  { id: "executive", label: "Executive summary", desc: "Brief summaries of key findings" },
];

const LANGUAGES = ["English", "Spanish", "French", "German", "Portuguese", "Italian", "Arabic"];

export default function OnboardingModal() {
  const { activeModal, openModal, chatbot, setChatbot, setOnboarded } = useApp();
  const [step, setStep] = useState(0);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  if (activeModal !== "onboarding") return null;

  function finish() {
    setOnboarded(true);
    openModal(null);
    detectHardwareAndSelectModel(true).catch(() => {});
  }

  function handleCustomAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setChatbot({ avatar: "custom", customAvatarUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h3>mairag · Assistant Setup</h3>
            <span className="modal-sub">
              100% private &amp; on-device · No account, cloud storage, or external API required
            </span>
          </div>
          <button className="btn-ghost" onClick={finish}>Skip setup</button>
        </header>

        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="step-dots">
            {[0, 1, 2].map((s) => (
              <span key={s} className={step === s ? "active" : ""} onClick={() => setStep(s)} />
            ))}
          </div>

          {step === 0 && (
            <div className="onboard-step">
              <h4>1. Name &amp; Avatar</h4>
              <p className="onboard-desc">
                Give your personal AI assistant a name and choose an avatar (or upload a custom image). You can change these at any time without reprocessing your documents.
              </p>

              <label className="field-label">Assistant Name</label>
              <input
                className="neon-input"
                value={chatbot.name}
                onChange={(e) => setChatbot({ name: e.target.value })}
                placeholder="e.g. mairag, Nova, Atlas, Athena…"
              />

              <div className="preset-chips">
                {["mairag", "Nova AI", "Atlas AI", "Athena AI", "Research Buddy"].map((preset) => (
                  <button
                    key={preset}
                    className={`chip ${chatbot.name === preset ? "active" : ""}`}
                    onClick={() => setChatbot({ name: preset })}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <label className="field-label" style={{ marginTop: 6 }}>Choose Avatar or Upload Custom Image</label>
              <div className="avatar-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
                {AVATARS.map((a) => (
                  <button
                    key={a.id}
                    className={`avatar-choice ${chatbot.avatar === a.id ? "active" : ""}`}
                    onClick={() => setChatbot({ avatar: a.id })}
                  >
                    <div className="avatar-preview">
                      <AvatarGlyph avatar={a.id} forHeader />
                    </div>
                    <span>{a.label}</span>
                  </button>
                ))}

                <button
                  className={`avatar-choice ${chatbot.avatar === "custom" ? "active" : ""}`}
                  onClick={() => avatarInputRef.current?.click()}
                  title="Upload custom PNG/JPG/WebP avatar"
                >
                  <div className="avatar-preview" style={{ overflow: "hidden" }}>
                    {chatbot.customAvatarUrl ? (
                      <AvatarGlyph avatar="custom" customUrl={chatbot.customAvatarUrl} forHeader />
                    ) : (
                      <span style={{ fontSize: 18, fontWeight: 600 }}>+</span>
                    )}
                  </div>
                  <span>Custom Image</span>
                </button>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                hidden
                onChange={(e) => {
                  handleCustomAvatar(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          )}

          {step === 1 && (
            <div className="onboard-step">
              <h4>2. Personality &amp; Language</h4>
              <p className="onboard-desc">
                Choose how your assistant communicates. Personality shapes tone without altering the facts retrieved from your documents.
              </p>

              <div className="option-grid">
                {PERSONALITIES.map((p) => (
                  <button
                    key={p.id}
                    className={`option-card ${chatbot.personality === p.id ? "active" : ""}`}
                    onClick={() => setChatbot({ personality: p.id })}
                  >
                    <b>{p.label}</b>
                    <span>{p.desc}</span>
                  </button>
                ))}
              </div>

              <label className="field-label" style={{ marginTop: 6 }}>Preferred Response Language</label>
              <div className="preset-chips">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    className={`chip ${chatbot.language === lang ? "active" : ""}`}
                    onClick={() => setChatbot({ language: lang })}
                  >
                    {lang}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="onboard-step">
              <h4>3. Response Style</h4>
              <p className="onboard-desc">
                Select how grounded answers and citations should be formatted.
              </p>

              <div className="option-grid">
                {STYLES.map((st) => (
                  <button
                    key={st.id}
                    className={`option-card ${chatbot.response_style === st.id ? "active" : ""}`}
                    onClick={() => setChatbot({ response_style: st.id })}
                  >
                    <b>{st.label}</b>
                    <span>{st.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <footer className="modal-footer">
            {step > 0 ? (
              <button className="btn-ghost" onClick={() => setStep(step - 1)}>← Back</button>
            ) : <span />}
            {step < 2 ? (
              <button className="btn-neon" onClick={() => setStep(step + 1)}>Next →</button>
            ) : (
              <button className="btn-neon" onClick={finish}>Finish &amp; Enter Workspace</button>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
