import { forkSession, query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeMcpServer } from "../mcp/claude-binding.js";
import { AutoPmMcpService } from "../mcp/auto-pm-service.js";
import { allowedClaudeTools, classifyClaudeTool, isClaudeEditTool } from "../orchestrator/policy.js";
import { BaseRuntimeAdapter, type RuntimeDependencies } from "./base.js";
import type { ForkRuntimeSessionInput, ForkRuntimeSessionResult, OpenRuntimeSessionInput, RunTurnInput, RuntimeAdapter, RuntimeAdapterOutput, RuntimeSessionControlInput, RuntimeTaskHandle } from "./adapter.js";
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
  private readonly sessions = new Map<string, ClaudeLiveSession>();
  private readonly createMcpHandlers?: ClaudeRuntimeDependencies["createMcpHandlers"];
  private readonly requestApproval?: ClaudeRuntimeDependencies["requestApproval"];

  constructor(deps: ClaudeRuntimeDependencies) {
    super(deps);
    this.createMcpHandlers = deps.createMcpHandlers;
    this.requestApproval = deps.requestApproval;
  }

  async openSession(input: OpenRuntimeSessionInput): Promise<RuntimeTaskHandle> {
    this.writeRuntimeLog(`runtime.session.open runtime=claude taskId=${input.taskId} sessionId=${input.sessionId} profileId=${input.profileId} backendThreadId=${input.backendThreadId ?? ""}`);
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      return {
        taskId: input.taskId,
        sessionId: input.sessionId,
        ...(existing.backendThreadId ? { backendThreadId: existing.backendThreadId } : input.backendThreadId ? { backendThreadId: input.backendThreadId } : {}),
      };
    }

    const profile = this.getProfile(input.profileId);
    if (profile.runtime !== "claude") {
      throw new Error(`Profile ${profile.id} is not a Claude profile`);
    }
    const account = this.getAccount(profile.accountId);
    const policy = this.getPolicy(profile.policyId);
    const queue = new ClaudeInputQueue();
    const options = await this.buildClaudeOptions({
      taskId: input.taskId,
      profileId: input.profileId,
      model: input.model,
      cwd: input.cwd,
      accountId: account.id,
      policy,
      backendThreadId: input.backendThreadId,
    });
    const session = this.createClaudeQuery(queue, options);
    this.sessions.set(input.sessionId, {
      query: session,
      queue,
      iterator: session[Symbol.asyncIterator](),
      ...(input.backendThreadId ? { backendThreadId: input.backendThreadId } : {}),
    });

    return {
      taskId: input.taskId,
      sessionId: input.sessionId,
      ...(input.backendThreadId ? { backendThreadId: input.backendThreadId } : {}),
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<RuntimeAdapterOutput> {
    this.writeRuntimeLog(`runtime.turn.start runtime=claude taskId=${input.taskId} profileId=${input.profileId}`);
    const live = this.sessions.get(input.sessionId);
    if (!live) {
      throw new Error(`No Claude session for session ${input.sessionId}`);
    }
    const state = createClaudeV2NormalizerState();
    let sawResult = false;

    yield { event: { kind: "turn.started", turnId: input.turnId } };
    live.queue.push(userMessage(input.prompt, live.backendThreadId));
    while (!sawResult) {
      const next = await live.iterator.next();
      if (next.done) {
        break;
      }
      const message = next.value;
      const messageSessionId = sessionIdFromMessage(message);
      if (messageSessionId) {
        live.backendThreadId = messageSessionId;
      }
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
      if (message.type === "result") {
        sawResult = true;
      }
    }
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

  async interruptTurn(input: RuntimeSessionControlInput): Promise<void> {
    this.writeRuntimeLog(`runtime.turn.interrupt runtime=claude sessionId=${input.sessionId} backendThreadId=${input.backendThreadId ?? ""}`);
    const live = this.sessions.get(input.sessionId);
    if (live) {
      await live.query.interrupt();
    }
  }

  async terminateSession(input: RuntimeSessionControlInput): Promise<void> {
    this.writeRuntimeLog(`runtime.session.terminate runtime=claude sessionId=${input.sessionId} backendThreadId=${input.backendThreadId ?? ""}`);
    const live = this.sessions.get(input.sessionId);
    if (live) {
      live.queue.close();
      live.query.close();
      this.sessions.delete(input.sessionId);
    }
  }

  hasLiveSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async shutdown(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.terminateSession({ sessionId });
    }
  }

  private async buildClaudeOptions(input: {
    taskId: string;
    profileId: string;
    model: string;
    cwd: string;
    accountId: string;
    policy: ReturnType<BaseRuntimeAdapter["getPolicy"]>;
    backendThreadId?: string | undefined;
  }): Promise<Options> {
    const profile = this.getProfile(input.profileId);
    if (profile.runtime !== "claude") {
      throw new Error(`Profile ${profile.id} is not a Claude profile`);
    }
    const account = this.getAccount(input.accountId);
    const options: Options = {
      cwd: input.cwd,
      model: input.model,
      env: await this.resolveSecretEnv(account, this.runtime),
      permissionMode: profile.claudePermissionMode,
      ...(profile.claudePermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(input.backendThreadId ? { resume: input.backendThreadId } : {}),
    };

    if (this.createMcpHandlers) {
      options.mcpServers = {
        auto_pm_lite: createClaudeMcpServer(new AutoPmMcpService(this.createMcpHandlers(input.taskId))),
      };
    }

    const allowedTools = allowedClaudeTools(input.policy);
    if (allowedTools) {
      options.allowedTools = allowedTools;
    } else {
      options.canUseTool = createApprovalCallback(input.taskId, input.policy, this.requestApproval);
    }

    return options;
  }

  protected createClaudeQuery(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query {
    return query({
      prompt,
      options,
    });
  }
}

interface ClaudeLiveSession {
  query: Query;
  queue: ClaudeInputQueue;
  iterator: AsyncIterator<SDKMessage, void>;
  backendThreadId?: string | undefined;
}

class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Claude input queue is closed");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.pending.shift();
        if (value) {
          return { value, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function userMessage(text: string, sessionId: string | undefined): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
    parent_tool_use_id: null,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function sessionIdFromMessage(message: SDKMessage): string | undefined {
  return typeof message === "object" && message !== null && "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
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
