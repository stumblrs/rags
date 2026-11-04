/**
 * Multi-Tier Local Voice Engine (Kokoro-82M In-Browser Neural TTS + Voicebox.sh Bridge + Whisper/Native STT):
 *
 * Tier 1 — Voicebox.sh Local Studio Bridge (`http://127.0.0.1:17493`):
 *   - Connects to the user's local Voicebox desktop studio if running (`GET /profiles`, `POST /generate` or `/speak`, `POST /transcribe`).
 *   - Supports custom cloned voice profiles.
 *
 * Tier 2 — In-Browser Kokoro-82M Neural TTS (`onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js`):
 *   - Studio-grade 82M-parameter neural TTS running 100% inside the browser via WebGPU / WASM (`q8` quantized).
 *   - Includes curated natural voices (`af_heart`, `af_bella`, `af_nicole`, `am_adam`, `am_michael`, `bf_emma`, `bm_george`).
 *
 * Tier 3 — OS System Speech (`window.speechSynthesis`):
 *   - Zero-download instant fallback for mobile battery-saver mode or non-English languages when Voicebox isn't running.
 *
 * Speech-to-Text (STT):
 *   - Supports Voicebox `/transcribe` (when Voicebox mode is active), live browser `SpeechRecognition`, and on-device `Xenova/whisper-tiny`.
 */

import { useApp, type ChatbotConfig } from "./store";

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

function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    if (speechAborted) {
      resolve();
      return;
    }
    const url = URL.createObjectURL(blob);
    activeAudioUrl = url;
    const audio = new Audio(url);
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

async function speakViaVoicebox(cleanText: string, chatbot: ChatbotConfig): Promise<boolean> {
  const { ragSettings } = useApp.getState();
  const baseUrl = (ragSettings.voiceboxUrl || "http://127.0.0.1:17493").replace(/\/+$/, "");
  const langIso = LANG_ISO[chatbot.language] || "en";

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
      await playAudioBlob(audioBlob);
      return true;
    }

    const json = await res.json();
    if (json?.audio_url || json?.file_url || json?.path) {
      const audioRes = await fetch(
        String(json.audio_url || json.file_url || `${baseUrl}/audio?path=${encodeURIComponent(json.path)}`)
      );
      if (audioRes.ok) {
        const audioBlob = await audioRes.blob();
        await playAudioBlob(audioBlob);
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
        // Fallback to wasm if webgpu dtype combination fails on a specific adapter
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

  const voiceId = useApp.getState().ragSettings.kokoroVoiceId || "af_heart";
  // Split into natural sentence groups (~240 chars) so playback starts quickly and streams smoothly
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
    const audioResult: any = await tts.generate(sent, { voice: voiceId });
    if (speechAborted) break;

    const blob: Blob =
      typeof audioResult?.toBlob === "function"
        ? audioResult.toBlob()
        : new Blob([audioResult?.toWav?.() ?? new Uint8Array()], { type: "audio/wav" });

    if (!started) {
      started = true;
      onStart?.();
    }
    await playAudioBlob(blob);
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

  const utter = new SpeechSynthesisUtterance(cleanText);
  const targetLang = LANG_BCP47[chatbot.language] || "en-US";
  utter.lang = targetLang;

  if (chatbot.personality === "concise") {
    utter.rate = 1.08;
    utter.pitch = 1.0;
  } else if (chatbot.personality === "friendly") {
    utter.rate = 1.02;
    utter.pitch = 1.05;
  } else if (chatbot.personality === "academic") {
    utter.rate = 0.96;
    utter.pitch = 0.96;
  } else {
    utter.rate = 1.0;
    utter.pitch = 1.0;
  }

  const voices = window.speechSynthesis.getVoices();
  const langPrefix = targetLang.slice(0, 2).toLowerCase();
  const matchingVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
  const preferredVoice =
    matchingVoices.find((v) => /natural|neural|siri|premium|enhanced|google/i.test(v.name)) ||
    matchingVoices.find((v) => v.localService) ||
    matchingVoices[0];

  if (preferredVoice) utter.voice = preferredVoice;

  utter.onstart = () => callbacks?.onStart?.();
  utter.onend = () => callbacks?.onEnd?.();
  utter.onerror = () => callbacks?.onEnd?.();

  window.speechSynthesis.speak(utter);
}

/**
 * Speaks an assistant response using the configured 3-tier voice pipeline:
 * 1. Voicebox.sh Local Studio (`http://127.0.0.1:17493`) if selected or running in auto mode.
 * 2. Kokoro-82M In-Browser Neural TTS (`onnx-community/Kokoro-82M-v1.0-ONNX`).
 * 3. Instant OS Browser Speech (`window.speechSynthesis`) fallback.
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
  const engineMode = ragSettings.voiceEngine || "auto";
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 960;

  // 1. Try Voicebox.sh desktop server if explicitly chosen or in Desktop Auto mode
  if (engineMode === "voicebox" || (engineMode === "auto" && !isMobile)) {
    callbacks?.onStatus?.("Checking local Voicebox studio…");
    const ok = await speakViaVoicebox(clean, chatbot);
    if (ok) {
      callbacks?.onStatus?.("");
      callbacks?.onEnd?.();
      return;
    }
  }

  // 2. Try In-Browser Kokoro-82M Neural TTS if chosen or in Desktop Auto mode (for English)
  if (
    !speechAborted &&
    (engineMode === "kokoro" || (engineMode === "auto" && !isMobile && chatbot.language === "English"))
  ) {
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

  // 3. Fallback (or mobile battery-saver default): OS Native Speech Synthesis
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
}

export async function startVoiceInput(options: {
  language: string;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus?: (status: string) => void;
  onError: (err: string) => void;
}): Promise<VoiceRecorderSession> {
  const bcp47 = LANG_BCP47[options.language] || "en-US";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRec = typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

  if (SpeechRec) {
    try {
      const rec = new SpeechRec();
      rec.lang = bcp47;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let finalTranscript = "";
      let latestInterim = "";
      let handled = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0]?.transcript || "";
          if (event.results[i].isFinal) {
            finalTranscript += transcript + " ";
          } else {
            interim += transcript;
          }
        }
        latestInterim = (finalTranscript + interim).trim();
        if (latestInterim) options.onInterim(latestInterim);
      };

      rec.onend = () => {
        if (handled) return;
        handled = true;
        const result = (finalTranscript || latestInterim).trim();
        options.onFinal(result);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = async (ev: any) => {
        if (handled) return;
        const code = ev?.error || "";
        if (code === "network" || code === "service-not-allowed") {
          handled = true;
          try {
            const fallbackSession = await startWhisperRecording(options);
            activeStop = fallbackSession.stop;
          } catch (e) {
            options.onError((e as Error).message || "Microphone error");
          }
          return;
        }
        handled = true;
        if (code === "not-allowed" || code === "permission-denied") {
          options.onError("Microphone permission denied.");
        } else if (code === "no-speech") {
          options.onFinal("");
        } else {
          options.onError(`Voice input error: ${code || "unavailable"}`);
        }
      };

      let activeStop = () => {
        try {
          rec.stop();
        } catch {}
      };

      rec.start();
      options.onStatus?.("Listening… Speak now");
      return {
        stop: () => activeStop(),
      };
    } catch {
      // Fall through to on-device Whisper recording below
    }
  }

  return startWhisperRecording(options);
}

async function startWhisperRecording(options: {
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
      sampleRate: 16000,
    },
  });

  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const pcmChunks: Float32Array[] = [];

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
  options.onStatus?.("Recording (On-device Whisper)… Tap mic to finish");

  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;

    try {
      processor.disconnect();
      source.disconnect();
    } catch {}
    stream.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => {});

    const totalLen = pcmChunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLen < 3200) {
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
      options.onStatus?.("Transcribing locally with Whisper…");
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

  return { stop };
}
