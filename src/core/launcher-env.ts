import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Account, AppConfig, Profile } from "./types.js";

export interface LauncherEnvSnapshot {
  files: string[];
  values: Record<string, string>;
  sessionEnv: Record<string, string>;
  sourceEnv: NodeJS.ProcessEnv;
}

const explicitLauncherEnvPathKey = "AUTO_PM_LAUNCHER_ENV_PATH";
const launcherEnvFileNames = ["launcher.env", "launcher.env.local"];

export async function loadProjectLauncherEnv(input: {
  cwd?: string | undefined;
  configPath?: string | undefined;
  sourceEnv?: NodeJS.ProcessEnv | undefined;
} = {}): Promise<LauncherEnvSnapshot | undefined> {
  const baseEnv = input.sourceEnv ?? process.env;
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const explicitPath = nonEmpty(readEnvValue(baseEnv, explicitLauncherEnvPathKey));
  const candidates = explicitPath
    ? [path.resolve(cwd, explicitPath)]
    : launcherEnvCandidates(cwd, input.configPath);

  const values: Record<string, string> = {};
  const files: string[] = [];

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        if (explicitPath) {
          throw new Error(`Launcher env file does not exist: ${candidate}`);
        }
        continue;
      }
      throw error;
    }

    Object.assign(values, parseLauncherEnv(raw));
    files.push(candidate);
  }

  if (files.length === 0) {
    return undefined;
  }

  const sessionEnv = buildLauncherSessionEnv(values);
  const sourceEnv = composeLauncherSourceEnv(baseEnv, values, sessionEnv, files.at(-1));
  return { files, values, sessionEnv, sourceEnv };
}

export function parseLauncherEnv(raw: string): Record<string, string> {
  const output: Record<string, string> = {};
  const withoutBom = raw.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid launcher env line ${index + 1}`);
    }

    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) {
      throw new Error(`Invalid launcher env line ${index + 1}`);
    }
    output[key] = parseLauncherEnvValue(value);
  }

  return output;
}

export function buildLauncherSessionEnv(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  if (launcherAuthMode(values, "claude") !== "local") {
    injectClaudeLauncherEnv(env, values);
  }
  if (launcherAuthMode(values, "codex") !== "local") {
    injectCodexLauncherEnv(env, values);
  }
  return env;
}

export function applyLauncherEnvToConfig(config: AppConfig, launcherEnv: LauncherEnvSnapshot | undefined): AppConfig {
  if (!launcherEnv) {
    return config;
  }

  return {
    ...config,
    accounts: Object.fromEntries(
      Object.entries(config.accounts).map(([accountId, account]) => [
        accountId,
        applyLauncherEnvToAccount(account, launcherEnv.values),
      ]),
    ),
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([profileId, profile]) => [
        profileId,
        applyLauncherEnvToProfile(profile, launcherEnv.values),
      ]),
    ),
  };
}

function launcherEnvCandidates(cwd: string, configPath?: string | undefined): string[] {
  const directories = configPath ? [path.dirname(path.resolve(configPath))] : [cwd];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const directory of directories) {
    for (const fileName of launcherEnvFileNames) {
      const candidate = path.join(directory, fileName);
      const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (!seen.has(normalized)) {
        candidates.push(candidate);
        seen.add(normalized);
      }
    }
  }

  return candidates;
}

function composeLauncherSourceEnv(
  baseEnv: NodeJS.ProcessEnv,
  values: Record<string, string>,
  sessionEnv: Record<string, string>,
  sourcePath: string | undefined,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...baseEnv };
  assignNonEmpty(output, values);
  assignNonEmpty(output, sessionEnv);
  if (sourcePath) {
    output[explicitLauncherEnvPathKey] = sourcePath;
  }
  return output;
}

function injectClaudeLauncherEnv(env: Record<string, string>, values: Record<string, string>): void {
  copyNonEmpty(env, values, [
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT",
    "CLAUDE_CODE_USE_POWERSHELL_TOOL",
    "ENABLE_PROMPT_CACHING_1H",
  ]);

  const platform = launcherToken(values.CLAUDE_PLATFORM);
  const keySlot = launcherToken(values.CLAUDE_KEY);
  if (!platform) {
    return;
  }

  const prefix = `CLAUDE__${platform}__`;
  setNonEmpty(env, "ANTHROPIC_BASE_URL", values[`${prefix}BASE_URL`]);
  setNonEmpty(env, "NODE_TLS_REJECT_UNAUTHORIZED", values[`${prefix}NODE_TLS_REJECT_UNAUTHORIZED`]);

  if (keySlot) {
    const key = nonEmpty(values[`${prefix}KEY__${keySlot}`]);
    if (key) {
      env.ANTHROPIC_AUTH_TOKEN = key;
      env.ANTHROPIC_API_KEY = key;
    }
  }
}

function injectCodexLauncherEnv(env: Record<string, string>, values: Record<string, string>): void {
  const platform = launcherToken(values.CODEX_PLATFORM);
  const keySlot = launcherToken(values.CODEX_KEY);
  if (!platform || !keySlot) {
    return;
  }

  const prefix = `CODEX__${platform}__`;
  const key = nonEmpty(values[`${prefix}KEY__${keySlot}`]);
  if (!key) {
    return;
  }

  const envKey = nonEmpty(values[`${prefix}ENV_KEY`]) ?? nonEmpty(values.CODEX_ENV_KEY) ?? "OPENAI_API_KEY";
  env[envKey] = key;
}

function applyLauncherEnvToAccount(account: Account, values: Record<string, string>): Account {
  if (isRuntimeLocalAuth(account, values, "claude") || isRuntimeLocalAuth(account, values, "codex")) {
    return account;
  }
  if (account.vendor === "anthropic-compatible") {
    return applyClaudeLauncherEnvToAccount(account, values);
  }
  if (account.vendor === "openai-compatible" || account.vendor === "openai-azure") {
    return applyCodexLauncherEnvToAccount(account, values);
  }
  return account;
}

function applyClaudeLauncherEnvToAccount(account: Account, values: Record<string, string>): Account {
  const platform = launcherToken(values.CLAUDE_PLATFORM);
  if (!platform) {
    return account;
  }

  const prefix = `CLAUDE__${platform}__`;
  const baseUrl = account.baseUrl ?? nonEmpty(values[`${prefix}BASE_URL`]);
  const extraConfig = mergeExtraConfig(account.extraConfig, {
    ...(values[`${prefix}NODE_TLS_REJECT_UNAUTHORIZED`] ? {
      node_tls_reject_unauthorized: values[`${prefix}NODE_TLS_REJECT_UNAUTHORIZED`],
    } : {}),
  });

  return {
    ...account,
    ...(baseUrl ? { baseUrl } : {}),
    ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
  };
}

function applyCodexLauncherEnvToAccount(account: Account, values: Record<string, string>): Account {
  const platform = launcherToken(values.CODEX_PLATFORM);
  if (!platform) {
    return account;
  }

  const prefix = `CODEX__${platform}__`;
  const extraConfig = mergeExtraConfig(
    {
      provider: nonEmpty(values[`${prefix}PROVIDER`]),
      env_key: nonEmpty(values[`${prefix}ENV_KEY`]) ?? nonEmpty(values.CODEX_ENV_KEY),
      wire_api: nonEmpty(values[`${prefix}WIRE_API`]) ?? nonEmpty(values.CODEX_WIRE_API),
      requires_openai_auth: parseLauncherBoolean(values[`${prefix}REQUIRES_OPENAI_AUTH`]),
      model_context_window: parseLauncherNumber(values[`${prefix}MODEL_CONTEXT_WINDOW`]),
      model_auto_compact_token_limit: parseLauncherNumber(values[`${prefix}MODEL_AUTO_COMPACT_TOKEN_LIMIT`]),
      model_reasoning_effort: nonEmpty(values[`${prefix}REASONING_EFFORT`]) ?? nonEmpty(values.CODEX_REASONING_EFFORT),
    },
    account.extraConfig,
  );
  const baseUrl = account.baseUrl ?? nonEmpty(values[`${prefix}BASE_URL`]);

  return {
    ...account,
    ...(baseUrl ? { baseUrl } : {}),
    ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
  };
}

function applyLauncherEnvToProfile(profile: Profile, values: Record<string, string>): Profile {
  if (profile.runtime !== "codex") {
    return profile;
  }
  if (launcherAuthMode(values, "codex") === "local") {
    return profile;
  }

  const platform = launcherToken(values.CODEX_PLATFORM);
  const model = platform ? nonEmpty(values[`CODEX__${platform}__MODEL`]) : undefined;
  return model ? { ...profile, model } : profile;
}

function parseLauncherEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  const quote = trimmed[0];
  if ((quote === `"` || quote === "'") && trimmed.endsWith(quote)) {
    const body = trimmed.slice(1, -1);
    return quote === `"` ? unescapeDoubleQuotedValue(body) : body;
  }

  return stripInlineComment(trimmed).trim();
}

function stripInlineComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unescapeDoubleQuotedValue(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function assignNonEmpty(output: NodeJS.ProcessEnv, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    const normalized = nonEmpty(value);
    if (normalized) {
      output[key] = normalized;
    }
  }
}

function copyNonEmpty(output: Record<string, string>, values: Record<string, string>, keys: string[]): void {
  for (const key of keys) {
    setNonEmpty(output, key, values[key]);
  }
}

function setNonEmpty(output: Record<string, string>, key: string, value: string | undefined): void {
  const normalized = nonEmpty(value);
  if (normalized) {
    output[key] = normalized;
  }
}

function launcherToken(value: string | undefined): string | undefined {
  return nonEmpty(value)?.toUpperCase();
}

function launcherAuthMode(values: Record<string, string>, runtime: "claude" | "codex"): "env" | "local" {
  const key = `${runtime.toUpperCase()}_AUTH_MODE`;
  const normalized = nonEmpty(values[key])?.toLowerCase();
  return normalized === "local" ? "local" : "env";
}

function isRuntimeLocalAuth(account: Account, values: Record<string, string>, runtime: "claude" | "codex"): boolean {
  if (!account.secretRef.trim().toLowerCase().startsWith("local")) {
    return launcherAuthMode(values, runtime) === "local" && accountMatchesRuntime(account, runtime);
  }
  return accountMatchesRuntime(account, runtime);
}

function accountMatchesRuntime(account: Account, runtime: "claude" | "codex"): boolean {
  if (runtime === "claude") {
    return account.vendor.startsWith("anthropic");
  }
  return account.vendor.startsWith("openai");
}

function mergeExtraConfig(...configs: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const config of configs) {
    if (!config) {
      continue;
    }
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== "") {
        output[key] = value;
      }
    }
  }
  return output;
}

function parseLauncherBoolean(value: string | undefined): boolean | undefined {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseLauncherNumber(value: string | undefined): number | undefined {
  const normalized = nonEmpty(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnvValue(sourceEnv: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = sourceEnv[key];
  if (exact !== undefined) {
    return exact;
  }

  if (process.platform !== "win32") {
    return undefined;
  }

  const normalized = key.toUpperCase();
  const match = Object.keys(sourceEnv).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? sourceEnv[match] : undefined;
}
