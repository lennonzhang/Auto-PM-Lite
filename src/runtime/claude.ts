import { forkSession, query, type CanUseTool, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeMcpServer } from "../mcp/claude-binding.js";
import { AutoPmMcpService } from "../mcp/auto-pm-service.js";
import { allowedClaudeTools, classifyClaudeTool, isClaudeEditTool } from "../orchestrator/policy.js";
import { BaseRuntimeAdapter, type RuntimeDependencies } from "./base.js";
import type { ForkRuntimeSessionInput, ForkRuntimeSessionResult, ResumeRuntimeTaskInput, RunTurnInput, RuntimeAdapter, RuntimeAdapterOutput, RuntimeSessionControlInput, RuntimeTaskHandle, StartRuntimeTaskInput } from "./adapter.js";
import { createClaudeV2NormalizerState, normalizeClaudeMessageV2 } from "./normalize/claude-v2.js";

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
      sessionId: input.sessionId,
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<RuntimeAdapterOutput> {
    this.writeRuntimeLog(`runtime.turn.start runtime=claude taskId=${input.taskId} profileId=${input.profileId}`);
    const profile = this.getProfile(input.profileId);
    if (profile.runtime !== "claude") {
      throw new Error(`Profile ${profile.id} is not a Claude profile`);
    }
    const account = this.getAccount(profile.accountId);
    const policy = this.getPolicy(profile.policyId);
    const state = createClaudeV2NormalizerState();

    yield { event: { kind: "turn.started", turnId: input.turnId } };

    const options: Options = {
      cwd: input.cwd,
      model: input.model,
      env: await this.resolveSecretEnv(account, this.runtime),
      permissionMode: profile.claudePermissionMode,
      ...(profile.claudePermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    };
    const resume = this.resumeIds.get(input.sessionId);
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
    this.sessions.set(input.sessionId, session);

    try {
      for await (const message of session) {
        const events = normalizeClaudeMessageV2({
          taskId: input.taskId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          cwd: input.cwd,
          message,
          state,
        });
        if (events.length > 0) {
          yield { raw: message, events };
        }
      }
    } finally {
      this.sessions.delete(input.sessionId);
    }
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.writeRuntimeLog(`runtime.task.resume runtime=claude taskId=${input.taskId} profileId=${input.profileId}`);
    this.resumeIds.set(input.sessionId, input.backendThreadId);
    return {
      taskId: input.taskId,
      sessionId: input.sessionId,
      backendThreadId: input.backendThreadId,
    };
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<ForkRuntimeSessionResult> {
    this.writeRuntimeLog(`runtime.session.fork runtime=claude taskId=${input.taskId} sourceSessionId=${input.sourceSessionId} targetSessionId=${input.targetSessionId}`);
    const result = await forkSession(input.sourceBackendThreadId, {
      dir: input.cwd,
      ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
    });
    return {
      backendThreadId: result.sessionId,
      forkKind: "native",
    };
  }

  async interruptSession(input: RuntimeSessionControlInput): Promise<void> {
    this.writeRuntimeLog(`runtime.session.interrupt runtime=claude sessionId=${input.sessionId} backendThreadId=${input.backendThreadId ?? ""}`);
    const session = this.sessions.get(input.sessionId);
    if (session) {
      await session.interrupt();
      this.sessions.delete(input.sessionId);
    }
  }

  async pauseSession(input: RuntimeSessionControlInput): Promise<void> {
    this.writeRuntimeLog(`runtime.session.pause runtime=claude sessionId=${input.sessionId} backendThreadId=${input.backendThreadId ?? ""}`);
    await this.interruptSession(input);
  }

  async closeSession(input: RuntimeSessionControlInput): Promise<void> {
    this.writeRuntimeLog(`runtime.session.close runtime=claude sessionId=${input.sessionId} backendThreadId=${input.backendThreadId ?? ""}`);
    this.sessions.delete(input.sessionId);
    this.resumeIds.delete(input.sessionId);
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
