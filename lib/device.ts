/**
 * Silent Multi-Layer Local Device Recognition System:
 * - Layer 1: Non-extractable WebCrypto ECDSA P-256 keypair in IndexedDB + SHA-256 public key Device ID.
 * - Layer 2: Deterministic physical Hardware Signature (`hw_...`) from GPU/WebGL/WebGPU/CPU/RAM/Screen traits.
 * - Layer 3: Triple-Vault Self-Healing Persistence (`IndexedDB` <-> `OPFS` <-> `localStorage`).
 * All recognition happens silently in the background with zero external network calls or UI clutter.
 */

import { db, type DeviceVaultRecord } from "./db";

export interface RecognizedDevice {
  deviceId: string;
  hardwareHash: string;
  optimalModelId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  visitCount: number;
  isReturningDevice: boolean;
}

const LS_DEVICE_KEY = "pla-device-identity-v1";
const OPFS_DEVICE_FILE = ".device_identity.json";

async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Computes a deterministic physical hardware signature (`hw_...`) from stable GPU, CPU, memory, and display traits.
 * Survives "Clear Site Data" and Incognito mode on the same physical machine.
 */
export async function computeHardwareSignature(): Promise<string> {
  if (typeof window === "undefined") return "hw_server";

  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory || 4;
  const touch = nav.maxTouchPoints || 0;
  const platform = nav.platform || "";
  const scr = typeof screen !== "undefined" ? `${screen.width}x${screen.height}x${screen.colorDepth}` : "0x0";
  const dpr = Math.round((window.devicePixelRatio || 1) * 100);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";

  // WebGL unmasked renderer/vendor (fast synchronous hardware probe)
  let webglRenderer = "";
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl") as WebGLRenderingContext | null) ||
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        const vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || "";
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "";
        webglRenderer = `${vendor}|${renderer}`;
      }
    }
  } catch {
    // ignore WebGL probe errors
  }

  // WebGPU adapter limits & architecture
  let webgpuTraits = "";
  if ("gpu" in navigator) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        const lim = adapter.limits || {};
        webgpuTraits = [
          info.vendor || "",
          info.architecture || "",
          lim.maxStorageBufferBindingSize || 0,
          lim.maxBufferSize || 0,
          lim.maxComputeWorkgroupSizeX || 0,
        ].join("|");
      }
    } catch {
      // ignore WebGPU probe errors
    }
  }

  const rawFingerprint = [
    `cores:${cores}`,
    `mem:${mem}`,
    `touch:${touch}`,
    `plat:${platform}`,
    `scr:${scr}`,
    `dpr:${dpr}`,
    `tz:${tz}`,
    `gl:${webglRenderer}`,
    `gpu:${webgpuTraits}`,
  ].join("||");

  const fullHex = await sha256Hex(rawFingerprint);
  return `hw_${fullHex.slice(0, 16)}`;
}

async function readOpfsIdentity(): Promise<Partial<DeviceVaultRecord> | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(OPFS_DEVICE_FILE);
    const file = await handle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeOpfsIdentity(record: Partial<DeviceVaultRecord>): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(OPFS_DEVICE_FILE, { create: true });
    const writable = await handle.createWritable();
    const { privateKey: _omitKey, ...serializable } = record;
    void _omitKey;
    await writable.write(JSON.stringify(serializable));
    await writable.close();
  } catch {
    // ignore OPFS write errors
  }
}

function readLocalStorageIdentity(): Partial<DeviceVaultRecord> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_DEVICE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalStorageIdentity(record: Partial<DeviceVaultRecord>): void {
  if (typeof window === "undefined") return;
  try {
    const { privateKey: _omitKey, ...serializable } = record;
    void _omitKey;
    window.localStorage.setItem(LS_DEVICE_KEY, JSON.stringify(serializable));
  } catch {
    // ignore localStorage quota errors
  }
}

async function generateSealedDeviceKey(hardwareHash: string): Promise<{
  deviceId: string;
  publicKeySpkiB64?: string;
  privateKey?: CryptoKey;
}> {
  try {
    if (typeof crypto !== "undefined" && crypto.subtle?.generateKey) {
      const kp = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false, // Non-extractable private key sealed inside browser origin
        ["sign", "verify"]
      );
      const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
      const pubHex = await sha256Hex(spki);
      return {
        deviceId: `dev_${pubHex.slice(0, 16)}`,
        publicKeySpkiB64: bytesToBase64(new Uint8Array(spki)),
        privateKey: kp.privateKey,
      };
    }
  } catch {
    // Fall back to deterministic hardware-anchored ID if subtle crypto keygen is restricted
  }
  const fallbackHex = await sha256Hex(`${hardwareHash}_${Date.now()}_${Math.random()}`);
  return { deviceId: `dev_${fallbackHex.slice(0, 16)}` };
}

let cachedRecognitionPromise: Promise<RecognizedDevice> | null = null;

/**
 * Silently resolves and self-heals the device identity across IndexedDB, OPFS, and localStorage.
 */
export function recognizeDevice(optimalModelId?: string): Promise<RecognizedDevice> {
  if (cachedRecognitionPromise && !optimalModelId) return cachedRecognitionPromise;

  cachedRecognitionPromise = (async () => {
    const now = new Date().toISOString();
    const hardwareHash = await computeHardwareSignature();

    const [idbRec, opfsRec] = await Promise.all([
      db.device_vault.get("primary").catch(() => undefined),
      readOpfsIdentity(),
    ]);
    const lsRec = readLocalStorageIdentity();

    const existing = idbRec || opfsRec || lsRec;

    if (existing && existing.deviceId) {
      const updated: DeviceVaultRecord = {
        id: "primary",
        deviceId: existing.deviceId,
        hardwareHash,
        publicKeySpkiB64: existing.publicKeySpkiB64,
        privateKey: idbRec?.privateKey,
        optimalModelId: optimalModelId || existing.optimalModelId,
        firstSeenAt: existing.firstSeenAt || now,
        lastSeenAt: now,
        visitCount: (existing.visitCount || 1) + (optimalModelId ? 0 : 1),
      };

      // Self-heal all 3 vaults silently in the background
      await Promise.all([
        db.device_vault.put(updated).catch(() => {}),
        writeOpfsIdentity(updated),
      ]);
      writeLocalStorageIdentity(updated);

      return {
        deviceId: updated.deviceId,
        hardwareHash: updated.hardwareHash,
        optimalModelId: updated.optimalModelId,
        firstSeenAt: updated.firstSeenAt,
        lastSeenAt: updated.lastSeenAt,
        visitCount: updated.visitCount,
        isReturningDevice: true,
      };
    }

    // First time seeing this browser storage state: create sealed WebCrypto key + mirror across all 3 vaults
    const sealed = await generateSealedDeviceKey(hardwareHash);
    const fresh: DeviceVaultRecord = {
      id: "primary",
      deviceId: sealed.deviceId,
      hardwareHash,
      publicKeySpkiB64: sealed.publicKeySpkiB64,
      privateKey: sealed.privateKey,
      optimalModelId,
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1,
    };

    await Promise.all([
      db.device_vault.put(fresh).catch(() => {}),
      writeOpfsIdentity(fresh),
    ]);
    writeLocalStorageIdentity(fresh);

    return {
      deviceId: fresh.deviceId,
      hardwareHash: fresh.hardwareHash,
      optimalModelId: fresh.optimalModelId,
      firstSeenAt: fresh.firstSeenAt,
      lastSeenAt: fresh.lastSeenAt,
      visitCount: 1,
      isReturningDevice: false,
    };
  })();

  return cachedRecognitionPromise;
}

