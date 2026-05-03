import { randomUUID } from "node:crypto";
import { Codex, type CodexOptions, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import type { Account, AgentEvent, CodexProfile, VendorKind } from "../core/types.js";
import { sanitizeEnvKey } from "../core/credentials.js";
import { isLocalSecretRef, sourceEnvAuthMode } from "../orchestrator/secrets.js";
import { createCodexMcpServerConfig } from "../mcp/codex-binding.js";
import { BaseRuntimeAdapter, type RuntimeDependencies } from "./base.js";
import { getRuntimeEnvKey } from "./env.js";
import type { ResumeRuntimeTaskInput, RunTurnInput, RuntimeAdapter, RuntimeTaskHandle, StartRuntimeTaskInput } from "./adapter.js";
import { normalizeCodexEvent } from "./normalize/codex.js";

type CodexConfigPrimitive = string | number | boolean;
type CodexConfigShape = CodexConfigPrimitive | CodexConfigShape[] | { [key: string]: CodexConfigShape };
type CodexConfigObject = { [key: string]: CodexConfigShape };

export class CodexRuntimeAdapter extends BaseRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "codex" as const;
  private readonly threads = new Map<string, Thread>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(deps: RuntimeDependencies) {
    super(deps);
  }

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.writeRuntimeLog(`runtime.task.start runtime=codex taskId=${input.taskId} profileId=${input.profileId}`);
    const profile = this.getProfile(input.profileId);
    if (profile.runtime !== "codex") {
      throw new Error(`Profile ${profile.id} is not a Codex profile`);
    }
    const account = this.getAccount(profile.accountId);
    const codex = new Codex(await this.buildCodexOptions(account.id, input.taskId, input.cwd));
    const thread = codex.startThread(this.toThreadOptions(profile, input.model, input.cwd));
    this.threads.set(input.taskId, thread);

    return {
      taskId: input.taskId,
      ...(thread.id ? { backendThreadId: thread.id } : {}),
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    this.writeRuntimeLog(`runtime.turn.start runtime=codex taskId=${input.taskId} profileId=${input.profileId}`);
    const thread = this.threads.get(input.taskId);
    if (!thread) {
      throw new Error(`No Codex thread for task ${input.taskId}`);
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    this.abortControllers.set(input.taskId, controller);

    try {
      const streamed = await thread.runStreamed(input.prompt, { signal: controller.signal });
      for await (const event of streamed.events) {
        for (const normalized of normalizeCodexEvent(input.taskId, event, turnId)) {
          yield normalized;
        }
      }
    } finally {
      this.abortControllers.delete(input.taskId);
    }
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.writeRuntimeLog(`runtime.task.resume runtime=codex taskId=${input.taskId} profileId=${input.profileId}`);
    const profile = this.getProfile(input.profileId);
    if (profile.runtime !== "codex") {
      throw new Error(`Profile ${profile.id} is not a Codex profile`);
    }
    const account = this.getAccount(profile.accountId);
    const codex = new Codex(await this.buildCodexOptions(account.id, input.taskId, input.cwd));
    const thread = codex.resumeThread(input.backendThreadId, this.toThreadOptions(profile, input.model, input.cwd));
    this.threads.set(input.taskId, thread);

    return {
      taskId: input.taskId,
      backendThreadId: input.backendThreadId,
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    this.writeRuntimeLog(`runtime.task.cancel runtime=codex taskId=${taskId}`);
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(taskId);
    }
  }

  async pauseTask(taskId: string): Promise<void> {
    this.writeRuntimeLog(`runtime.task.pause runtime=codex taskId=${taskId}`);
    await this.cancelTask(taskId);
  }

  async closeTask(taskId: string): Promise<void> {
    this.abortControllers.delete(taskId);
    this.threads.delete(taskId);
  }

  private async buildCodexOptions(accountId: string, taskId: string, cwd?: string): Promise<CodexOptions> {
    const account = this.getAccount(accountId);
    const env = await this.resolveSecretEnv(account, this.runtime);
    const localAuth = isLocalSecretRef(account.secretRef, this.runtime) || sourceEnvAuthMode(this.deps.sourceEnv, this.runtime) === "local";
    const customProvider = !localAuth && requiresCustomCodexProvider(account.vendor);
    const providerConfig = customProvider
      ? buildCodexProviderConfig(account)
      : undefined;
    const mcpConfig = createCodexMcpServerConfig({
      config: this.deps.config,
      configPath: this.getConfigPath(),
      taskId,
      cwd,
      sourceEnv: this.deps.sourceEnv,
    });

    const extraConfig = localAuth ? stripCodexProviderConfig(buildCodexExtraConfig(account)) : buildCodexExtraConfig(account);
    const config = mergeCodexConfig(extraConfig, providerConfig, {
      mcp_servers: {
        auto_pm_lite: {
          enabled: true,
          startup_timeout_sec: 30,
          ...(mcpConfig.command ? { command: mcpConfig.command } : {}),
          ...(mcpConfig.args ? { args: mcpConfig.args } : {}),
          ...(mcpConfig.url ? { url: mcpConfig.url } : {}),
          ...(mcpConfig.env ? { env: mcpConfig.env } : {}),
          ...(mcpConfig.cwd ? { cwd: mcpConfig.cwd } : {}),
        },
      },
    });

    // Provider routing: official OpenAI uses Codex's default auth path (no baseUrl, no provider config).
    // Custom providers (azure / openai-compatible) flow through `model_providers.<id>` only — never
    // top-level baseUrl, otherwise the SDK routes one way and the model_provider routes another.
    return {
      ...(localAuth || customProvider ? {} : account.baseUrl ? { baseUrl: account.baseUrl } : {}),
      env,
      config,
    };
  }

  private toThreadOptions(profile: CodexProfile, model: string, cwd: string | undefined): ThreadOptions {
    return {
      model,
      ...(cwd ? { workingDirectory: cwd } : {}),
      skipGitRepoCheck: true,
      sandboxMode: profile.codexSandboxMode,
      approvalPolicy: profile.codexApprovalPolicy,
      networkAccessEnabled: profile.codexNetworkAccessEnabled,
      additionalDirectories: cwd ? [cwd] : [],
    };
  }
}

function buildCodexProviderConfig(account: Account): CodexConfigObject | undefined {
  if (!account.baseUrl) {
    return undefined;
  }

  const providerId = stringExtra(account.extraConfig, [
    "codexProvider",
    "codex_provider",
    "provider",
    "providerId",
    "provider_id",
    "modelProvider",
    "model_provider",
  ]) ?? normalizedProviderId(account.id);
  const provider: CodexConfigObject = {
    base_url: account.baseUrl,
    env_key: getRuntimeEnvKey(account, "codex") ?? sanitizeEnvKey(account.id),
  };
  setStringConfig(provider, "name", account.extraConfig, ["providerName", "provider_name", "name"], providerId);
  setStringConfig(provider, "wire_api", account.extraConfig, ["wireApi", "wire_api"]);
  setBooleanConfig(provider, "requires_openai_auth", account.extraConfig, ["requiresOpenaiAuth", "requires_openai_auth"]);
  setBooleanConfig(provider, "supports_websockets", account.extraConfig, ["supportsWebsockets", "supports_websockets"]);

  return {
    model_provider: providerId,
    model_providers: {
      [providerId]: provider,
    },
  };
}

function buildCodexExtraConfig(account: Account): CodexConfigObject {
  const output: CodexConfigObject = {};
  const explicitConfig = objectExtra(account.extraConfig, ["codexConfig", "codex_config"]);
  if (explicitConfig) {
    Object.assign(output, explicitConfig);
  }

  setNumberConfig(output, "model_context_window", account.extraConfig, ["modelContextWindow", "model_context_window"]);
  setNumberConfig(output, "model_auto_compact_token_limit", account.extraConfig, [
    "modelAutoCompactTokenLimit",
    "model_auto_compact_token_limit",
  ]);
  setStringConfig(output, "model_reasoning_effort", account.extraConfig, ["modelReasoningEffort", "model_reasoning_effort"]);
  setStringConfig(output, "preferred_auth_method", account.extraConfig, ["preferredAuthMethod", "preferred_auth_method"]);

  return output;
}

function mergeCodexConfig(...configs: Array<CodexConfigObject | undefined>): CodexConfigObject {
  const output: CodexConfigObject = {};
  for (const config of configs) {
    if (config) {
      mergeInto(output, config);
    }
  }
  return output;
}

function stripCodexProviderConfig(config: CodexConfigObject): CodexConfigObject {
  const output = { ...config };
  delete output.model_provider;
  delete output.model_providers;
  return output;
}

function mergeInto(target: CodexConfigObject, source: CodexConfigObject): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isCodexConfigObject(existing) && isCodexConfigObject(value)) {
      mergeInto(existing, value);
    } else {
      target[key] = value;
    }
  }
}

function normalizedProviderId(accountId: string): string {
  return accountId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "auto_pm";
}

function setStringConfig(
  target: CodexConfigObject,
  key: string,
  extraConfig: Account["extraConfig"],
  aliases: string[],
  fallback?: string,
): void {
  const value = stringExtra(extraConfig, aliases) ?? fallback;
  if (value !== undefined) {
    target[key] = value;
  }
}

function setBooleanConfig(target: CodexConfigObject, key: string, extraConfig: Account["extraConfig"], aliases: string[]): void {
  const value = booleanExtra(extraConfig, aliases);
  if (value !== undefined) {
    target[key] = value;
  }
}

function setNumberConfig(target: CodexConfigObject, key: string, extraConfig: Account["extraConfig"], aliases: string[]): void {
  const value = numberExtra(extraConfig, aliases);
  if (value !== undefined) {
    target[key] = value;
  }
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

function booleanExtra(extraConfig: Account["extraConfig"], keys: string[]): boolean | undefined {
  if (!extraConfig) {
    return undefined;
  }

  for (const key of keys) {
    const value = extraConfig[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
      }
    }
  }

  return undefined;
}

function numberExtra(extraConfig: Account["extraConfig"], keys: string[]): number | undefined {
  if (!extraConfig) {
    return undefined;
  }

  for (const key of keys) {
    const value = extraConfig[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function objectExtra(extraConfig: Account["extraConfig"], keys: string[]): CodexConfigObject | undefined {
  if (!extraConfig) {
    return undefined;
  }

  for (const key of keys) {
    const value = extraConfig[key];
    if (isCodexConfigObject(value)) {
      return value;
    }
  }

  return undefined;
}

function isCodexConfigObject(value: unknown): value is CodexConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresCustomCodexProvider(vendor: VendorKind): boolean {
  return vendor === "openai-compatible" || vendor === "openai-azure";
}

