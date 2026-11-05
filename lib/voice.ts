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
 * Conversational Speech Pipeline (applies to every tier):
 *   - Spoken-form text preparation: markdown, URLs, code blocks, emoji, citations and tables are removed or rewritten,
 *     abbreviations are expanded (`e.g.` → "for example"), parentheticals become natural asides, and formal phrasing is
 *     contracted ("do not" → "don't") so the voice reads like a person talking instead of a document being recited.
 *   - Abbreviation/decimal-aware sentence splitting with clause-level breaks for long sentences and a short first chunk
 *     so the first word is heard as quickly as possible.
 *   - Pipelined synthesis: the next chunk is synthesized while the current one plays, so there is no dead air between sentences.
 *   - Human pacing: randomized, punctuation-aware pauses (clause < sentence < question < line < paragraph) scaled by chatbot personality.
 *   - Per-chunk prosody for OS voices (rising pitch on questions, lift on exclamations, slower trailing-off) plus subtle jitter,
 *     and a score-based voice picker that prefers Natural/Neural/Premium voices over legacy robotic ones.
 *   - Mid-speech engine failures resume from the exact sentence that was reached instead of restarting or repeating.
 *   - Session-guarded playback so a new answer or an interruption can never leave an old answer talking in the background.
 *
 * Speech-to-Text (STT) — Persistent Active Recording:
 *   - Requests real microphone permission (`getUserMedia`) first and keeps the session open (`continuous = true` + auto-restart on early browser silence)
 *     so the microphone NEVER shuts off prematurely while you are thinking or pausing between phrases.
 *   - Adaptive end-of-turn detection: waits longer when you trail off mid-thought ("and…", "because…") and answers faster after a finished sentence.
 *   - Automatically falls back to 100% on-device Whisper (`Xenova/whisper-tiny.en` for English, `Xenova/whisper-tiny` for other languages,
 *     16kHz mono WebAudio) if native `SpeechRecognition` is blocked or offline, with hands-free silence detection in that path as well.
 *
 * Optional `ragSettings` keys (read defensively — nothing breaks if they are not in the store yet):
 *   - `voiceConversational` (boolean, default `true`)  — contractions + spoken-form rewriting before speaking.
 *   - `voicePauseScale`     (number,  default `1`)      — multiplies every natural pause (`0.5` brisk · `1.5` relaxed).
 *   - `voiceAutoSend`       (boolean, default `true`)   — auto-submit after you stop talking (otherwise tap the mic).
 *   - `voiceEndOfTurnMs`    (number,  default `2000`)   — base silence window before auto-submit (600–8000).
 */

import { useApp, type ChatbotConfig } from "./store";

export interface PiperVoiceOption {
  id: string;
  label: string;
  language: string;
}

export const PIPER_VOICES: PiperVoiceOption[] = [
  { id: "en_US-hfc_female-medium", label: "Mai Compact: HFC Female (Natural · Default)", language: "English" },
  { id: "en_US-lessac-medium", label: "Mai Compact: Lessac (Warm Expressive Female)", language: "English" },
  { id: "en_US-lessac-high", label: "Mai Compact: Lessac HD (Studio Expressive Female)", language: "English" },
  { id: "en_US-kristin-medium", label: "Mai Compact: Kristin (Warm Female)", language: "English" },
  { id: "en_US-hfc_male-medium", label: "Mai Compact: HFC Male (Natural Male)", language: "English" },
  { id: "en_US-ryan-medium", label: "Mai Compact: Ryan (Clear Studio Male)", language: "English" },
  { id: "en_US-amy-medium", label: "Mai Compact: Amy (Friendly Assistant)", language: "English" },
  { id: "en_GB-alba-medium", label: "Mai Compact: Alba (British Female)", language: "English" },
  { id: "en_GB-jenny_dioco-medium", label: "Mai Compact: Jenny (Natural British)", language: "English" },
  { id: "en_GB-cori-medium", label: "Mai Compact: Cori (British Narrator)", language: "English" },
  { id: "es_ES-sharvard-medium", label: "Mai Compact: Sharvard (Spanish)", language: "Spanish" },
  { id: "fr_FR-upmc-medium", label: "Mai Compact: UPMC (French)", language: "French" },
  { id: "de_DE-thorsten-medium", label: "Mai Compact: Thorsten (German)", language: "German" },
  { id: "pt_BR-faber-medium", label: "Mai Compact: Faber (Portuguese)", language: "Portuguese" },
  { id: "it_IT-riccardo-x_low", label: "Mai Compact: Riccardo (Italian)", language: "Italian" },
  { id: "ar_JO-kareem-medium", label: "Mai Compact: Kareem (Arabic)", language: "Arabic" },
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
  { id: "af_heart", label: "Mai Local: Heart (Warm Female · Default)", accent: "US English" },
  { id: "af_bella", label: "Mai Local: Bella (Expressive Female)", accent: "US English" },
  { id: "af_nicole", label: "Mai Local: Nicole (Calm Professional)", accent: "US English" },
  { id: "af_sarah", label: "Mai Local: Sarah (Conversational)", accent: "US English" },
  { id: "af_nova", label: "Mai Local: Nova (Bright Female)", accent: "US English" },
  { id: "am_adam", label: "Mai Local: Adam (Clear Narrative Male)", accent: "US English" },
  { id: "am_michael", label: "Mai Local: Michael (Deep Conversational Male)", accent: "US English" },
  { id: "am_liam", label: "Mai Local: Liam (Relaxed Male)", accent: "US English" },
  { id: "bf_emma", label: "Mai Local: Emma (Natural British Female)", accent: "UK English" },
  { id: "bf_isabella", label: "Mai Local: Isabella (Refined British Female)", accent: "UK English" },
  { id: "bm_george", label: "Mai Local: George (Measured British Male)", accent: "UK English" },
  { id: "bm_lewis", label: "Mai Local: Lewis (Warm British Male)", accent: "UK English" },
];

export interface ElevenLabsVoiceOption {
  id: string;
  name: string;
  description: string;
  gender: "female" | "male";
}

export const ELEVENLABS_VOICES: ElevenLabsVoiceOption[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Mai Ultra: Rachel", description: "Calm, conversational, narrative", gender: "female" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Mai Ultra: Adam", description: "Deep, natural, narrative", gender: "male" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Mai Ultra: Bella", description: "Warm, engaging, expressive", gender: "female" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Mai Ultra: Josh", description: "Young, natural, conversational", gender: "male" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Mai Ultra: Domi", description: "Strong, energetic, confident", gender: "female" },
  { id: "ErXwobaYiN019PkySvjV", name: "Mai Ultra: Antoni", description: "Modulated, balanced, authoritative", gender: "male" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Mai Ultra: Elli", description: "Bright, youthful, clear", gender: "female" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Mai Ultra: Arnold", description: "Crisp, commanding, professional", gender: "male" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Mai Ultra: Sam", description: "Dynamic, conversational American", gender: "male" },
];

export const ELEVENLABS_MODELS = [
  { id: "eleven_turbo_v2_5", name: "Mai Ultra Turbo (Fastest · ~200ms latency)" },
  { id: "eleven_flash_v2_5", name: "Mai Ultra Flash (Ultra-low latency · Efficient)" },
  { id: "eleven_multilingual_v2", name: "Mai Ultra Global (29 Languages · High quality)" },
];

export async function probeElevenLabsKey(apiKey: string): Promise<{ valid: boolean; error?: string; userTier?: string }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) return { valid: false, error: "Please enter your Mai Ultra Voice API key" };
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": cleanKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { valid: false, error: `Invalid key (${res.status}): ${body.slice(0, 100)}` };
    }
    const data = await res.json();
    return { valid: true, userTier: data?.tier || "active" };
  } catch (e) {
    return { valid: false, error: (e as Error).message || "Network request failed" };
  }
}

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

/* ────────────────────────────────────────────────────────────────────────── *
 * Shared helpers
 * ────────────────────────────────────────────────────────────────────────── */

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Reads an optional voice setting from `ragSettings` without requiring it to exist on the store type,
 * so new tuning knobs can be added to the store later without touching this file.
 */
function readVoiceSetting<T>(key: string, fallback: T): T {
  try {
    const settings = useApp.getState().ragSettings as unknown as Record<string, unknown> | undefined;
    const value = settings?.[key];
    return value === undefined || value === null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return window.AudioContext || (window as any).webkitAudioContext || null;
}

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
 * Chrome/Edge populate `speechSynthesis.getVoices()` asynchronously, so the very first synchronous call is often empty.
 * Resolves with the voice list as soon as the browser announces it (or after `timeoutMs`).
 */
function ensureSystemVoicesLoaded(timeoutMs = 1000): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve([]);
      return;
    }
    const synth = window.speechSynthesis;
    const existing = synth.getVoices() || [];
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      synth.removeEventListener("voiceschanged", finish);
      resolve(synth.getVoices() || []);
    }
    timer = setTimeout(finish, timeoutMs);
    synth.addEventListener("voiceschanged", finish);
  });
}

/** Async variant of `getAvailableSystemVoices()` that waits for the browser to finish loading its voice list. */
export async function loadSystemVoices(): Promise<SystemVoiceOption[]> {
  const raw = await ensureSystemVoicesLoaded();
  return raw.map((v) => ({
    uri: v.voiceURI,
    name: v.name,
    lang: v.lang,
    local: Boolean(v.localService),
  }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Spoken-form text preparation
 * ────────────────────────────────────────────────────────────────────────── */

const EMOJI_PATTERN =
  /[\u2600-\u27BF\u2B50\u2B55\uFE0F\u200D]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF]/g;

const SPOKEN_FORMS: Array<[RegExp, string]> = [
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\betc\.(?=\s+[A-Z]|\s*(?:\n|$))/g, "and so on."],
  [/\betc\b\.?/gi, "and so on"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\.(?=\s)/gi, "approximately"],
  [/\bw\/\s*/g, "with "],
  [/\s&\s/g, " and "],
  [/(\d)\s*%/g, "$1 percent"],
  [/~\s*(?=\d)/g, "about "],
];

const NEGATION_CONTRACTIONS: Record<string, string> = {
  cannot: "can't",
  "can not": "can't",
  "will not": "won't",
  "do not": "don't",
  "does not": "doesn't",
  "did not": "didn't",
  "is not": "isn't",
  "are not": "aren't",
  "was not": "wasn't",
  "were not": "weren't",
  "have not": "haven't",
  "has not": "hasn't",
  "had not": "hadn't",
  "would not": "wouldn't",
  "could not": "couldn't",
  "should not": "shouldn't",
};

const PRONOUN_CONTRACTIONS: Record<string, string> = {
  "i am": "I'm",
  "i will": "I'll",
  "you are": "you're",
  "you will": "you'll",
  "we are": "we're",
  "we will": "we'll",
  "they are": "they're",
  "they will": "they'll",
  "he is": "he's",
  "she is": "she's",
  "it is": "it's",
  "it will": "it'll",
  "that is": "that's",
  "there is": "there's",
  "here is": "here's",
  "what is": "what's",
  "who is": "who's",
  "let us": "let's",
};

function buildPhrasePattern(map: Record<string, string>, lookahead: string): RegExp {
  const keys = Object.keys(map).map((key) => key.replace(/ /g, "\\s+"));
  return new RegExp(`\\b(${keys.join("|")})\\b${lookahead}`, "gi");
}

const NEGATION_PATTERN = buildPhrasePattern(NEGATION_CONTRACTIONS, "");
// Pronoun + verb pairs are only contracted when another word follows ("it is important" → "it's important"),
// so sentence-final uses like "that's what it is." are left alone.
const PRONOUN_PATTERN = buildPhrasePattern(PRONOUN_CONTRACTIONS, "(?=\\s+\\w)");

function applyContractions(text: string): string {
  const swap = (map: Record<string, string>) => (match: string) => {
    const replacement = map[match.toLowerCase().replace(/\s+/g, " ")];
    if (!replacement) return match;
    return /^[A-Z]/.test(match) && /^[a-z]/.test(replacement)
      ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
      : replacement;
  };
  return text
    .replace(NEGATION_PATTERN, swap(NEGATION_CONTRACTIONS))
    .replace(PRONOUN_PATTERN, swap(PRONOUN_CONTRACTIONS));
}

/**
 * Turns a written assistant response into text meant to be heard.
 * Single `\n` marks a line break and `\n\n` a paragraph break (used later for natural pause lengths).
 */
function prepareSpeechText(raw: string): string {
  const conversational = readVoiceSetting<boolean>("voiceConversational", true);
  let text = raw.replace(/\r\n?/g, "\n");

  text = text
    .replace(/```[\s\S]*?```/g, "\nI've put the code on screen.\n")
    .replace(/```[\s\S]*$/g, "\nI've put the code on screen.\n")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\d+(?:\s*[,\-–]\s*\d+)*(?::[^\]]+)?\]/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/<\/?[A-Za-z][^>\n]*>/g, "")
    .replace(/\b(?:https?:\/\/|www\.)[^\s]+?(?=[.,;:!?)]*(?:\s|$))/gi, "a link")
    .replace(EMOJI_PATTERN, "");

  const lines = text.split("\n").map((line) => {
    let l = line.trim();
    if (!l) return "";
    if (/^([-*_])\1{2,}$/.test(l.replace(/\s/g, ""))) return "";
    if (/^\|?[\s:|-]+\|?$/.test(l) && l.includes("-")) return "";
    l = l.replace(/^>+\s?/, "");
    l = l.replace(/^#{1,6}\s+/, "");
    l = l.replace(/^[•▸◦▪‣\-*+]\s+/, "");
    l = l.replace(/^\d+[.)]\s+/, "");
    if (l.includes("|")) {
      l = l
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(", ");
    }
    return l;
  });
  text = lines.join("\n");

  text = text
    .replace(/\*{1,3}([^\s*](?:[^*\n]*[^\s*])?)\*{1,3}/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, "$1$2")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/\*{2,}/g, "")
    // Dashes and parenthetical asides become commas so the voice takes a small breath instead of reading punctuation.
    .replace(/(\d)\s*–\s*(\d)/g, "$1 to $2")
    .replace(/\s*—\s*|\s+–\s+|\s+--\s+/g, ", ")
    .replace(/\s+\(([^()\n]{1,120})\)/g, (_match: string, inner: string) => `, ${inner.replace(/[.!?]+$/, "")},`);

  for (const [pattern, replacement] of SPOKEN_FORMS) {
    text = text.replace(pattern, replacement);
  }
  if (conversational) text = applyContractions(text);

  text = text
    .replace(/,(\s*,)+/g, ",")
    .replace(/,\s*([.!?…])/g, "$1")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/(^|\n)[ \t]*,[ \t]*/g, "$1")
    .replace(/,[ \t]*(?=\n|$)/g, "");

  // Every line ends with sentence punctuation so list items, headings and table rows get a real pause.
  text = text
    .split("\n")
    .map((line) => {
      const l = line.trim();
      if (!l) return "";
      return /[.!?…:;"')\]”’»]$/.test(l) ? l : `${l}.`;
    })
    .join("\n");

  return text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function flattenSpeechText(prepared: string): string {
  return prepared.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Cleans an assistant response before speaking aloud so citation numbers (`[1: Page 3]`),
 * markdown formatting (`**`, `•`, `▸`), links, code, emoji and tables are not read literally by the synthesizer,
 * and rewrites it into natural spoken English (contractions, expanded abbreviations, gentle asides).
 */
export function cleanTextForSpeech(raw: string): string {
  return flattenSpeechText(prepareSpeechText(raw));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Chunk planning (sentence + clause splitting, natural pauses)
 * ────────────────────────────────────────────────────────────────────────── */

type SpeechChunkKind = "statement" | "question" | "exclaim" | "trailing" | "clause";

interface SpeechChunk {
  text: string;
  /** Offset in the planned source string where this chunk ends. */
  end: number;
  kind: SpeechChunkKind;
  lineBreaks: number;
  pauseAfterMs: number;
}

interface ChunkPlanOptions {
  maxChars: number;
  /** Keeps the very first chunk short (split at a comma) so audio starts sooner. */
  firstChunkMaxChars?: number;
}

interface RawSentence {
  text: string;
  start: number;
  end: number;
  breaks: number;
}

const SPEECH_PAUSE_MS = {
  clause: 70,
  statement: 170,
  question: 230,
  exclaim: 190,
  trailing: 330,
  line: 300,
  paragraph: 460,
} as const;

const SPEECH_MIN_PART_CHARS = 24;
const SPEECH_SHORT_CHUNK_CHARS = 24;
const SENTENCE_CLOSERS = "\"')]}”’»";
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "mt", "gen", "rev", "hon", "capt", "lt", "sgt", "col",
]);
const CLAUSE_PUNCTUATION_PATTERN = /[,;:](?=\s)/g;
const CLAUSE_CONJUNCTION_PATTERN = /\s(?=(?:and|but|or|because|which|while|although|though|so)\s)/gi;

function isNonTerminalPeriod(text: string, dotIndex: number): boolean {
  const before = text.slice(Math.max(0, dotIndex - 12), dotIndex);
  const wordMatch = before.match(/([A-Za-z]+)$/);
  if (!wordMatch) return false;
  const word = wordMatch[1];
  if (NON_TERMINAL_ABBREVIATIONS.has(word.toLowerCase())) return true;
  if (word.length === 1 && /[A-Z]/.test(word)) {
    const rest = text.slice(dotIndex + 1).match(/^\s+(\S)/);
    return Boolean(rest && /[A-Z]/.test(rest[1]));
  }
  return false;
}

function splitSentences(text: string): RawSentence[] {
  const sentences: RawSentence[] = [];
  let start = 0;

  const pushSentence = (endExclusive: number, breaks: number, resumeAt: number) => {
    const raw = text.slice(start, endExclusive);
    const trimmed = raw.trim();
    if (trimmed) {
      sentences.push({ text: trimmed, start: start + Math.max(0, raw.search(/\S/)), end: endExclusive, breaks });
    } else if (breaks > 0 && sentences.length > 0) {
      const last = sentences[sentences.length - 1];
      last.breaks = Math.max(last.breaks, breaks);
    }
    start = resumeAt;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      const newlines = (text.slice(i, j).match(/\n/g) || []).length;
      pushSentence(i, newlines, j);
      i = j;
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
      let j = i;
      while (j + 1 < text.length && ".!?…".includes(text[j + 1])) j++;
      while (j + 1 < text.length && SENTENCE_CLOSERS.includes(text[j + 1])) j++;
      const next = text[j + 1];
      const atBoundary = next === undefined || /\s/.test(next);
      if (atBoundary && !(ch === "." && j === i && isNonTerminalPeriod(text, i))) {
        pushSentence(j + 1, 0, j + 1);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  pushSentence(text.length, 0, text.length);
  return sentences;
}

function pickClauseCut(text: string, from: number, to: number, allowHardSplit: boolean): number {
  const middle = (from + to) / 2;
  const sources: Array<{ pattern: RegExp; after: boolean }> = [
    { pattern: CLAUSE_PUNCTUATION_PATTERN, after: true },
    { pattern: CLAUSE_CONJUNCTION_PATTERN, after: false },
  ];
  for (const { pattern, after } of sources) {
    let best = -1;
    let bestDistance = Infinity;
    pattern.lastIndex = from;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index >= to) break;
      const cut = after ? match.index + 1 : match.index;
      if (cut - from < SPEECH_MIN_PART_CHARS || to - cut < SPEECH_MIN_PART_CHARS) continue;
      const distance = Math.abs(cut - middle);
      if (distance < bestDistance) {
        best = cut;
        bestDistance = distance;
      }
    }
    if (best !== -1) return best;
  }
  if (!allowHardSplit) return -1;
  const space = text.lastIndexOf(" ", Math.floor(middle));
  return space > from + SPEECH_MIN_PART_CHARS ? space : -1;
}

function findClauseCuts(text: string, from: number, to: number, maxChars: number, cuts: number[]): void {
  if (to - from <= maxChars) {
    cuts.push(to);
    return;
  }
  const cut = pickClauseCut(text, from, to, true);
  if (cut === -1) {
    cuts.push(to);
    return;
  }
  findClauseCuts(text, from, cut, maxChars, cuts);
  findClauseCuts(text, cut, to, maxChars, cuts);
}

/** Last comma/semicolon/colon that still fits inside `maxHead`, so the first chunk can start playing early. */
function pickHeadCut(text: string, maxHead: number): number {
  let best = -1;
  CLAUSE_PUNCTUATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLAUSE_PUNCTUATION_PATTERN.exec(text)) !== null) {
    const cut = match.index + 1;
    if (cut > maxHead) break;
    if (cut >= SPEECH_MIN_PART_CHARS + 11) best = cut;
  }
  return best;
}

function classifySentence(text: string): SpeechChunkKind {
  if (/\?["')\]”’]*$/.test(text)) return "question";
  if (/!["')\]”’]*$/.test(text)) return "exclaim";
  if (/(…|\.{3})["')\]”’]*$/.test(text)) return "trailing";
  return "statement";
}

function resolveSentencePause(kind: SpeechChunkKind, breaks: number): number {
  let base: number = SPEECH_PAUSE_MS[kind === "clause" ? "clause" : kind];
  if (breaks >= 2) base = Math.max(base, SPEECH_PAUSE_MS.paragraph);
  else if (breaks === 1) base = Math.max(base, SPEECH_PAUSE_MS.line);
  // ±20% jitter keeps the rhythm from sounding metronomic.
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function mergeShortChunks(chunks: SpeechChunk[], maxChars: number): SpeechChunk[] {
  const merged: SpeechChunk[] = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind !== "clause" &&
      prev.lineBreaks === 0 &&
      prev.text.length < SPEECH_SHORT_CHUNK_CHARS &&
      prev.text.length + 1 + chunk.text.length <= maxChars
    ) {
      merged[merged.length - 1] = {
        text: `${prev.text} ${chunk.text}`,
        end: chunk.end,
        kind: chunk.kind,
        lineBreaks: chunk.lineBreaks,
        pauseAfterMs: chunk.pauseAfterMs,
      };
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

function planSpeechChunks(text: string, options: ChunkPlanOptions): SpeechChunk[] {
  const sentences = splitSentences(text);
  const chunks: SpeechChunk[] = [];

  for (const sentence of sentences) {
    const s = sentence.text;
    const cuts: number[] = [];
    let from = 0;

    if (chunks.length === 0 && options.firstChunkMaxChars && s.length > options.firstChunkMaxChars) {
      const head = pickHeadCut(s, options.firstChunkMaxChars);
      if (head > 0) {
        cuts.push(head);
        from = head;
      }
    }
    findClauseCuts(s, from, s.length, options.maxChars, cuts);

    let previousCut = 0;
    cuts.forEach((cut, index) => {
      const piece = s.slice(previousCut, cut).trim();
      previousCut = cut;
      if (!piece) return;
      const isLast = index === cuts.length - 1;
      const kind: SpeechChunkKind = isLast ? classifySentence(piece) : "clause";
      chunks.push({
        text: piece,
        end: isLast ? sentence.end : sentence.start + cut,
        kind,
        lineBreaks: isLast ? sentence.breaks : 0,
        pauseAfterMs: isLast ? resolveSentencePause(kind, sentence.breaks) : resolveSentencePause("clause", 0),
      });
    });
  }
  return mergeShortChunks(chunks, options.maxChars);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Speech sessions + playback
 * ────────────────────────────────────────────────────────────────────────── */

interface SpeechSession {
  id: number;
  /** Prepared text (with line/paragraph markers) this session is speaking. */
  text: string;
  /** Offset into `text` that has been fully spoken so far. */
  spokenOffset: number;
  aborted: boolean;
  /** True when a newer `speakAnswer` call replaced this one (its callbacks must go quiet). */
  superseded: boolean;
  started: boolean;
  /** Callbacks that instantly unblock anything this session is waiting on (audio, pauses, utterances). */
  wakers: Set<() => void>;
}

interface SpeechEngineContext {
  session: SpeechSession;
  chatbot: ChatbotConfig;
  /** Offset of the text handed to the engine inside `session.text`. */
  baseOffset: number;
  notifyStart: () => void;
  onStatus?: (msg: string) => void;
}

type SpeechEngineRunner = (text: string, ctx: SpeechEngineContext) => Promise<boolean>;

let activeSession: SpeechSession | null = null;
let speechSessionCounter = 0;
let activeAudioElement: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let currentSpokenText = "";

export function stopSpeaking(): string {
  const interrupted = currentSpokenText;
  currentSpokenText = "";
  if (activeSession && !activeSession.aborted) {
    activeSession.aborted = true;
    const wakers = Array.from(activeSession.wakers);
    activeSession.wakers.clear();
    wakers.forEach((wake) => {
      try {
        wake();
      } catch { }
    });
  }
  if (activeAudioElement) {
    try {
      activeAudioElement.pause();
      activeAudioElement.src = "";
    } catch { }
    activeAudioElement = null;
  }
  if (activeAudioUrl) {
    try {
      URL.revokeObjectURL(activeAudioUrl);
    } catch { }
    activeAudioUrl = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch { }
  }
  return interrupted;
}

/**
 * Returns what was already spoken and what was left unsaid for the current (or most recently interrupted) answer.
 * Call it right after `stopSpeaking()` to give the model accurate "you were cut off here" context.
 */
export function getSpeechProgress(): { spoken: string; remaining: string } {
  const session = activeSession;
  if (!session) return { spoken: "", remaining: "" };
  return {
    spoken: flattenSpeechText(session.text.slice(0, session.spokenOffset)),
    remaining: flattenSpeechText(session.text.slice(session.spokenOffset)),
  };
}

function beginSpeechSession(text: string): SpeechSession {
  if (activeSession) activeSession.superseded = true;
  const session: SpeechSession = {
    id: ++speechSessionCounter,
    text,
    spokenOffset: 0,
    aborted: false,
    superseded: false,
    started: false,
    wakers: new Set(),
  };
  activeSession = session;
  return session;
}

function keepPitchOnRateChange(audio: HTMLAudioElement): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const media = audio as any;
  if ("preservesPitch" in media) media.preservesPitch = true;
  if ("webkitPreservesPitch" in media) media.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in media) media.mozPreservesPitch = true;
}

function playAudioBlob(session: SpeechSession, blob: Blob, playbackRate = 1.0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (session.aborted) {
      resolve();
      return;
    }
    const url = URL.createObjectURL(blob);
    activeAudioUrl = url;
    const audio = new Audio(url);
    keepPitchOnRateChange(audio);
    audio.playbackRate = clampNumber(playbackRate || 1.0, 0.6, 1.6);
    activeAudioElement = audio;

    let settled = false;
    function settle(error?: Error) {
      if (settled) return;
      settled = true;
      session.wakers.delete(wake);
      audio.onended = null;
      audio.onerror = null;
      if (activeAudioUrl === url) {
        try {
          URL.revokeObjectURL(url);
        } catch { }
        activeAudioUrl = null;
      }
      if (activeAudioElement === audio) activeAudioElement = null;
      if (error) reject(error);
      else resolve();
    }
    function wake() {
      try {
        audio.pause();
      } catch { }
      settle();
    }

    session.wakers.add(wake);
    audio.onended = () => settle();
    audio.onerror = () => settle(new Error("Audio playback failed"));
    audio.play().catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
  });
}

/** Sleeps for a natural pause, but wakes immediately if the session is stopped. */
function waitForPause(session: SpeechSession, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (session.aborted || ms <= 0) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    function wake() {
      if (timer) clearTimeout(timer);
      session.wakers.delete(wake);
      resolve();
    }
    timer = setTimeout(wake, ms);
    session.wakers.add(wake);
  });
}

// Synthesis runs one job at a time: ONNX sessions (Kokoro) can't safely run concurrently, and a stale job from an
// interrupted answer must never overlap with the first job of the next one.
let synthesisQueue: Promise<unknown> = Promise.resolve();

function enqueueSynthesis<T>(task: () => Promise<T>): Promise<T> {
  const run = synthesisQueue.then(task);
  synthesisQueue = run.catch(() => undefined);
  return run;
}

interface ChunkedPlaybackOptions {
  baseOffset: number;
  maxChars: number;
  firstChunkMaxChars?: number;
  playbackRate: number;
  pauseScale: number;
  synthesize: (chunk: SpeechChunk, index: number) => Promise<Blob | null>;
  onFirstAudio: () => void;
}

/**
 * Plays audio chunks back-to-back with the NEXT chunk already synthesizing while the current one plays,
 * separated by punctuation-aware pauses. Resolves `true` when everything was spoken (or the session was stopped)
 * and `false` if synthesis/playback failed part-way — `session.spokenOffset` then says exactly where to resume.
 */
async function playSynthesizedChunks(
  session: SpeechSession,
  text: string,
  options: ChunkedPlaybackOptions
): Promise<boolean> {
  const chunks = planSpeechChunks(text, { maxChars: options.maxChars, firstChunkMaxChars: options.firstChunkMaxChars });
  if (chunks.length === 0) return true;

  const request = (index: number): Promise<{ blob: Blob | null }> =>
    options.synthesize(chunks[index], index).then(
      (blob) => ({ blob }),
      (error) => {
        console.warn("Speech synthesis failed for a chunk:", error);
        return { blob: null };
      }
    );

  let upcoming = request(0);
  let firstAudioSent = false;

  for (let i = 0; i < chunks.length; i++) {
    const current = await upcoming;
    if (session.aborted) return true;
    if (!current.blob) return false;
    if (i + 1 < chunks.length) upcoming = request(i + 1);

    if (!firstAudioSent) {
      firstAudioSent = true;
      options.onFirstAudio();
    }

    try {
      await playAudioBlob(session, current.blob, options.playbackRate);
    } catch (error) {
      console.warn("Audio chunk playback failed:", error);
      return false;
    }
    if (session.aborted) return true;
    session.spokenOffset = options.baseOffset + chunks[i].end;

    if (i < chunks.length - 1) {
      await waitForPause(session, (chunks[i].pauseAfterMs * options.pauseScale) / (options.playbackRate || 1));
    }
  }
  return true;
}

function getPersonalityProsody(chatbot: ChatbotConfig, baseRate: number, basePitch: number) {
  if (chatbot.personality === "concise") {
    return { rate: Math.min(1.6, baseRate * 1.05), pitch: basePitch };
  }
  if (chatbot.personality === "friendly") {
    return { rate: baseRate, pitch: Math.min(1.4, basePitch * 1.03) };
  }
  if (chatbot.personality === "academic") {
    return { rate: Math.max(0.6, baseRate * 0.96), pitch: basePitch };
  }
  return { rate: baseRate, pitch: basePitch };
}

function getPauseScale(chatbot: ChatbotConfig): number {
  let scale = 1;
  if (chatbot.personality === "concise") scale = 0.85;
  else if (chatbot.personality === "friendly") scale = 1.05;
  else if (chatbot.personality === "academic") scale = 1.15;
  const userScale = Number(readVoiceSetting<number>("voicePauseScale", 1));
  return scale * clampNumber(Number.isFinite(userScale) ? userScale : 1, 0.3, 2.5);
}

function resolvePiperVoiceId(chatbot: ChatbotConfig) {
  const { ragSettings } = useApp.getState();
  // Select configured Piper voice or auto-match the chatbot's response language
  let voiceId = ragSettings.piperVoiceId || "en_US-hfc_female-medium";
  if (chatbot.language !== "English" && voiceId.startsWith("en_")) {
    voiceId = DEFAULT_PIPER_BY_LANG[chatbot.language] || voiceId;
  }
  return voiceId;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tier 1 — Piper
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Tier 1: Piper Neural TTS (`@mintplex-labs/piper-tts-web`).
 * Runs in a dedicated Web Worker, caches ONNX voice models inside OPFS, and streams chunk-by-chunk with the next chunk
 * synthesizing while the current one plays.
 */
async function speakViaPiper(cleanText: string, ctx: SpeechEngineContext): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const { session, chatbot, onStatus } = ctx;
  try {
    const piper = await import("@mintplex-labs/piper-tts-web");
    // Ensure Piper doesn't hit broken cdnjs 1.18.0 404 URL
    if ((piper as any).TtsSession?.WASM_LOCATIONS) {
      (piper as any).TtsSession.WASM_LOCATIONS.onnxWasm = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
    }
    const { ragSettings } = useApp.getState();
    const speed = ragSettings.voiceSpeed || 1.0;
    const voiceId = resolvePiperVoiceId(chatbot);
    let audible = false;

    return await playSynthesizedChunks(session, cleanText, {
      baseOffset: ctx.baseOffset,
      maxChars: 240,
      firstChunkMaxChars: 130,
      playbackRate: speed,
      pauseScale: getPauseScale(chatbot),
      synthesize: (chunk, index) =>
        enqueueSynthesis(async () => {
          if (session.aborted) return null;
          if (index === 0) onStatus?.(`Synthesizing with Piper Neural TTS (${voiceId})…`);
          return piper.predict(
            {
              text: chunk.text,
              voiceId,
            },
            (prog) => {
              if (!audible && prog.total > 0) {
                const pct = Math.round((prog.loaded * 100) / prog.total);
                onStatus?.(`Caching Piper neural voice in OPFS (${pct}%)…`);
              }
            }
          );
        }),
      onFirstAudio: () => {
        audible = true;
        onStatus?.("");
        ctx.notifyStart();
      },
    });
  } catch (e) {
    console.warn("Piper TTS synthesis failed, gracefully falling back:", e);
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tier 2 — Voicebox.sh
 * ────────────────────────────────────────────────────────────────────────── */

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

async function synthesizeVoiceboxChunk(
  baseUrl: string,
  text: string,
  langIso: string,
  profileId?: string
): Promise<Blob | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const bodyPayload: Record<string, string> = {
      text,
      language: langIso,
    };
    if (profileId) {
      bodyPayload.profile_id = profileId;
    }

    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("audio/") || contentType.includes("octet-stream")) {
      return await res.blob();
    }

    const json = await res.json();
    if (json?.audio_url || json?.file_url || json?.path) {
      const audioRes = await fetch(
        String(json.audio_url || json.file_url || `${baseUrl}/audio?path=${encodeURIComponent(json.path)}`),
        { signal: ctrl.signal }
      );
      if (audioRes.ok) return await audioRes.blob();
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function speakViaVoicebox(cleanText: string, ctx: SpeechEngineContext): Promise<boolean> {
  const { session, chatbot, onStatus } = ctx;
  const { ragSettings } = useApp.getState();
  const baseUrl = (ragSettings.voiceboxUrl || "http://127.0.0.1:17493").replace(/\/+$/, "");
  const langIso = LANG_ISO[chatbot.language] || "en";
  const rate = ragSettings.voiceSpeed || 1.0;
  const profileId = ragSettings.voiceboxProfileId || undefined;

  onStatus?.("Connecting to local Voicebox studio…");
  try {
    return await playSynthesizedChunks(session, cleanText, {
      baseOffset: ctx.baseOffset,
      // Larger chunks keep cloned-voice prosody coherent across a whole thought.
      maxChars: 420,
      firstChunkMaxChars: 160,
      playbackRate: rate,
      pauseScale: getPauseScale(chatbot) * 0.8,
      synthesize: (chunk) =>
        enqueueSynthesis(async () => {
          if (session.aborted) return null;
          return synthesizeVoiceboxChunk(baseUrl, chunk.text, langIso, profileId);
        }),
      onFirstAudio: () => {
        onStatus?.("");
        ctx.notifyStart();
      },
    });
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tier 3 — Kokoro-82M
 * ────────────────────────────────────────────────────────────────────────── */

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kokoroResultToBlob(audioResult: any): Blob {
  return typeof audioResult?.toBlob === "function"
    ? audioResult.toBlob()
    : new Blob([audioResult?.toWav?.() ?? new Uint8Array()], { type: "audio/wav" });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tier: ElevenLabs Ultra-Realistic Cloud TTS API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Speaks via ElevenLabs Cloud TTS API.
 * Uses ultra-low-latency streaming endpoint with sentence-by-sentence pipelined playback.
 */
async function speakViaElevenLabs(cleanText: string, ctx: SpeechEngineContext): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const { session, chatbot, onStatus } = ctx;
  const { ragSettings } = useApp.getState();
  const apiKey = (ragSettings.elevenLabsApiKey || "").trim();
  if (!apiKey) {
    onStatus?.("Mai Ultra Voice key not set — falling back to Mai Local Voice…");
    return false;
  }

  const voiceId = (ragSettings.elevenLabsVoiceId || "21m00Tcm4TlvDq8ikWAM").trim();
  const modelId = (ragSettings.elevenLabsModelId || "eleven_turbo_v2_5").trim();
  const speed = ragSettings.voiceSpeed || 1.0;
  let audible = false;

  try {
    return await playSynthesizedChunks(session, cleanText, {
      baseOffset: ctx.baseOffset,
      maxChars: 280,
      firstChunkMaxChars: 120,
      playbackRate: speed,
      pauseScale: getPauseScale(chatbot),
      synthesize: (chunk, index) =>
        enqueueSynthesis(async () => {
          if (session.aborted) return null;
          if (index === 0) onStatus?.("Synthesizing voice with Mai Ultra…");

          const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=3`,
            {
              method: "POST",
              headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text: chunk.text,
                model_id: modelId,
                voice_settings: {
                  stability: 0.5,
                  similarity_boost: 0.75,
                  style: 0.0,
                  use_speaker_boost: true,
                },
              }),
            }
          );

          if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            console.warn(`ElevenLabs API error (${response.status}):`, errBody);
            throw new Error(`ElevenLabs error ${response.status}: ${errBody.slice(0, 100)}`);
          }

          return await response.blob();
        }),
      onFirstAudio: () => {
        audible = true;
        onStatus?.("");
        ctx.notifyStart();
      },
    });
  } catch (err) {
    console.warn("ElevenLabs synthesis failed, falling back to local voice:", err);
    return false;
  }
}

async function speakViaKokoro(cleanText: string, ctx: SpeechEngineContext): Promise<boolean> {
  const { session, chatbot, onStatus } = ctx;
  // Kokoro v1.0 ships English voices only; other languages are handed to Piper, which has native voices for them.
  if (chatbot.language !== "English") return false;

  const tts = await getKokoroTts(onStatus);
  if (session.aborted) return true;
  if (!tts) return false;

  const { ragSettings } = useApp.getState();
  const voiceId = ragSettings.kokoroVoiceId || "af_heart";
  const speed = ragSettings.voiceSpeed || 1.0;

  return playSynthesizedChunks(session, cleanText, {
    baseOffset: ctx.baseOffset,
    maxChars: 240,
    firstChunkMaxChars: 120,
    // Kokoro clips already carry a little trailing silence, so its pauses are trimmed.
    playbackRate: 1.0,
    pauseScale: getPauseScale(chatbot) * 0.8,
    synthesize: (chunk, index) =>
      enqueueSynthesis(async () => {
        if (session.aborted) return null;
        onStatus?.(index === 0 ? "Synthesizing voice with Mai Local…" : "Speaking with Mai Local Voice…");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const audioResult: any = await tts.generate(chunk.text, { voice: voiceId, speed });
        return kokoroResultToBlob(audioResult);
      }),
    onFirstAudio: () => {
      onStatus?.("Speaking with Mai Local Voice…");
      ctx.notifyStart();
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tier 4 — OS System Speech
 * ────────────────────────────────────────────────────────────────────────── */

const ROBOTIC_VOICE_PATTERN =
  /espeak|compact|eloquence|\bfred\b|\bralph\b|\bkathy\b|\bjunior\b|albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|organ|princess|trinoids|whisper|zarvox/i;

function scoreSystemVoice(voice: SpeechSynthesisVoice, targetLang: string): number {
  const name = voice.name;
  let score = 0;
  if (/natural/i.test(name)) score += 100;
  else if (/neural/i.test(name)) score += 90;
  if (/premium|enhanced/i.test(name)) score += 70;
  if (/siri/i.test(name)) score += 60;
  if (/google/i.test(name)) score += 40;
  if (voice.lang.replace("_", "-").toLowerCase() === targetLang.toLowerCase()) score += 15;
  if (voice.localService) score += 5;
  if (ROBOTIC_VOICE_PATTERN.test(name) || /\bdesktop\b/i.test(name)) score -= 80;
  return score;
}

function shapeUtteranceProsody(kind: SpeechChunkKind, rate: number, pitch: number) {
  let r = rate;
  let p = pitch;
  switch (kind) {
    case "question":
      p *= 1.06;
      r *= 0.98;
      break;
    case "exclaim":
      p *= 1.05;
      r *= 1.04;
      break;
    case "trailing":
      r *= 0.94;
      break;
    case "clause":
      p *= 1.01;
      break;
    default:
      break;
  }
  // Subtle jitter (±3% rate, ±2% pitch) so repeated sentences never sound stamped from the same mold.
  r *= 1 + (Math.random() - 0.5) * 0.06;
  p *= 1 + (Math.random() - 0.5) * 0.04;
  return { rate: clampNumber(r, 0.6, 1.6), pitch: clampNumber(p, 0.7, 1.4) };
}

function speakUtterance(session: SpeechSession, utter: SpeechSynthesisUtterance, watchdogMs: number): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    function finish() {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      session.wakers.delete(wake);
      resolve();
    }
    function wake() {
      try {
        synth.cancel();
      } catch { }
      finish();
    }

    session.wakers.add(wake);
    // Some OS voices never fire `onend`; the watchdog guarantees the queue keeps moving.
    watchdog = setTimeout(wake, watchdogMs);
    utter.onend = () => finish();
    utter.onerror = () => finish();
    try {
      synth.speak(utter);
    } catch {
      finish();
    }
  });
}

/**
 * Tier 4: OS speech. Speaks short chunks one at a time (long single utterances get cut off by Chrome after ~15s),
 * shaping pitch/rate per chunk and picking the most natural-sounding installed voice.
 */
async function speakViaBrowserSynthesis(cleanText: string, ctx: SpeechEngineContext): Promise<boolean> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return true;
  const { session, chatbot } = ctx;
  const { ragSettings } = useApp.getState();

  const targetLang = LANG_BCP47[chatbot.language] || "en-US";
  const baseRate = ragSettings.voiceSpeed || 1.0;
  const basePitch = ragSettings.voicePitch || 1.0;
  const prosody = getPersonalityProsody(chatbot, baseRate, basePitch);

  const voices = await ensureSystemVoicesLoaded();
  if (session.aborted) return true;

  const customVoice = ragSettings.systemVoiceURI
    ? voices.find((v) => v.voiceURI === ragSettings.systemVoiceURI)
    : undefined;

  let chosenVoice: SpeechSynthesisVoice | undefined = customVoice;
  if (!chosenVoice) {
    const langPrefix = targetLang.slice(0, 2).toLowerCase();
    const matchingVoices = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(langPrefix));
    chosenVoice = matchingVoices
      .slice()
      .sort((a, b) => scoreSystemVoice(b, targetLang) - scoreSystemVoice(a, targetLang))[0];
  }

  const chunks = planSpeechChunks(cleanText, { maxChars: 160, firstChunkMaxChars: 110 });
  const pauseScale = getPauseScale(chatbot) * 0.85;

  for (let i = 0; i < chunks.length; i++) {
    if (session.aborted) return true;
    const chunk = chunks[i];
    const utter = new SpeechSynthesisUtterance(chunk.text);
    utter.lang = chosenVoice ? chosenVoice.lang : targetLang;
    if (chosenVoice) utter.voice = chosenVoice;

    const shaped = shapeUtteranceProsody(chunk.kind, prosody.rate, prosody.pitch);
    utter.rate = shaped.rate;
    utter.pitch = shaped.pitch;
    utter.onstart = () => ctx.notifyStart();

    const watchdogMs = Math.round((chunk.text.length * 120) / shaped.rate) + 4000;
    await speakUtterance(session, utter, watchdogMs);
    if (session.aborted) return true;
    ctx.notifyStart();
    session.spokenOffset = ctx.baseOffset + chunk.end;

    if (i < chunks.length - 1) {
      await waitForPause(session, (chunk.pauseAfterMs * pauseScale) / shaped.rate);
    }
  }
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public speaking API
 * ────────────────────────────────────────────────────────────────────────── */

function buildEngineChain(engineMode: string): SpeechEngineRunner[] {
  const { ragSettings } = useApp.getState();
  const hasElevenLabs = Boolean((ragSettings.elevenLabsApiKey || "").trim());

  switch (engineMode) {
    case "elevenlabs":
      return [speakViaElevenLabs, speakViaKokoro, speakViaPiper, speakViaBrowserSynthesis];
    case "voicebox":
      return [speakViaVoicebox, speakViaKokoro, speakViaPiper, speakViaBrowserSynthesis];
    case "kokoro":
      return [speakViaKokoro, speakViaElevenLabs, speakViaPiper, speakViaBrowserSynthesis];
    case "piper":
      return [speakViaPiper, speakViaKokoro, speakViaBrowserSynthesis];
    case "browser":
      return [speakViaBrowserSynthesis];
    case "auto":
    default:
      return hasElevenLabs
        ? [speakViaElevenLabs, speakViaKokoro, speakViaPiper, speakViaBrowserSynthesis]
        : [speakViaKokoro, speakViaPiper, speakViaBrowserSynthesis];
  }
}

/**
 * Speaks an assistant response using the configured voice pipeline:
 * - `piper` (or `auto`): Runs Piper Neural TTS (`@mintplex-labs/piper-tts-web`) cached in OPFS.
 * - `voicebox`: Connects to local Voicebox.sh studio (`http://127.0.0.1:17493`).
 * - `kokoro`: Runs Kokoro-82M Neural ONNX in-browser.
 * - `browser`: Instant OS Speech Synthesis fallback.
 *
 * If an engine fails part-way, the next engine in the chain continues from the exact sentence that was reached.
 * `onEnd` fires once when the answer finishes or is stopped (it stays silent if a newer `speakAnswer` call replaced it).
 */
export async function speakAnswer(
  text: string,
  chatbot: ChatbotConfig,
  callbacks?: { onStart?: () => void; onEnd?: () => void; onStatus?: (msg: string) => void }
): Promise<void> {
  stopSpeaking();

  const prepared = prepareSpeechText(text);
  const clean = flattenSpeechText(prepared);
  if (!clean) {
    callbacks?.onEnd?.();
    return;
  }

  const session = beginSpeechSession(prepared);
  currentSpokenText = clean;

  const notifyStart = () => {
    if (session.started || session.aborted) return;
    session.started = true;
    callbacks?.onStart?.();
  };
  const onStatus = (msg: string) => {
    if (!session.aborted) callbacks?.onStatus?.(msg);
  };

  const { ragSettings } = useApp.getState();
  const engineMode: string = ragSettings.voiceEngine || "piper";
  const chain = buildEngineChain(engineMode);

  try {
    for (const run of chain) {
      if (session.aborted) break;
      const remaining = prepared.slice(session.spokenOffset);
      if (!remaining.trim()) break;

      let completed = false;
      try {
        completed = await run(remaining, {
          session,
          chatbot,
          baseOffset: session.spokenOffset,
          notifyStart,
          onStatus,
        });
      } catch (error) {
        console.warn("Speech engine failed, trying the next tier:", error);
      }
      if (completed) break;
    }
  } finally {
    if (!session.superseded) {
      callbacks?.onStatus?.("");
      if (!session.aborted && activeSession === session) {
        currentSpokenText = "";
        activeSession = null;
      }
      callbacks?.onEnd?.();
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Live Streaming Speech Dispatch (Real-Time Pipelined Speech)
 * ────────────────────────────────────────────────────────────────────────── */

async function synthesizeAudioChunk(
  text: string,
  chatbot: ChatbotConfig,
  onStatus?: (msg: string) => void
): Promise<Blob | null> {
  const { ragSettings } = useApp.getState();
  const engine = ragSettings.voiceEngine || "kokoro";

  // Tier 1: ElevenLabs Ultra-Low Latency (~200ms)
  if (engine === "elevenlabs" || (engine === "auto" && ragSettings.elevenLabsApiKey?.trim())) {
    const apiKey = (ragSettings.elevenLabsApiKey || "").trim();
    if (apiKey) {
      try {
        const voiceId = (ragSettings.elevenLabsVoiceId || "21m00Tcm4TlvDq8ikWAM").trim();
        const modelId = (ragSettings.elevenLabsModelId || "eleven_turbo_v2_5").trim();
        onStatus?.("Synthesizing voice with Mai Ultra…");
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=3`,
          {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text,
              model_id: modelId,
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.0,
                use_speaker_boost: true,
              },
            }),
          }
        );
        if (response.ok) {
          return await response.blob();
        }
      } catch (e) {
        console.warn("ElevenLabs live chunk synthesis error:", e);
      }
    }
  }

  // Tier 2: Kokoro-82M (English)
  if ((engine === "kokoro" || engine === "auto" || engine === "piper") && chatbot.language === "English") {
    try {
      const tts = await getKokoroTts(onStatus);
      if (tts) {
        const voiceId = ragSettings.kokoroVoiceId || "af_heart";
        const speed = ragSettings.voiceSpeed || 1.0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await tts.generate(text, { voice: voiceId, speed });
        return kokoroResultToBlob(result);
      }
    } catch (e) {
      console.warn("Kokoro chunk synthesis error:", e);
    }
  }

  // Tier 3: Piper Neural TTS
  if (engine === "piper" || engine === "auto") {
    try {
      const piper = await import("@mintplex-labs/piper-tts-web");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((piper as any).TtsSession?.WASM_LOCATIONS) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (piper as any).TtsSession.WASM_LOCATIONS.onnxWasm = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
      }
      const voiceId = resolvePiperVoiceId(chatbot);
      return await piper.predict({ text, voiceId });
    } catch (e) {
      console.warn("Piper chunk synthesis error:", e);
    }
  }

  return null;
}

export interface StreamingSpeakerHandle {
  feed: (partialText: string) => void;
  finish: (finalText?: string) => Promise<void>;
  cancel: () => void;
}

/**
 * Creates a real-time streaming speech speaker:
 * Dispatches early sentences (4-8 words) directly to the voice engine the moment
 * the LLM emits them, cutting first-audio latency from 15 seconds to under 1 second.
 */
export function createStreamingSpeaker(
  chatbot: ChatbotConfig,
  callbacks?: { onStart?: () => void; onEnd?: () => void; onStatus?: (msg: string) => void }
): StreamingSpeakerHandle {
  stopSpeaking();

  const session = beginSpeechSession("");
  const { ragSettings } = useApp.getState();
  const speed = ragSettings.voiceSpeed || 1.0;
  const pauseScale = getPauseScale(chatbot);

  let streamBuffer = "";
  let processedCut = 0;
  const textQueue: string[] = [];
  let isProcessing = false;
  let finishedFeeding = false;
  let resolveFinish: (() => void) | null = null;

  const notifyStart = () => {
    if (session.started || session.aborted) return;
    session.started = true;
    callbacks?.onStart?.();
  };

  const onStatus = (msg: string) => {
    if (!session.aborted) callbacks?.onStatus?.(msg);
  };

  async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    while (textQueue.length > 0) {
      if (session.aborted) break;
      const rawChunk = textQueue.shift()!;
      const clean = cleanTextForSpeech(rawChunk);
      if (!clean) continue;

      currentSpokenText += (currentSpokenText ? " " : "") + clean;

      let played = false;
      try {
        const blob = await synthesizeAudioChunk(clean, chatbot, onStatus);
        if (session.aborted) break;
        if (blob) {
          notifyStart();
          onStatus("");
          await playAudioBlob(session, blob, speed);
          played = true;
        }
      } catch (err) {
        console.warn("Streaming audio chunk playback failed:", err);
      }

      if (!played && !session.aborted && typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          const utter = new SpeechSynthesisUtterance(clean);
          utter.lang = LANG_BCP47[chatbot.language] || "en-US";
          utter.rate = speed;
          notifyStart();
          await speakUtterance(session, utter, Math.round(clean.length * 150) + 3000);
          played = true;
        } catch { }
      }

      if (session.aborted) break;
      await waitForPause(session, Math.round(140 * pauseScale));
    }

    isProcessing = false;
    if (finishedFeeding && textQueue.length === 0) {
      if (!session.superseded && !session.aborted) {
        currentSpokenText = "";
        activeSession = null;
        callbacks?.onEnd?.();
      }
      resolveFinish?.();
    }
  }

  function feed(partialText: string) {
    if (session.aborted) return;
    streamBuffer = partialText;

    const remaining = streamBuffer.slice(processedCut);
    if (!remaining) return;

    // First chunk can be eager (~20 chars) so the assistant begins talking almost instantly
    const minLen = processedCut === 0 ? 18 : 55;

    // Look for sentence boundaries (., ?, !, \n) or clause boundaries (,, ;, :)
    const match = remaining.match(/([.!?\n]+|[,;:](?=\s))/);
    if (match && match.index !== undefined) {
      const cutEnd = match.index + match[0].length;
      if (cutEnd >= minLen || match[0].includes("\n") || remaining.length > 130) {
        const chunk = remaining.slice(0, cutEnd);
        processedCut += cutEnd;
        if (chunk.trim()) {
          textQueue.push(chunk);
          void processQueue();
        }
      }
    }
  }

  async function finish(finalText?: string): Promise<void> {
    if (session.aborted) return;
    finishedFeeding = true;
    if (finalText) streamBuffer = finalText;

    const tail = streamBuffer.slice(processedCut).trim();
    if (tail) {
      processedCut = streamBuffer.length;
      textQueue.push(tail);
      void processQueue();
    }

    if (!isProcessing && textQueue.length === 0) {
      if (!session.superseded && !session.aborted) {
        currentSpokenText = "";
        activeSession = null;
        callbacks?.onEnd?.();
      }
      return;
    }

    return new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
  }

  function cancel() {
    session.aborted = true;
    textQueue.length = 0;
    stopSpeaking();
    resolveFinish?.();
  }

  return { feed, finish, cancel };
}

/**
 * Optional: call once when the chat opens or the mic is tapped so the FIRST spoken word of the first answer is instant
 * (loads the Piper voice / Kokoro model / OS voice list ahead of time).
 */
export async function warmUpVoiceEngine(
  chatbot: ChatbotConfig,
  onStatus?: (msg: string) => void
): Promise<void> {
  if (typeof window === "undefined") return;
  const engineMode: string = useApp.getState().ragSettings.voiceEngine || "piper";
  try {
    if (engineMode === "elevenlabs") {
      return;
    }
    if ((engineMode === "kokoro" || engineMode === "auto") && chatbot.language === "English") {
      await getKokoroTts(onStatus);
      onStatus?.("");
      return;
    }
    if (engineMode === "browser" || engineMode === "voicebox") {
      await ensureSystemVoicesLoaded();
      return;
    }
    const piper = await import("@mintplex-labs/piper-tts-web");
    const voiceId = resolvePiperVoiceId(chatbot);
    await enqueueSynthesis(() =>
      piper.predict({ text: "Hello.", voiceId }, (prog) => {
        if (prog.total > 0) {
          const pct = Math.round((prog.loaded * 100) / prog.total);
          onStatus?.(`Caching Piper neural voice in OPFS (${pct}%)…`);
        }
      })
    );
    onStatus?.("");
  } catch (e) {
    console.warn("Voice warm-up skipped:", e);
    onStatus?.("");
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Speech-to-Text
 * ────────────────────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const whisperPromises: Record<string, Promise<any>> = {};

async function getWhisperTranscriber(language: string, onProgress?: (msg: string) => void) {
  // `.en` checkpoints are English-only and reject a `language` argument, so other languages use the multilingual model.
  const isEnglish = (WHISPER_LANG[language] || "english") === "english";
  const modelId = isEnglish ? "Xenova/whisper-tiny.en" : "Xenova/whisper-tiny";
  if (!whisperPromises[modelId]) {
    whisperPromises[modelId] = (async () => {
      onProgress?.("Loading local speech recognition model…");
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      // Ensure onnxruntime-web loads matching wasm binaries from jsdelivr if bundled wasm fails
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
      }
      return pipeline("automatic-speech-recognition", modelId, {
        dtype: "q8",
      });
    })().catch((err) => {
      // Don't cache a failed load forever — let the next attempt retry.
      delete whisperPromises[modelId];
      throw err;
    });
  }
  return whisperPromises[modelId];
}

export interface VoiceRecorderSession {
  stop: () => void;
  cancel: () => void;
}

export interface VoiceInputOptions {
  language: string;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus?: (status: string) => void;
  onError: (err: string) => void;
  /** Fires once when the person starts talking — call `stopSpeaking()` here to let them interrupt the assistant. */
  onSpeechStart?: () => void;
}

const INCOMPLETE_ENDING_PATTERN =
  /\b(and|but|or|so|because|if|then|that|which|who|when|while|with|to|of|for|in|on|at|the|a|an|my|your|um|uh|like|also|plus|than|as)$/i;

/**
 * Human-like turn-taking: wait longer when the sentence is clearly unfinished, answer sooner when it sounds complete.
 */
function getEndOfTurnDelay(text: string): number {
  const configured = Number(readVoiceSetting<number>("voiceEndOfTurnMs", 750));
  const base = clampNumber(Number.isFinite(configured) ? configured : 750, 400, 3500);
  const trimmed = text.trim();
  if (!trimmed) return base;
  if (/[,;:]$/.test(trimmed) || INCOMPLETE_ENDING_PATTERN.test(trimmed)) return Math.round(base * 1.5);
  if (/[.!?]$/.test(trimmed)) return Math.round(base * 0.7);
  return base;
}

/** Light clean-up so the message sent to the model reads like typed text, not raw recognizer output. */
function polishTranscript(raw: string): string {
  let t = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:[^)]*\b(?:music|noise|silence|applause|laughter|inaudible)\b[^)]*)\)/gi, " ")
    .replace(/\b(?:um+|uh+|erm|er)\b[,.]?\s*/gi, "");
  t = t.replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

interface SilenceDetectorHandle {
  stop: () => void;
}

/**
 * Lightweight voice-activity detector used in the direct-recording path: calibrates to the room's noise floor,
 * reports when speech begins, and fires `onSilence` once the person has stopped talking for `silenceMs`.
 * Returns `null` (graceful degrade to tap-to-stop) if WebAudio is unavailable.
 */
function createSilenceDetector(
  stream: MediaStream,
  config: { silenceMs: number; onSpeechStart: () => void; onSilence: () => void }
): SilenceDetectorHandle | null {
  try {
    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) return null;
    const audioCtx = new AudioCtx();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => { });
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    let noiseFloor = 0;
    let calibrationTicks = 0;
    let loudTicks = 0;
    let speechDetected = false;
    let fired = false;
    let lastVoiceAt = Date.now();

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();

      if (calibrationTicks < 5) {
        noiseFloor = (noiseFloor * calibrationTicks + rms) / (calibrationTicks + 1);
        calibrationTicks++;
        return;
      }

      // Responsive threshold for mobile devices where AGC normalizes to ~0.005
      const threshold = Math.max(0.005, Math.min(noiseFloor * 2.2, 0.04));
      if (rms > threshold) {
        loudTicks++;
        lastVoiceAt = now;
        if (!speechDetected && loudTicks >= 2) {
          speechDetected = true;
          config.onSpeechStart();
        }
      } else {
        loudTicks = 0;
      }

      if (speechDetected && !fired && now - lastVoiceAt >= config.silenceMs) {
        fired = true;
        config.onSilence();
      }
    }, 100);

    return {
      stop: () => {
        clearInterval(timer);
        try {
          source.disconnect();
        } catch { }
        audioCtx.close().catch(() => { });
      },
    };
  } catch {
    return null;
  }
}

/** Decodes to mono 16kHz Float32 (what Whisper expects) using the browser's high-quality resampler. */
async function decodeAudioBlobTo16kMono(blob: Blob): Promise<Float32Array> {
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) throw new Error("WebAudio is not supported in this browser.");
  const arrayBuf = await blob.arrayBuffer();
  const audioCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuf);
  } finally {
    await audioCtx.close().catch(() => { });
  }
  return resampleTo16kMono(decoded);
}

async function resampleTo16kMono(decoded: AudioBuffer): Promise<Float32Array> {
  const targetRate = 16000;
  if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OfflineCtx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineCtx(1, length, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered: AudioBuffer = await offline.startRendering();
    return rendered.getChannelData(0);
  } catch {
    // Linear-interpolation fallback (far cleaner than nearest-sample picking).
    const input = decoded.getChannelData(0);
    const ratio = decoded.sampleRate / targetRate;
    const newLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[Math.min(idx, input.length - 1)];
      const b = input[Math.min(idx + 1, input.length - 1)];
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
}

function measureRms(audio: Float32Array): number {
  if (audio.length === 0) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(audio.length / 20000));
  let count = 0;
  for (let i = 0; i < audio.length; i += step) {
    sum += audio[i] * audio[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

async function transcribeFloat32Audio(
  audio: Float32Array,
  language: string,
  onStatus?: (status: string) => void
): Promise<string> {
  // Near-silent recordings make Whisper hallucinate phrases like "Thank you." — skip them entirely.
  if (measureRms(audio) < 0.0008) return "";
  const transcriber = await getWhisperTranscriber(language, onStatus);
  const whisperLang = WHISPER_LANG[language] || "english";
  const out = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(whisperLang === "english" ? {} : { language: whisperLang, task: "transcribe" }),
  });
  return String(out?.text || "").trim();
}

async function transcribeAndFinish(audio: Float32Array, options: VoiceInputOptions): Promise<void> {
  if (audio.length < 4800) {
    options.onFinal("");
    return;
  }
  try {
    options.onStatus?.("Transcribing speech locally with Mai Voice…");
    const text = await transcribeFloat32Audio(audio, options.language, options.onStatus);
    options.onFinal(polishTranscript(text));
  } catch (err) {
    console.warn("Local Mai Voice transcription failed:", err);
    options.onError("Local Mai Voice transcription failed.");
  }
}

export async function startVoiceInput(options: VoiceInputOptions): Promise<VoiceRecorderSession> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not supported in this browser.");
  }

  const bcp47 = LANG_BCP47[options.language] || "en-US";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRec =
    typeof window !== "undefined"
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;
  const autoSend = readVoiceSetting<boolean>("voiceAutoSend", true);

  // Track state across both native STT and audio recording
  let userStopped = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let stream: MediaStream;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recInstance: any = null;
  let activeWhisperSession: VoiceRecorderSession | null = null;
  let speechStartFired = false;

  const fireSpeechStart = () => {
    if (speechStartFired) return;
    speechStartFired = true;
    options.onSpeechStart?.();
  };

  const cleanupNative = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    if (recInstance) {
      try {
        recInstance.onresult = null;
        recInstance.onerror = null;
        recInstance.onend = null;
        recInstance.stop();
      } catch { }
      recInstance = null;
    }
  };

  // The warm-up stream is only needed to hold permission / feed the fallback recorder. Once native recognition is done it
  // must be released, otherwise the browser's "microphone in use" indicator never turns off.
  const releaseStream = () => {
    if (activeWhisperSession) return; // owned (and released) by the recorder
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch { }
  };

  const startWhisperFallback = async (reason?: string) => {
    cleanupNative();
    if (userStopped || activeWhisperSession) return;
    options.onStatus?.(reason || "Switching to direct audio recording…");
    try {
      if (!stream || !stream.active) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      }
      // If the person tapped stop while the fallback was spinning up, its result must not be delivered twice.
      const gatedOptions: VoiceInputOptions = {
        ...options,
        onFinal: (text) => {
          if (!userStopped) options.onFinal(text);
        },
      };
      activeWhisperSession = await startWhisperRecordingFromStream(stream, gatedOptions);
      if (userStopped) {
        activeWhisperSession.cancel();
        activeWhisperSession = null;
      }
    } catch (err) {
      options.onError((err as Error).message || "Microphone recording failed.");
    }
  };

  // In installed PWAs, explicitly prompt and warm the microphone permission first via getUserMedia
  // to avoid instant "not-allowed" / "service-not-allowed" in standalone window mode.
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
  } catch (err) {
    const errorMsg = (err as Error).message || "";
    const errorName = (err as Error).name || "";
    if (
      errorName === "NotAllowedError" ||
      errorName === "PermissionDeniedError" ||
      errorMsg.toLowerCase().includes("permission")
    ) {
      throw new Error("Microphone permission was not granted. Tap the mic button again and click 'Allow'.");
    }
    throw err;
  }

  // If browser has no native SpeechRecognition (e.g. Firefox, iOS Safari, or standalone app without Google Speech),
  // route directly to hardware MediaRecorder with local Whisper transcription!
  if (!SpeechRec) {
    return startWhisperRecordingFromStream(stream, options);
  }

  // 2. Try Native SpeechRecognition on desktop browsers (Chrome, Edge, Safari)
  if (SpeechRec) {
    try {
      const rec = new SpeechRec();
      recInstance = rec;
      rec.lang = bcp47;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let accumulatedFinal = "";
      let currentInterim = "";
      let speechReceived = false;

      const finishAndSubmit = () => {
        if (userStopped) return;
        userStopped = true;
        cleanupNative();
        releaseStream();
        const fullText = (accumulatedFinal + " " + currentInterim).replace(/\s+/g, " ").trim();
        options.onFinal(polishTranscript(fullText));
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (event: any) => {
        speechReceived = true;
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
          fireSpeechStart();
          options.onInterim(combined);
          options.onStatus?.(
            autoSend
              ? "Listening… (Tap mic when done, or pause to send)"
              : "Listening… (Tap mic when done)"
          );
          if (silenceTimer) clearTimeout(silenceTimer);
          if (autoSend) {
            silenceTimer = setTimeout(() => {
              if (!userStopped && combined.length > 0) {
                finishAndSubmit();
              }
            }, getEndOfTurnDelay(combined));
          }
        }
      };

      rec.onend = () => {
        if (userStopped) return;
        if (!speechReceived && !accumulatedFinal.trim()) {
          startWhisperFallback("Listening via direct audio recording…");
          return;
        }
        // Keep anything the browser had not finalized yet before the session restarts.
        if (currentInterim.trim()) {
          accumulatedFinal += " " + currentInterim;
          currentInterim = "";
        }
        try {
          rec.start();
        } catch {
          finishAndSubmit();
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = async (ev: any) => {
        if (userStopped) return;
        const code = ev?.error || "";

        // If native browser STT gives no-speech, keep retrying or seamlessly switch to direct audio recording
        if (code === "no-speech") {
          if (!speechReceived && !accumulatedFinal.trim()) {
            startWhisperFallback("Listening… speak your question");
          }
          return;
        }

        // On mobile / offline network or permission glitches with cloud SpeechRec, fall back to hardware MediaRecorder
        if (
          code === "network" ||
          code === "service-not-allowed" ||
          code === "audio-capture" ||
          code === "aborted" ||
          code === "not-allowed"
        ) {
          startWhisperFallback("Recording voice locally…");
          return;
        }

        userStopped = true;
        cleanupNative();
        releaseStream();
        options.onError(`Microphone: ${code || "Error"}`);
      };

      rec.start();
      options.onStatus?.("Listening… speak your question (Tap mic when done)");

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
          cleanupNative();
          releaseStream();
          options.onFinal("");
        },
      };
    } catch {
      // Fall through to direct audio recording if SpeechRec constructor fails
      cleanupNative();
    }
  }

  // 2. Direct Audio Recording via getUserMedia + MediaRecorder fallback (reuses the already-open stream when possible)
  if (!stream.active) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  }
  return startWhisperRecordingFromStream(stream, options);
}

async function startWhisperRecordingFromStream(
  stream: MediaStream,
  options: VoiceInputOptions
): Promise<VoiceRecorderSession> {
  const autoSend = readVoiceSetting<boolean>("voiceAutoSend", true);
  const configuredSilence = Number(readVoiceSetting<number>("voiceEndOfTurnMs", 750));
  const silenceMs = clampNumber(Number.isFinite(configuredSilence) ? configuredSilence : 750, 450, 3500);

  // Use MediaRecorder if supported (Universal on Chrome, Firefox, Safari iOS 14.8+, Android)
  if (typeof MediaRecorder !== "undefined") {
    let mimeType = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      mimeType = "audio/webm;codecs=opus";
    } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
      mimeType = "audio/mp4";
    } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
      mimeType = "audio/ogg";
    }

    const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const audioChunks: Blob[] = [];
    let stopped = false;
    let detector: SilenceDetectorHandle | null = null;
    const startTime = Date.now();

    let hearingVoice = false;
    const intervalTimer = setInterval(() => {
      if (stopped) return;
      const secs = Math.floor((Date.now() - startTime) / 1000);
      options.onStatus?.(
        hearingVoice
          ? `🎙️ Hearing your voice (${secs}s)… Pause to send, or tap mic`
          : autoSend
          ? `Recording voice (${secs}s)… Speak now, or tap mic when done`
          : `Recording voice (${secs}s)… Tap mic when done`
      );
    }, 1000);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    const releaseCapture = () => {
      clearInterval(intervalTimer);
      if (detector) {
        detector.stop();
        detector = null;
      }
    };

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      releaseCapture();

      // Stop the recorder first so its final chunk is flushed, then release the microphone.
      await new Promise<void>((resolve) => {
        mediaRecorder.onstop = () => resolve();
        try {
          if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
          else resolve();
        } catch {
          resolve();
        }
      });
      stream.getTracks().forEach((t) => t.stop());

      const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (audioBlob.size < 1200) {
        options.onFinal("");
        return;
      }

      try {
        options.onStatus?.("Transcribing speech locally with Mai Voice…");
        const audio = await decodeAudioBlobTo16kMono(audioBlob);
        await transcribeAndFinish(audio, options);
      } catch (err) {
        console.warn("Local Mai Voice transcription failed:", err);
        options.onError("Local Mai Voice transcription failed.");
      }
    };

    const cancel = () => {
      if (stopped) return;
      stopped = true;
      releaseCapture();
      stream.getTracks().forEach((t) => t.stop());
      try {
        if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
      } catch { }
      options.onFinal("");
    };

    detector = createSilenceDetector(stream, {
      silenceMs,
      onSpeechStart: () => {
        hearingVoice = true;
        options.onSpeechStart?.();
        options.onStatus?.("🎙️ Hearing your voice… Pause to send, or tap mic");
      },
      onSilence: () => {
        if (autoSend) void stop();
      },
    });

    mediaRecorder.start(250);
    options.onStatus?.(
      autoSend ? "Recording voice (0s)… Pause to send, or tap mic when done" : "Recording voice (0s)… Tap mic when done"
    );
    return { stop, cancel };
  }

  // Fallback to ScriptProcessor if MediaRecorder is somehow unavailable
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) throw new Error("Audio recording is not supported in this browser.");
  const audioCtx = new AudioCtx({ sampleRate: 16000 });
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
    } catch { }
    stream.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => { });
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

    await transcribeAndFinish(merged, options);
  };

  const cancel = async () => {
    if (stopped) return;
    stopped = true;
    await cleanupAudio();
    options.onFinal("");
  };

  return { stop, cancel };
}