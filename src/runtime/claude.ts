import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../core/types.js";
import { createClaudeMcpServer } from "../mcp/claude-binding.js";
import { AutoPmMcpService } from "../mcp/auto-pm-service.js";
import { allowedClaudeTools, classifyClaudeTool, isClaudeEditTool } from "../orchestrator/policy.js";
import { BaseRuntimeAdapter, type RuntimeDependencies } from "./base.js";
import type { ResumeRuntimeTaskInput, RunTurnInput, RuntimeAdapter, RuntimeTaskHandle, StartRuntimeTaskInput } from "./adapter.js";
import { normalizeClaudeMessage } from "./normalize/claude.js";

export interface ClaudeRuntimeDependencies extends RuntimeDependencies {
  createMcpHandlers?: ((taskId: string) => ConstructorParameters<typeof AutoPmMcpService>[0]) | undefined;
  requestApproval?: ((input: {
    taskId: string;
    kind: NonNullable<ReturnType<typeof classifyClaudeTool>>;
    reason: string;
    payload: Record<string, unknown>;
  }) => Promise<{ approvalId: string; status: "pending" }>) | undefined;
}

export class ClaudeRuntimeAdapter extends BaseRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "claude" as const;
  private readonly sessions = new Map<string, Query>();
  private readonly resumeIds = new Map<string, string>();
  private readonly createMcpHandlers?: ClaudeRuntimeDependencies["createMcpHandlers"];
  private readonly requestApproval?: ClaudeRuntimeDependencies["requestApproval"];

  constructor(deps: ClaudeRuntimeDependencies) {
    super(deps);
    this.createMcpHandlers = deps.createMcpHandlers;
    this.requestApproval = deps.requestApproval;
  }

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.writeRuntimeLog(`runtime.task.start runtime=claude taskId=${input.taskId} profileId=${input.profileId}`);
    return {
      taskId: input.taskId,
      backendThreadId: input.taskId,
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    this.writeRuntimeLog(`runtime.turn.start runtime=claude taskId=${input.taskId} profileId=${input.profileId}`);
    const profile = this.getProfile(input.profileId);
    if (profile.runtime !== "claude") {
      throw new Error(`Profile ${profile.id} is not a Claude profile`);
    }
    const account = this.getAccount(profile.accountId);
    const policy = this.getPolicy(profile.policyId);
    const turnId = randomUUID();

    yield { type: "turn.started", taskId: input.taskId, turnId, ts: new Date().toISOString() };

    const options: Options = {
      cwd: input.cwd,
      model: input.model,
      env: await this.resolveSecretEnv(account, this.runtime),
      permissionMode: profile.claudePermissionMode,
      ...(profile.claudePermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    };
    const resume = this.resumeIds.get(input.taskId);
    if (resume) {
      options.resume = resume;
    }

    if (this.createMcpHandlers) {
      options.mcpServers = {
        auto_pm_lite: createClaudeMcpServer(new AutoPmMcpService(this.createMcpHandlers(input.taskId))),
      };
    }

    const allowedTools = allowedClaudeTools(policy);
    if (allowedTools) {
      options.allowedTools = allowedTools;
    } else {
      options.canUseTool = createApprovalCallback(input.taskId, policy, this.requestApproval);
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
    this.writeRuntimeLog(`runtime.task.resume runtime=claude taskId=${input.taskId} profileId=${input.profileId}`);
    this.resumeIds.set(input.taskId, input.backendThreadId);
    return {
      taskId: input.taskId,
      backendThreadId: input.backendThreadId,
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    this.writeRuntimeLog(`runtime.task.cancel runtime=claude taskId=${taskId}`);
    const session = this.sessions.get(taskId);
    if (session) {
      await session.interrupt();
      this.sessions.delete(taskId);
    }
  }

  async pauseTask(taskId: string): Promise<void> {
    this.writeRuntimeLog(`runtime.task.pause runtime=claude taskId=${taskId}`);
    await this.cancelTask(taskId);
  }

  async closeTask(taskId: string): Promise<void> {
    this.sessions.delete(taskId);
    this.resumeIds.delete(taskId);
  }
}

function createApprovalCallback(
  taskId: string,
  policy: ReturnType<BaseRuntimeAdapter["getPolicy"]>,
  requestApproval: ClaudeRuntimeDependencies["requestApproval"],
): CanUseTool {
  return async (toolName, input) => {
    if (!shouldAutoApproveTool(policy, toolName)) {
      const kind = classifyClaudeTool(toolName) ?? "workspace_write";
      if (requestApproval) {
        await requestApproval({
          taskId,
          kind,
          reason: `Claude requested tool: ${toolName}`,
          payload: { toolName, input },
        });
      }
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

  if (policy.permissionMode === "edit" && isClaudeEditTool(toolName)) {
    return true;
  }

  return false;
}
