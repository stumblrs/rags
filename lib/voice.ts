/**
 * Multi-Tier Local Voice Engine (Piper TTS + Kokoro-82M + Voicebox.sh Bridge + Persistent Mic STT):
 *
 * Tier 1 — Piper Neural TTS (`@mintplex-labs/piper-tts-web` · WASM + OPFS cached):
 *   - Fast, lightweight (~18MB–40MB) on-device neural speech synthesis that runs in a Web Worker and caches models in OPFS.
 *   - Supports English, Spanish, French, German, Portuguese, Italian, and Arabic neural voices.
 *
 * Tier 2 — Voicebox.sh Local Studio Bridge (`http://127.0.0.1:17493`):
 *   - Connects to the user's local Voicebox desktop studio if running (`GET /profiles`, `POST /generate`).
 *   - Supports custom cloned voice profiles.
 *
 * Tier 3 — In-Browser Kokoro-82M Neural TTS (`onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js`):
 *   - Studio-grade 82M-parameter neural TTS running inside the browser via WebGPU / WASM (`q8` quantized).
 *
 * Tier 4 — OS System Speech (`window.speechSynthesis`):
 *   - Zero-download instant fallback with configurable OS voice picker, speaking speed (`0.7x – 1.4x`), and pitch.
 *
 * Speech-to-Text (STT) — Persistent Active Recording:
 *   - Requests real microphone permission (`getUserMedia`) first and keeps the session open (`continuous = true` + auto-restart on early browser silence)
 *     so the microphone NEVER shuts off prematurely while you are thinking or pausing between phrases.
 *   - Automatically falls back to 100% on-device `Xenova/whisper-tiny` (16kHz WebAudio) if native `SpeechRecognition` is blocked or offline.
 */

import { useApp, type ChatbotConfig } from "./store";

export interface PiperVoiceOption {
  id: string;
  label: string;
  language: string;
}

export const PIPER_VOICES: PiperVoiceOption[] = [
  { id: "en_US-hfc_female-medium", label: "HFC Female (Natural Conversational · Default)", language: "English" },
  { id: "en_US-lessac-medium", label: "Lessac (Warm Expressive Female)", language: "English" },
  { id: "en_US-ryan-medium", label: "Ryan (Clear Studio Male)", language: "English" },
  { id: "en_US-amy-medium", label: "Amy (Friendly Assistant Female)", language: "English" },
  { id: "en_GB-alba-medium", label: "Alba (British Female)", language: "English" },
  { id: "en_GB-cori-medium", label: "Cori (British Narrator)", language: "English" },
  { id: "es_ES-sharvard-medium", label: "Sharvard (Spanish Neural)", language: "Spanish" },
  { id: "fr_FR-upmc-medium", label: "UPMC (French Neural)", language: "French" },
  { id: "de_DE-thorsten-medium", label: "Thorsten (German Neural)", language: "German" },
  { id: "pt_BR-faber-medium", label: "Faber (Portuguese Neural)", language: "Portuguese" },
  { id: "it_IT-riccardo-x_low", label: "Riccardo (Italian Neural)", language: "Italian" },
  { id: "ar_JO-kareem-medium", label: "Kareem (Arabic Neural)", language: "Arabic" },
];

const DEFAULT_PIPER_BY_LANG: Record<string, string> = {
  English: "en_US-hfc_female-medium",
  Spanish: "es_ES-sharvard-medium",
  French: "fr_FR-upmc-medium",
  German: "de_DE-thorsten-medium",
  Portuguese: "pt_BR-faber-medium",
  Italian: "it_IT-riccardo-x_low",
  Arabic: "ar_JO-kareem-medium",
};

export interface KokoroVoiceOption {
  id: string;
  label: string;
  accent: string;
}

export const KOKORO_VOICES: KokoroVoiceOption[] = [
  { id: "af_heart", label: "Heart (Warm Female · Studio Default)", accent: "US English" },
  { id: "af_bella", label: "Bella (Expressive Female)", accent: "US English" },
  { id: "af_nicole", label: "Nicole (Calm Professional Female)", accent: "US English" },
  { id: "am_adam", label: "Adam (Clear Narrative Male)", accent: "US English" },
  { id: "am_michael", label: "Michael (Deep Conversational Male)", accent: "US English" },
  { id: "bf_emma", label: "Emma (Natural British Female)", accent: "UK English" },
  { id: "bm_george", label: "George (Measured British Male)", accent: "UK English" },
];

export interface VoiceboxProfile {
  id: string;
  name: string;
}

export interface SystemVoiceOption {
  uri: string;
  name: string;
  lang: string;
  local: boolean;
}

const LANG_BCP47: Record<string, string> = {
  English: "en-US",
  Spanish: "es-ES",
  French: "fr-FR",
  German: "de-DE",
  Portuguese: "pt-PT",
  Italian: "it-IT",
  Arabic: "ar-SA",
};

const LANG_ISO: Record<string, string> = {
  English: "en",
  Spanish: "es",
  French: "fr",
  German: "de",
  Portuguese: "pt",
  Italian: "it",
  Arabic: "ar",
};

const WHISPER_LANG: Record<string, string> = {
  English: "english",
  Spanish: "spanish",
  French: "french",
  German: "german",
  Portuguese: "portuguese",
  Italian: "italian",
  Arabic: "arabic",
};

export function getAvailableSystemVoices(): SystemVoiceOption[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  const raw = window.speechSynthesis.getVoices() || [];
  return raw.map((v) => ({
    uri: v.voiceURI,
    name: v.name,
    lang: v.lang,
    local: Boolean(v.localService),
  }));
}

/**
 * Cleans an assistant response before speaking aloud so citation numbers (`[1: Page 3]`)
 * and markdown formatting (`**`, `•`, `▸`) are not read literally by the synthesizer.
 */
export function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/\[\d+(?::[^\]]+)?\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^[•▸\-*]\s+/gm, "")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

let activeAudioElement: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let speechAborted = false;

export function stopSpeaking(): void {
  speechAborted = true;
  if (activeAudioElement) {
    try {
      activeAudioElement.pause();
      activeAudioElement.src = "";
    } catch {}
    activeAudioElement = null;
  }
  if (activeAudioUrl) {
    try {
      URL.revokeObjectURL(activeAudioUrl);
    } catch {}
    activeAudioUrl = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
}

function playAudioBlob(blob: Blob, playbackRate = 1.0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (speechAborted) {
      resolve();
      return;
    }
    const url = URL.createObjectURL(blob);
    activeAudioUrl = url;
    const audio = new Audio(url);
    audio.playbackRate = Math.max(0.6, Math.min(1.6, playbackRate || 1.0));
    activeAudioElement = audio;
    audio.onended = () => {
      if (activeAudioUrl === url) {
        URL.revokeObjectURL(url);
        activeAudioUrl = null;
      }
      if (activeAudioElement === audio) activeAudioElement = null;
      resolve();
    };
    audio.onerror = () => {
      if (activeAudioUrl === url) {
        URL.revokeObjectURL(url);
        activeAudioUrl = null;
      }
      if (activeAudioElement === audio) activeAudioElement = null;
      reject(new Error("Audio playback failed"));
    };
    audio.play().catch(reject);
  });
}

/**
 * Tier 1: Piper Neural TTS (`@mintplex-labs/piper-tts-web`).
 * Runs in a dedicated Web Worker, caches ONNX voice models inside OPFS, and streams sentence-by-sentence.
 */
async function speakViaPiper(
  cleanText: string,
  chatbot: ChatbotConfig,
  onStatus?: (msg: string) => void,
  onStart?: () => void
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const piper = await import("@mintplex-labs/piper-tts-web");
    const { ragSettings } = useApp.getState();
    const speed = ragSettings.voiceSpeed || 1.0;

    // Select configured Piper voice or auto-match the chatbot's response language
    let voiceId = ragSettings.piperVoiceId || "en_US-hfc_female-medium";
    if (chatbot.language !== "English" && voiceId.startsWith("en_")) {
      voiceId = DEFAULT_PIPER_BY_LANG[chatbot.language] || voiceId;
    }

    const sentences =
      cleanText
        .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
        ?.map((s) => s.trim())
        .filter((s) => s.length > 1) ?? [cleanText];

    let started = false;
    for (const sent of sentences) {
      if (speechAborted) break;
      if (!started) {
        onStatus?.(`Synthesizing with Piper Neural TTS (${voiceId})…`);
      }
      const wavBlob = await piper.predict(
        {
          text: sent,
          voiceId,
        },
        (prog) => {
          if (!started && prog.total > 0) {
            const pct = Math.round((prog.loaded * 100) / prog.total);
            onStatus?.(`Caching Piper neural voice in OPFS (${pct}%)…`);
          }
        }
      );

      if (speechAborted) break;
      if (!started) {
        started = true;
        onStatus?.("");
        onStart?.();
      }
      await playAudioBlob(wavBlob, speed);
    }
    return started;
  } catch {
    return false;
  }
}

/**
 * Probes whether the Voicebox.sh desktop studio is running locally (`http://127.0.0.1:17493`)
 * and returns any available cloned voice profiles.
 */
export async function probeVoiceboxServer(baseUrl?: string): Promise<{
  online: boolean;
  profiles: VoiceboxProfile[];
}> {
  const url = (baseUrl || useApp.getState().ragSettings.voiceboxUrl || "http://127.0.0.1:17493").replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${url}/profiles`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { online: false, profiles: [] };
    const data = await res.json();
    const list = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : [];
    const profiles: VoiceboxProfile[] = list.map((p: { id?: string; profile_id?: string; name?: string }, idx: number) => ({
      id: String(p.id || p.profile_id || `profile_${idx}`),
      name: String(p.name || p.id || `Voice Profile ${idx + 1}`),
    }));
    return { online: true, profiles };
  } catch {
    return { online: false, profiles: [] };
  }
}

async function speakViaVoicebox(cleanText: string, chatbot: ChatbotConfig, onStart?: () => void): Promise<boolean> {
  const { ragSettings } = useApp.getState();
  const baseUrl = (ragSettings.voiceboxUrl || "http://127.0.0.1:17493").replace(/\/+$/, "");
  const langIso = LANG_ISO[chatbot.language] || "en";
  const rate = ragSettings.voiceSpeed || 1.0;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const bodyPayload: Record<string, string> = {
      text: cleanText,
      language: langIso,
    };
    if (ragSettings.voiceboxProfileId) {
      bodyPayload.profile_id = ragSettings.voiceboxProfileId;
    }

    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("audio/") || contentType.includes("octet-stream")) {
      const audioBlob = await res.blob();
      onStart?.();
      await playAudioBlob(audioBlob, rate);
      return true;
    }

    const json = await res.json();
    if (json?.audio_url || json?.file_url || json?.path) {
      const audioRes = await fetch(
        String(json.audio_url || json.file_url || `${baseUrl}/audio?path=${encodeURIComponent(json.path)}`)
      );
      if (audioRes.ok) {
        const audioBlob = await audioRes.blob();
        onStart?.();
        await playAudioBlob(audioBlob, rate);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kokoroPromise: Promise<any> | null = null;
let kokoroFailed = false;

async function getKokoroTts(onStatus?: (msg: string) => void) {
  if (kokoroFailed || typeof window === "undefined") return null;
  if (!kokoroPromise) {
    kokoroPromise = (async () => {
      try {
        onStatus?.("Loading Kokoro-82M Neural Voice (~80MB, cached)…");
        const { KokoroTTS } = await import("kokoro-js");
        const hasGpu = typeof navigator !== "undefined" && "gpu" in navigator;
        const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
          dtype: "q8",
          device: hasGpu ? "webgpu" : "wasm",
        });
        return tts;
      } catch {
        try {
          const { KokoroTTS } = await import("kokoro-js");
          return await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
            dtype: "q8",
            device: "wasm",
          });
        } catch {
          kokoroFailed = true;
          kokoroPromise = null;
          return null;
        }
      }
    })();
  }
  return kokoroPromise;
}

async function speakViaKokoro(
  cleanText: string,
  onStatus?: (msg: string) => void,
  onStart?: () => void
): Promise<boolean> {
  const tts = await getKokoroTts(onStatus);
  if (!tts || speechAborted) return false;

  const { ragSettings } = useApp.getState();
  const voiceId = ragSettings.kokoroVoiceId || "af_heart";
  const speed = ragSettings.voiceSpeed || 1.0;

  const sentences =
    cleanText
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [cleanText];

  let started = false;
  for (const sent of sentences) {
    if (speechAborted) break;
    onStatus?.(started ? "Speaking (Kokoro-82M Neural)…" : "Synthesizing neural voice…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const audioResult: any = await tts.generate(sent, { voice: voiceId, speed });
    if (speechAborted) break;

    const blob: Blob =
      typeof audioResult?.toBlob === "function"
        ? audioResult.toBlob()
        : new Blob([audioResult?.toWav?.() ?? new Uint8Array()], { type: "audio/wav" });

    if (!started) {
      started = true;
      onStart?.();
    }
    await playAudioBlob(blob, 1.0);
  }
  return started;
}

function speakViaBrowserSynthesis(
  cleanText: string,
  chatbot: ChatbotConfig,
  callbacks?: { onStart?: () => void; onEnd?: () => void }
): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    callbacks?.onEnd?.();
    return;
  }

  const { ragSettings } = useApp.getState();
  const utter = new SpeechSynthesisUtterance(cleanText);
  const targetLang = LANG_BCP47[chatbot.language] || "en-US";
  utter.lang = targetLang;

  const baseRate = ragSettings.voiceSpeed || 1.0;
  const basePitch = ragSettings.voicePitch || 1.0;

  if (chatbot.personality === "concise") {
    utter.rate = Math.min(1.6, baseRate * 1.05);
    utter.pitch = basePitch;
  } else if (chatbot.personality === "friendly") {
    utter.rate = baseRate;
    utter.pitch = Math.min(1.4, basePitch * 1.03);
  } else if (chatbot.personality === "academic") {
    utter.rate = Math.max(0.6, baseRate * 0.96);
    utter.pitch = basePitch;
  } else {
    utter.rate = baseRate;
    utter.pitch = basePitch;
  }

  const voices = window.speechSynthesis.getVoices();
  const customVoice = ragSettings.systemVoiceURI
    ? voices.find((v) => v.voiceURI === ragSettings.systemVoiceURI)
    : undefined;

  if (customVoice) {
    utter.voice = customVoice;
    utter.lang = customVoice.lang;
  } else {
    const langPrefix = targetLang.slice(0, 2).toLowerCase();
    const matchingVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
    const preferredVoice =
      matchingVoices.find((v) => /natural|neural|siri|premium|enhanced|google/i.test(v.name)) ||
      matchingVoices.find((v) => v.localService) ||
      matchingVoices[0];
    if (preferredVoice) utter.voice = preferredVoice;
  }

  utter.onstart = () => callbacks?.onStart?.();
  utter.onend = () => callbacks?.onEnd?.();
  utter.onerror = () => callbacks?.onEnd?.();

  window.speechSynthesis.speak(utter);
}

/**
 * Speaks an assistant response using the configured voice pipeline:
 * - `piper` (or `auto`): Runs Piper Neural TTS (`@mintplex-labs/piper-tts-web`) cached in OPFS.
 * - `voicebox`: Connects to local Voicebox.sh studio (`http://127.0.0.1:17493`).
 * - `kokoro`: Runs Kokoro-82M Neural ONNX in-browser.
 * - `browser`: Instant OS Speech Synthesis fallback.
 */
export async function speakAnswer(
  text: string,
  chatbot: ChatbotConfig,
  callbacks?: { onStart?: () => void; onEnd?: () => void; onStatus?: (msg: string) => void }
): Promise<void> {
  stopSpeaking();
  speechAborted = false;

  const clean = cleanTextForSpeech(text);
  if (!clean) {
    callbacks?.onEnd?.();
    return;
  }

  const { ragSettings } = useApp.getState();
  const engineMode = ragSettings.voiceEngine || "piper";

  // 1. Voicebox.sh Local Studio if selected
  if (engineMode === "voicebox") {
    callbacks?.onStatus?.("Connecting to local Voicebox studio…");
    const ok = await speakViaVoicebox(clean, chatbot, callbacks?.onStart);
    if (ok) {
      callbacks?.onStatus?.("");
      callbacks?.onEnd?.();
      return;
    }
  }

  // 2. Piper Neural TTS (Default for voice-to-voice conversation & multilingual OPFS neural synthesis)
  if (!speechAborted && (engineMode === "piper" || engineMode === "auto")) {
    const ok = await speakViaPiper(clean, chatbot, callbacks?.onStatus, callbacks?.onStart);
    if (ok) {
      callbacks?.onStatus?.("");
      callbacks?.onEnd?.();
      return;
    }
  }

  // 3. Kokoro-82M In-Browser Neural TTS
  if (!speechAborted && (engineMode === "kokoro" || (engineMode === "auto" && chatbot.language === "English"))) {
    try {
      const ok = await speakViaKokoro(clean, callbacks?.onStatus, callbacks?.onStart);
      if (ok) {
        callbacks?.onStatus?.("");
        callbacks?.onEnd?.();
        return;
      }
    } catch {
      // fall through to browser synthesis
    }
  }

  // 4. Fallback: OS System Speech Synthesis
  callbacks?.onStatus?.("");
  if (!speechAborted) {
    speakViaBrowserSynthesis(clean, chatbot, callbacks);
  } else {
    callbacks?.onEnd?.();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whisperPromise: Promise<any> | null = null;

async function getWhisperTranscriber(onProgress?: (msg: string) => void) {
  if (!whisperPromise) {
    whisperPromise = (async () => {
      onProgress?.("Loading local Whisper speech model…");
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
        dtype: "q8",
      });
    })();
  }
  return whisperPromise;
}

export interface VoiceRecorderSession {
  stop: () => void;
  cancel: () => void;
}

export async function startVoiceInput(options: {
  language: string;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus?: (status: string) => void;
  onError: (err: string) => void;
}): Promise<VoiceRecorderSession> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not supported in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });

  const bcp47 = LANG_BCP47[options.language] || "en-US";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRec = typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

  if (SpeechRec) {
    try {
      const rec = new SpeechRec();
      rec.lang = bcp47;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let accumulatedFinal = "";
      let currentInterim = "";
      let userStopped = false;
      let switchedToWhisper = false;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      let activeWhisperSession: VoiceRecorderSession | null = null;

      const releaseMicStream = () => {
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
        stream.getTracks().forEach((t) => t.stop());
      };

      const finishAndSubmit = () => {
        if (userStopped) return;
        userStopped = true;
        releaseMicStream();
        try {
          rec.stop();
        } catch {}
        const fullText = (accumulatedFinal + " " + currentInterim).replace(/\s+/g, " ").trim();
        options.onFinal(fullText);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0]?.transcript || "";
          if (event.results[i].isFinal) {
            accumulatedFinal += " " + transcript;
          } else {
            interim += transcript;
          }
        }
        currentInterim = interim;
        const combined = (accumulatedFinal + " " + currentInterim).replace(/\s+/g, " ").trim();
        if (combined) {
          options.onInterim(combined);
          options.onStatus?.("Listening… (Tap mic when done, or pause 2.5s to send)");
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            if (!userStopped && combined.length > 0) {
              finishAndSubmit();
            }
          }, 2600);
        }
      };

      rec.onend = () => {
        if (userStopped || switchedToWhisper) return;
        try {
          rec.start();
        } catch {
          finishAndSubmit();
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = async (ev: any) => {
        if (userStopped || switchedToWhisper) return;
        const code = ev?.error || "";

        if (code === "no-speech") {
          options.onStatus?.("Listening… Speak into your microphone");
          return;
        }

        if (code === "network" || code === "service-not-allowed" || code === "audio-capture" || code === "aborted") {
          switchedToWhisper = true;
          try {
            rec.stop();
          } catch {}
          try {
            activeWhisperSession = await startWhisperRecordingFromStream(stream, options);
          } catch (e) {
            releaseMicStream();
            options.onError((e as Error).message || "Microphone error");
          }
          return;
        }

        userStopped = true;
        releaseMicStream();
        if (code === "not-allowed" || code === "permission-denied") {
          options.onError("Microphone permission denied.");
        } else {
          options.onError(`Voice input error: ${code || "unavailable"}`);
        }
      };

      rec.start();
      options.onStatus?.("Listening… Speak now (Tap mic when finished)");

      return {
        stop: () => {
          if (activeWhisperSession) {
            activeWhisperSession.stop();
            return;
          }
          finishAndSubmit();
        },
        cancel: () => {
          if (activeWhisperSession) {
            activeWhisperSession.cancel();
            return;
          }
          userStopped = true;
          releaseMicStream();
          try {
            rec.stop();
          } catch {}
          options.onFinal("");
        },
      };
    } catch {
      // Fall through to on-device Whisper recording using the already-opened stream
    }
  }

  return startWhisperRecordingFromStream(stream, options);
}

async function startWhisperRecordingFromStream(
  stream: MediaStream,
  options: {
    language: string;
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onStatus?: (status: string) => void;
    onError: (err: string) => void;
  }
): Promise<VoiceRecorderSession> {
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const pcmChunks: Float32Array[] = [];
  const startTime = Date.now();

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
    const secs = Math.floor((Date.now() - startTime) / 1000);
    options.onStatus?.(`Recording audio (${secs}s)… Tap mic when finished`);
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
  options.onStatus?.("Recording audio (0s)… Tap mic when finished");

  let stopped = false;

  const cleanupAudio = async () => {
    try {
      processor.disconnect();
      source.disconnect();
    } catch {}
    stream.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => {});
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await cleanupAudio();

    const totalLen = pcmChunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLen < 2400) {
      options.onFinal("");
      return;
    }

    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of pcmChunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    try {
      options.onStatus?.("Transcribing speech locally with Whisper…");
      const transcriber = await getWhisperTranscriber(options.onStatus);
      const whisperLang = WHISPER_LANG[options.language] || "english";
      const out = await transcriber(merged, {
        language: whisperLang,
        task: "transcribe",
      });
      const text = (out?.text || "").trim();
      options.onFinal(text);
    } catch {
      options.onError("Local Whisper transcription failed.");
    }
  };

  const cancel = async () => {
    if (stopped) return;
    stopped = true;
    await cleanupAudio();
    options.onFinal("");
  };

  return { stop, cancel };
}
