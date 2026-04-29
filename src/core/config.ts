import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import TOML from "@iarna/toml";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const accountSchema = z.object({
  id: z.string().min(1),
  vendor: z.enum([
    "anthropic",
    "anthropic-bedrock",
    "anthropic-vertex",
    "anthropic-compatible",
    "openai",
    "openai-compatible",
    "openai-azure",
  ]),
  baseUrl: z.string().url().optional(),
  secretRef: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  extraConfig: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const policySchema = z.object({
  id: z.string().min(1),
  permissionMode: z.enum(["read-only", "edit", "full"]),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  networkAllowed: z.boolean().default(false),
  approvalPolicy: z.enum(["never", "on-request", "untrusted", "orchestrator"]),
  requireApprovalFor: z.array(z.enum(["tool", "network", "filesystem", "delegation", "workspace_merge", "budget_increase", "reference_access"])).default([]),
  maxDepth: z.number().int().min(0).default(1),
  maxTurns: z.number().int().positive().optional(),
  maxMinutes: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  allowCrossHarnessDelegation: z.boolean().default(false),
  allowChildEdit: z.boolean().default(false),
  allowChildNetwork: z.boolean().default(false),
  unsafeDirectCwd: z.boolean().optional(),
});

const profileSchema = z.object({
  id: z.string().min(1),
  runtime: z.enum(["claude", "codex"]),
  accountId: z.string().min(1),
  policyId: z.string().min(1),
  model: z.string().min(1),
  allowedModels: z.array(z.string()).optional(),
  systemPromptOverride: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const configSchema = z.object({
  accounts: z.record(z.string(), accountSchema).default({}),
  policies: z.record(z.string(), policySchema).default({}),
  profiles: z.record(z.string(), profileSchema).default({}),
  redaction: z.object({
    additionalPatterns: z.array(z.string()).default([]),
  }).default({ additionalPatterns: [] }),
  transcript: z.object({
    storeRawEncrypted: z.boolean().default(false),
    rawTtlHours: z.number().int().positive().optional(),
  }).default({ storeRawEncrypted: false }),
  storage: z.object({
    dbPath: z.string().default(path.join(os.homedir(), ".auto-pm-lite", "auto-pm-lite.db")),
    busyTimeoutMs: z.number().int().positive().default(5000),
    maxQueueSize: z.number().int().positive().default(5000),
    flushBatchSize: z.number().int().positive().default(100),
  }).default({
    dbPath: path.join(os.homedir(), ".auto-pm-lite", "auto-pm-lite.db"),
    busyTimeoutMs: 5000,
    maxQueueSize: 5000,
    flushBatchSize: 100,
  }),
  workspace: z.object({
    rootDir: z.string().default(path.join(os.homedir(), ".auto-pm-lite", "workspaces")),
    topLevelUseWorktree: z.boolean().default(true),
  }).default({
    rootDir: path.join(os.homedir(), ".auto-pm-lite", "workspaces"),
    topLevelUseWorktree: true,
  }),
});

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".auto-pm-lite", "config.toml");
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<AppConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const normalized = normalizeConfig(parsed);
  return configSchema.parse(normalized);
}

function normalizeConfig(input: Record<string, unknown>): Record<string, unknown> {
  const accounts = normalizeNamedSection(input.account, "account");
  const policies = normalizeNamedSection(input.policy, "policy");
  const profiles = normalizeNamedSection(input.profile, "profile");

  return {
    accounts,
    policies,
    profiles,
    redaction: input.redaction ?? {},
    transcript: input.transcript ?? {},
    storage: input.storage ?? {},
    workspace: input.workspace ?? {},
  };
}

function normalizeNamedSection(value: unknown, key: string): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([id, config]) => {
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`Invalid [${key}.${id}] section`);
      }

      return [id, { id, ...config }];
    }),
  );
}
