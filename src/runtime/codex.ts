import process from "node:process";
import { randomUUID } from "node:crypto";
import { Codex, type ApprovalMode, type CodexOptions, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import type { AgentEvent, Policy, VendorKind } from "../core/types.js";
import { sanitizeEnvKey } from "../core/credentials.js";
import { createCodexMcpServerConfig } from "../mcp/codex-binding.js";
import { BaseRuntimeAdapter, type RuntimeDependencies } from "./base.js";
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
    const profile = this.getProfile(input.profileId);
    const account = this.getAccount(profile.accountId);
    const policy = this.getPolicy(profile.policyId);
    const codex = new Codex(await this.buildCodexOptions(account.id, input.taskId, input.cwd));
    const thread = codex.startThread(this.toThreadOptions(policy, input.cwd, profile.model));
    this.threads.set(input.taskId, thread);

    return {
      taskId: input.taskId,
      ...(thread.id ? { backendThreadId: thread.id } : {}),
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
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
    const profile = this.getProfile(input.profileId);
    const account = this.getAccount(profile.accountId);
    const policy = this.getPolicy(profile.policyId);
    const codex = new Codex(await this.buildCodexOptions(account.id, input.taskId, input.cwd));
    const thread = codex.resumeThread(input.backendThreadId, this.toThreadOptions(policy, input.cwd, profile.model));
    this.threads.set(input.taskId, thread);

    return {
      taskId: input.taskId,
      backendThreadId: input.backendThreadId,
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(taskId);
    }
  }

  async closeTask(taskId: string): Promise<void> {
    this.abortControllers.delete(taskId);
    this.threads.delete(taskId);
  }

  private async buildCodexOptions(accountId: string, taskId: string, cwd?: string): Promise<CodexOptions> {
    const account = this.getAccount(accountId);
    const env = await this.resolveSecretEnv(account);
    const providerConfig = buildCodexProviderConfig(account.vendor, account.id, account.baseUrl);
    const mcpConfig = createCodexMcpServerConfig({
      config: this.deps.config,
      configPath: this.getConfigPath(),
      taskId,
      cwd,
    });

    const config: CodexConfigObject = {
      ...(providerConfig ?? {}),
      mcp_servers: {
        auto_pm_lite: {
          ...(mcpConfig.command ? { command: mcpConfig.command } : {}),
          ...(mcpConfig.args ? { args: mcpConfig.args } : {}),
          ...(mcpConfig.url ? { url: mcpConfig.url } : {}),
          ...(mcpConfig.env ? { env: mcpConfig.env } : {}),
          ...(mcpConfig.cwd ? { cwd: mcpConfig.cwd } : {}),
        },
      },
    };

    return {
      env: {
        PATH: process.env.PATH ?? "",
        ...env,
      },
      config,
    };
  }

  private toThreadOptions(policy: Policy, cwd: string | undefined, model: string): ThreadOptions {
    return {
      model,
      ...(cwd ? { workingDirectory: cwd } : {}),
      skipGitRepoCheck: true,
      sandboxMode: policy.sandboxMode,
      approvalPolicy: mapApprovalPolicy(policy.approvalPolicy),
      networkAccessEnabled: policy.networkAllowed,
    };
  }
}

function buildCodexProviderConfig(vendor: VendorKind, accountId: string, baseUrl?: string): CodexConfigObject | undefined {
  if (!requiresCustomCodexProvider(vendor) || !baseUrl) {
    return undefined;
  }

  const providerId = accountId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "auto_pm";
  return {
    model_provider: providerId,
    model_providers: {
      [providerId]: {
        base_url: baseUrl,
        env_key: sanitizeEnvKey(accountId),
      },
    },
  };
}

function requiresCustomCodexProvider(vendor: VendorKind): boolean {
  return vendor === "openai-compatible" || vendor === "openai-azure";
}

function mapApprovalPolicy(policy: Policy["approvalPolicy"]): ApprovalMode {
  switch (policy) {
    case "never":
      return "never";
    case "untrusted":
      return "untrusted";
    case "on-request":
      return "on-request";
    case "orchestrator":
    default:
      return "on-request";
  }
}
