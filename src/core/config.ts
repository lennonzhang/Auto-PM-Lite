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
  requireApprovalFor: z.array(z.enum([
    "shell",
    "file_edit",
    "network",
    "workspace_write",
    "cross_harness_delegation",
    "profile_switch",
    "budget_increase",
    "sandbox_escape",
    "workspace_merge",
    "clarification",
  ])).default([]),
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
  scheduler: z.object({
    maxConcurrentTasksGlobal: z.number().int().positive().default(5),
    maxConcurrentTasksPerAccount: z.number().int().positive().default(2),
  }).default({
    maxConcurrentTasksGlobal: 5,
    maxConcurrentTasksPerAccount: 2,
  }),
  rateLimit: z.object({
    enabled: z.boolean().default(false),
    requestsPerMinute: z.number().int().positive().optional(),
    requestsPerHour: z.number().int().positive().optional(),
    tokensPerMinute: z.number().int().positive().optional(),
  }).default({ enabled: false }),
});

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".auto-pm-lite", "config.toml");
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<AppConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const accountsPath = path.join(path.dirname(configPath), "accounts.toml");
  const accountsParsed = await readOptionalToml(accountsPath);
  const merged = mergeAccountsToml(parsed, accountsParsed);
  const normalized = normalizeConfig(merged);
  return configSchema.parse(normalized);
}

async function readOptionalToml(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return TOML.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function mergeAccountsToml(config: Record<string, unknown>, accountsToml: Record<string, unknown> | null): Record<string, unknown> {
  if (!accountsToml) {
    return config;
  }

  return {
    ...config,
    account: {
      ...asRecord(accountsToml.account),
      ...asRecord(config.account),
    },
  };
}

function normalizeConfig(input: Record<string, unknown>): Record<string, unknown> {
  const accounts = normalizeNamedSection(input.account, "account");
  const policies = normalizeNamedSection(input.policy, "policy");
  const profiles = normalizeNamedSection(input.profile, "profile");

  return {
    accounts,
    policies,
    profiles,
    redaction: normalizeKeys(asRecord(input.redaction)),
    transcript: normalizeKeys(asRecord(input.transcript)),
    storage: normalizeKeys(asRecord(input.storage)),
    workspace: normalizeKeys(asRecord(input.workspace)),
    scheduler: normalizeKeys(asRecord(input.scheduler)),
    rateLimit: normalizeKeys(asRecord(input.rateLimit)),
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

      return [id, { id, ...normalizeKeys(config as Record<string, unknown>) }];
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeKeys(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    output[normalizeKey(key)] = value;
  }

  if ("account" in output && !("accountId" in output)) {
    output.accountId = output.account;
  }
  if ("policy" in output && !("policyId" in output)) {
    output.policyId = output.policy;
  }

  return output;
}

function normalizeKey(key: string): string {
  switch (key) {
    case "base_url":
      return "baseUrl";
    case "secret_ref":
      return "secretRef";
    case "extra_headers":
      return "extraHeaders";
    case "extra_config":
      return "extraConfig";
    case "permission_mode":
      return "permissionMode";
    case "sandbox_mode":
      return "sandboxMode";
    case "network_allowed":
      return "networkAllowed";
    case "approval_policy":
      return "approvalPolicy";
    case "require_approval_for":
      return "requireApprovalFor";
    case "max_depth":
      return "maxDepth";
    case "max_turns":
      return "maxTurns";
    case "max_minutes":
      return "maxMinutes";
    case "max_tokens":
      return "maxTokens";
    case "max_cost_usd":
      return "maxCostUsd";
    case "allow_cross_harness_delegation":
      return "allowCrossHarnessDelegation";
    case "allow_child_edit":
      return "allowChildEdit";
    case "allow_child_network":
      return "allowChildNetwork";
    case "unsafe_direct_cwd":
      return "unsafeDirectCwd";
    case "allowed_models":
      return "allowedModels";
    case "system_prompt_override":
      return "systemPromptOverride";
    case "additional_patterns":
      return "additionalPatterns";
    case "store_raw_encrypted":
      return "storeRawEncrypted";
    case "raw_ttl_hours":
      return "rawTtlHours";
    case "db_path":
      return "dbPath";
    case "busy_timeout_ms":
      return "busyTimeoutMs";
    case "max_queue_size":
      return "maxQueueSize";
    case "flush_batch_size":
      return "flushBatchSize";
    case "root_dir":
      return "rootDir";
    case "top_level_use_worktree":
      return "topLevelUseWorktree";
    default:
      return key;
  }
}
