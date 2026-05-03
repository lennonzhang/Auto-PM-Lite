import process from "node:process";
import { sanitizeEnvKey } from "../core/credentials.js";
import type { Account, AppConfig, RuntimeKind } from "../core/types.js";

const HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "PSModulePath",
];

const SHARED_SESSION_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "AUTO_PM_LAUNCHER_ENV_PATH",
];

const RUNTIME_SESSION_ENV_KEYS: Record<RuntimeKind, string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_VERTEX_REGION",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT",
    "CLAUDE_CODE_USE_POWERSHELL_TOOL",
    "ENABLE_PROMPT_CACHING_1H",
  ],
  codex: [
    "CODEX_API_KEY",
    "CODEX_HOME",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
  ],
};

const RUNTIME_AUTH_ENV_KEYS: Record<RuntimeKind, string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
  ],
  codex: [
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
  ],
};

export interface BuildRuntimeEnvInput {
  runtime: RuntimeKind;
  account: Account;
  secret?: string | undefined;
  sourceEnv?: NodeJS.ProcessEnv | undefined;
  authMode?: "env" | "local" | undefined;
}

export function buildRuntimeEnv(input: BuildRuntimeEnvInput): Record<string, string> {
  const env = buildSessionEnv(input.runtime, input.sourceEnv);
  if (input.authMode === "local") {
    removeEnvKeys(env, RUNTIME_AUTH_ENV_KEYS[input.runtime]);
    return env;
  }
  if (input.secret) {
    injectAccountSecretEnv(env, input.account, input.secret, input.runtime);
  }
  return env;
}

export function buildMcpSidecarEnv(config: AppConfig, sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = buildSessionEnv("all", sourceEnv);

  for (const account of Object.values(config.accounts)) {
    const envName = secretRefEnvName(account.secretRef);
    if (!envName) {
      continue;
    }

    const value = readEnv(sourceEnv, envName);
    if (value !== undefined) {
      env[envName] = value;
    }
  }

  return env;
}

export function getRuntimeEnvKey(account: Account, runtime: RuntimeKind): string | undefined {
  return stringExtra(account.extraConfig, [
    `${runtime}EnvKey`,
    `${runtime}_env_key`,
    "runtimeEnvKey",
    "runtime_env_key",
    "envKey",
    "env_key",
  ]);
}

export function secretRefEnvName(secretRef: string): string | undefined {
  if (!secretRef.startsWith("env:")) {
    return undefined;
  }

  const envName = secretRef.slice(4).trim();
  return envName.length > 0 ? envName : undefined;
}

function buildSessionEnv(runtime: RuntimeKind | "all", sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  copyEnvKeys(env, HOST_ENV_KEYS, sourceEnv);
  copyEnvKeys(env, SHARED_SESSION_ENV_KEYS, sourceEnv);

  if (runtime === "all") {
    copyEnvKeys(env, RUNTIME_SESSION_ENV_KEYS.claude, sourceEnv);
    copyEnvKeys(env, RUNTIME_SESSION_ENV_KEYS.codex, sourceEnv);
  } else {
    copyEnvKeys(env, RUNTIME_SESSION_ENV_KEYS[runtime], sourceEnv);
  }

  return env;
}

function injectAccountSecretEnv(env: Record<string, string>, account: Account, secret: string, runtime: RuntimeKind): void {
  env[sanitizeEnvKey(account.id)] = secret;

  const secretEnvName = secretRefEnvName(account.secretRef);
  if (secretEnvName) {
    env[secretEnvName] = secret;
  }

  const configuredEnvKey = getRuntimeEnvKey(account, runtime);
  if (configuredEnvKey) {
    env[configuredEnvKey] = secret;
  }

  if (runtime === "claude") {
    injectClaudeCompatibilityEnv(env, account, secret);
  } else {
    injectCodexCompatibilityEnv(env, account, secret);
  }
}

function injectClaudeCompatibilityEnv(env: Record<string, string>, account: Account, secret: string): void {
  if (account.vendor === "anthropic") {
    env.ANTHROPIC_API_KEY = secret;
  }

  if (account.vendor === "anthropic-compatible") {
    env.ANTHROPIC_AUTH_TOKEN = secret;
    if (account.baseUrl) {
      env.ANTHROPIC_BASE_URL = account.baseUrl;
    }
  }
}

function injectCodexCompatibilityEnv(env: Record<string, string>, account: Account, secret: string): void {
  if (account.vendor === "openai") {
    env.OPENAI_API_KEY = secret;
  }
}

function copyEnvKeys(output: Record<string, string>, keys: string[], sourceEnv: NodeJS.ProcessEnv): void {
  for (const key of keys) {
    const value = readEnv(sourceEnv, key);
    if (value !== undefined) {
      output[key] = value;
    }
  }
}

function removeEnvKeys(output: Record<string, string>, keys: string[]): void {
  for (const key of keys) {
    delete output[key];
  }
}

function readEnv(sourceEnv: NodeJS.ProcessEnv, key: string): string | undefined {
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

function stringExtra(extraConfig: Account["extraConfig"], keys: string[]): string | undefined {
  if (!extraConfig) {
    return undefined;
  }

  for (const key of keys) {
    const value = extraConfig[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}
