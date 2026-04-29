import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../core/types.js";
import { createClaudeMcpServer } from "../mcp/claude-binding.js";
import { AutoPmMcpService } from "../mcp/auto-pm-service.js";
import { allowedClaudeTools, mapClaudePermissionMode } from "../orchestrator/policy.js";
import { BaseRuntimeAdapter, type RuntimeDependencies } from "./base.js";
import type { ResumeRuntimeTaskInput, RunTurnInput, RuntimeAdapter, RuntimeTaskHandle, StartRuntimeTaskInput } from "./adapter.js";
import { normalizeClaudeMessage } from "./normalize/claude.js";

export interface ClaudeRuntimeDependencies extends RuntimeDependencies {
  createMcpHandlers?: ((taskId: string) => ConstructorParameters<typeof AutoPmMcpService>[0]) | undefined;
}

export class ClaudeRuntimeAdapter extends BaseRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "claude" as const;
  private readonly sessions = new Map<string, Query>();
  private readonly createMcpHandlers?: ClaudeRuntimeDependencies["createMcpHandlers"];

  constructor(deps: ClaudeRuntimeDependencies) {
    super(deps);
    this.createMcpHandlers = deps.createMcpHandlers;
  }

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return {
      taskId: input.taskId,
      backendThreadId: input.taskId,
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const profile = this.getProfile(input.profileId);
    const account = this.getAccount(profile.accountId);
    const policy = this.getPolicy(profile.policyId);
    const turnId = randomUUID();

    yield { type: "turn.started", taskId: input.taskId, turnId, ts: new Date().toISOString() };

    const options: Options = {
      cwd: input.cwd,
      model: profile.model,
      env: await this.resolveSecretEnv(account),
      permissionMode: mapClaudePermissionMode(policy),
    };

    if (this.createMcpHandlers) {
      options.mcpServers = {
        auto_pm_lite: createClaudeMcpServer(new AutoPmMcpService(this.createMcpHandlers(input.taskId))),
      };
    }

    const allowedTools = allowedClaudeTools(policy);
    if (allowedTools) {
      options.allowedTools = allowedTools;
    } else {
      options.canUseTool = createApprovalCallback(policy);
    }

    const session = query({
      prompt: input.prompt,
      options,
    });
    this.sessions.set(input.taskId, session);

    try {
      for await (const message of session) {
        for (const event of normalizeClaudeMessage(input.taskId, message, turnId)) {
          yield event;
        }
      }
    } finally {
      this.sessions.delete(input.taskId);
    }
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return {
      taskId: input.taskId,
      backendThreadId: input.backendThreadId,
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session) {
      await session.interrupt();
      this.sessions.delete(taskId);
    }
  }

  async closeTask(taskId: string): Promise<void> {
    this.sessions.delete(taskId);
  }
}

function createApprovalCallback(policy: ReturnType<BaseRuntimeAdapter["getPolicy"]>): CanUseTool {
  return async (toolName, input) => {
    if (!shouldAutoApproveTool(policy, toolName)) {
      return {
        behavior: "deny",
        message: `Tool requires orchestrator approval: ${toolName}`,
        interrupt: true,
      };
    }

    return {
      behavior: "allow",
      updatedInput: input,
    };
  };
}

function shouldAutoApproveTool(policy: ReturnType<BaseRuntimeAdapter["getPolicy"]>, toolName: string): boolean {
  if (policy.permissionMode === "full") {
    return true;
  }

  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    return true;
  }

  if (policy.permissionMode === "edit" && toolName === "Edit") {
    return true;
  }

  return false;
}
