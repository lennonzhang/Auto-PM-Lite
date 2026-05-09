import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude.js";
import type { AppConfig } from "../../src/core/types.js";

describe("ClaudeRuntimeAdapter", () => {
  it("keeps one live streaming query for repeated opens of the same runtime session", async () => {
    const adapter = new ClaudeRuntimeAdapter({
      config: buildConfig(),
      configPath: "D:/tmp/auto-pm-lite/config.toml",
      secretBackend: {
        async resolve() {
          return "secret-value";
        },
      },
    });
    const created: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options; query: FakeQuery }> = [];
    (adapter as unknown as {
      createClaudeQuery(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query;
    }).createClaudeQuery = (prompt, options) => {
      const fake = new FakeQuery();
      created.push({ prompt, options, query: fake });
      return fake as unknown as Query;
    };

    const first = await adapter.openSession({
      taskId: "task-1",
      sessionId: "session-1",
      profileId: "claude_main",
      model: "claude-sonnet-4-6",
      cwd: "D:/Code/Auto-PM-Lite",
    });
    const second = await adapter.openSession({
      taskId: "task-1",
      sessionId: "session-1",
      profileId: "claude_main",
      model: "claude-sonnet-4-6",
      cwd: "D:/Code/Auto-PM-Lite",
      backendThreadId: "claude-session-1",
    });

    expect(first.backendThreadId).toBeUndefined();
    expect(second.backendThreadId).toBe("claude-session-1");
    expect(created).toHaveLength(1);
    expect(adapter.hasLiveSession("session-1")).toBe(true);
    expect(created[0]?.options).toMatchObject({
      cwd: "D:/Code/Auto-PM-Lite",
      model: "claude-sonnet-4-6",
      permissionMode: "acceptEdits",
    });
    expect(created[0]?.options.allowedTools).toBeUndefined();
    expect(created[0]?.options.canUseTool).toEqual(expect.any(Function));
  });
});

class FakeQuery implements AsyncIterable<SDKMessage> {
  interruptCount = 0;
  closeCount = 0;

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
    return {
      next: async () => ({ value: undefined, done: true }),
    };
  }
}

function buildConfig(): AppConfig {
  return {
    accounts: {
      anthropic: {
        id: "anthropic",
        vendor: "anthropic",
        secretRef: "env:ANTHROPIC_API_KEY",
      },
    },
    policies: {
      edit: {
        id: "edit",
        permissionMode: "edit",
        sandboxMode: "workspace-write",
        networkAllowed: false,
        approvalPolicy: "orchestrator",
        requireApprovalFor: [],
        maxDepth: 3,
        allowCrossHarnessDelegation: true,
        allowChildEdit: true,
        allowChildNetwork: false,
      },
    },
    profiles: {
      claude_main: {
        id: "claude_main",
        runtime: "claude",
        accountId: "anthropic",
        policyId: "edit",
        model: "claude-sonnet-4-6",
        claudePermissionMode: "acceptEdits",
      },
    },
    redaction: { additionalPatterns: [] },
    transcript: { storeRawEncrypted: false },
    storage: {
      dbPath: "D:/tmp/auto-pm-lite.db",
      busyTimeoutMs: 1000,
      maxQueueSize: 100,
      flushBatchSize: 10,
    },
    workspace: {
      rootDir: "D:/tmp/workspaces",
      topLevelUseWorktree: false,
    },
    scheduler: {
      maxConcurrentTasksGlobal: 5,
      maxConcurrentTasksPerAccount: 2,
    },
    rateLimit: {
      enabled: false,
    },
  };
}
