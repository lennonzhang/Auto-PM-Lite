import crypto from "node:crypto";
import process from "node:process";
import type { AppConfig } from "./types.js";

/**
 * Two-track transcript persistence:
 *
 *   1. `promptRedacted` is always written. Safe for UI, search, audit, and replay across
 *      tasks (`@task:turn-N` style references).
 *
 *   2. `promptRawEncrypted` is optional. When `transcript.storeRawEncrypted` is true and a
 *      key is available via `AUTO_PM_TRANSCRIPT_KEY`, we encrypt the raw prompt with
 *      AES-256-GCM and stamp it with a TTL. After TTL the row stays but the ciphertext
 *      is unreadable (we drop the key in `dropExpiredRawTranscripts`).
 *
 * The redacted projection is canonical. Raw is a security-sensitive optional layer for
 * supervisors who need full replay; never required for normal operation.
 */
export interface RawTranscriptCipher {
  encrypted: string;
  ttlAt: string;
}

const ALG = "aes-256-gcm";
const KEY_ENV = "AUTO_PM_TRANSCRIPT_KEY";

export interface BuildRawTranscriptInput {
  prompt: string;
  config: AppConfig["transcript"];
  now?: Date;
}

export function buildRawTranscriptCipher(input: BuildRawTranscriptInput): RawTranscriptCipher | null {
  if (!input.config.storeRawEncrypted) {
    return null;
  }

  const key = resolveKey();
  if (!key) {
    return null;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(input.prompt, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store iv (12) + tag (16) + ciphertext as base64 so retrieval is straightforward.
  const blob = Buffer.concat([iv, tag, ciphertext]).toString("base64");

  const ttlHours = input.config.rawTtlHours;
  const ttlAt = ttlHours
    ? new Date((input.now ?? new Date()).getTime() + ttlHours * 3_600_000).toISOString()
    : new Date(8.64e15).toISOString();

  return {
    encrypted: blob,
    ttlAt,
  };
}

export function decryptRawTranscript(blob: string): string | null {
  const key = resolveKey();
  if (!key) {
    return null;
  }
  try {
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

export function isRawTranscriptExpired(row: { promptRawTtlAt?: string | undefined }, now: string = new Date().toISOString()): boolean {
  if (!row.promptRawTtlAt) {
    return false;
  }
  return row.promptRawTtlAt < now;
}

function resolveKey(): Buffer | null {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    return null;
  }
  // Accept either base64-encoded 32 bytes or a 64-char hex string.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    return null;
  }
  return decoded;
}
