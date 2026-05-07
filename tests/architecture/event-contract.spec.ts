import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eventEnvelopeVersionSchema } from "../../src/api/schemas.js";
import { eventEnvelopeVersion } from "../../src/api/types.js";
import { canonicalEventVersion, eventEnvelopeSchemaV2 } from "../../src/core/events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../..");
const guardTestPath = fileURLToPath(import.meta.url);

describe("event protocol architecture boundary", () => {
  it("exposes only the v2 canonical event envelope as the public event contract", () => {
    expect(eventEnvelopeVersion).toBe(2);
    expect(canonicalEventVersion).toBe(2);
    expect(eventEnvelopeVersionSchema.safeParse(2).success).toBe(true);
    expect(eventEnvelopeVersionSchema.safeParse(1).success).toBe(false);
    expect(eventEnvelopeSchemaV2.safeParse(minimalEnvelope(2)).success).toBe(true);
    expect(eventEnvelopeSchemaV2.safeParse(minimalEnvelope(1)).success).toBe(false);
  });

  it("keeps raw runtime event.type out of API service IPC and desktop renderer code", async () => {
    const files = await sourceFiles([
      "src/api",
      "src/service",
      "src/desktop",
    ]);

    const violations = await scan(files, [
      {
        name: "runtime raw event type access",
        pattern: /\bevent\.event\.type\b/,
      },
      {
        name: "v1 event envelope version constant",
        pattern: /\beventEnvelopeVersion\s*=\s*1\b/,
      },
      {
        name: "v1 envelope schema",
        pattern: /\beventEnvelopeSchemaV1\b/,
      },
      {
        name: "v1 envelope literal",
        pattern: /\bv:\s*1\b/,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("keeps the removed EventStore model out of production and test code", async () => {
    const files = await sourceFiles(["src", "tests"]);
    const violations = await scan(files, [
      {
        name: "legacy EventStore symbol",
        pattern: /\bEventStore\b/,
      },
      {
        name: "legacy event-store module path",
        pattern: /event-store/,
      },
    ]);

    expect(violations).toEqual([]);
  });
});

function minimalEnvelope(version: 1 | 2) {
  return {
    v: version,
    eventId: "event-1",
    seq: 1,
    taskSeq: 1,
    runtime: "claude",
    taskId: "task-1",
    sessionId: "session-1",
    ts: "2026-05-07T00:00:00.000Z",
    delivery: "lossless",
    event: { kind: "task.queued" },
  };
}

async function sourceFiles(relativeDirs: string[]): Promise<string[]> {
  const roots = relativeDirs.map((relativeDir) => path.join(repoRoot, relativeDir));
  const files = (await Promise.all(roots.map((root) => collectFiles(root)))).flat();
  return files.filter((file) => /\.(?:ts|tsx)$/.test(file) && path.resolve(file) !== guardTestPath);
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        return [];
      }
      return collectFiles(entryPath);
    }
    return [entryPath];
  }));
  return nested.flat();
}

async function scan(files: string[], rules: Array<{ name: string; pattern: RegExp }>): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const relativePath = path.relative(repoRoot, file).replaceAll(path.sep, "/");
    for (const rule of rules) {
      if (rule.pattern.test(content)) {
        violations.push(`${relativePath}: ${rule.name}`);
      }
    }
  }
  return violations;
}
