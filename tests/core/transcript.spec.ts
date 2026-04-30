import { describe, expect, it, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { buildRawTranscriptCipher, decryptRawTranscript, isRawTranscriptExpired } from "../../src/core/transcript.js";

describe("transcript dual-track storage", () => {
  const originalKey = process.env.AUTO_PM_TRANSCRIPT_KEY;

  beforeEach(() => {
    process.env.AUTO_PM_TRANSCRIPT_KEY = crypto.randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AUTO_PM_TRANSCRIPT_KEY;
    } else {
      process.env.AUTO_PM_TRANSCRIPT_KEY = originalKey;
    }
  });

  it("returns null when storeRawEncrypted is false", () => {
    const cipher = buildRawTranscriptCipher({
      prompt: "secret",
      config: { storeRawEncrypted: false },
    });
    expect(cipher).toBeNull();
  });

  it("encrypts then decrypts roundtrip", () => {
    const cipher = buildRawTranscriptCipher({
      prompt: "open the kimono",
      config: { storeRawEncrypted: true, rawTtlHours: 24 },
    });
    expect(cipher).not.toBeNull();
    expect(cipher!.encrypted).not.toContain("open");

    const plaintext = decryptRawTranscript(cipher!.encrypted);
    expect(plaintext).toBe("open the kimono");
  });

  it("returns null when key is not configured", () => {
    delete process.env.AUTO_PM_TRANSCRIPT_KEY;
    const cipher = buildRawTranscriptCipher({
      prompt: "anything",
      config: { storeRawEncrypted: true, rawTtlHours: 1 },
    });
    expect(cipher).toBeNull();
  });

  it("computes TTL relative to provided now", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const cipher = buildRawTranscriptCipher({
      prompt: "x",
      config: { storeRawEncrypted: true, rawTtlHours: 2 },
      now,
    });
    expect(cipher!.ttlAt).toBe("2025-01-01T02:00:00.000Z");
  });

  it("isRawTranscriptExpired correctly compares strings", () => {
    expect(isRawTranscriptExpired({ promptRawTtlAt: "2025-01-01T00:00:00.000Z" }, "2025-01-02T00:00:00.000Z")).toBe(true);
    expect(isRawTranscriptExpired({ promptRawTtlAt: "2030-01-01T00:00:00.000Z" }, "2025-01-02T00:00:00.000Z")).toBe(false);
    expect(isRawTranscriptExpired({})).toBe(false);
  });
});
