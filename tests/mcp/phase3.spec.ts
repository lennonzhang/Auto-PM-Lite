import { describe, expect, it, vi } from "vitest";
import { AutoPmMcpService } from "../../src/mcp/auto-pm-service.js";
import { buildCodexMcpServerEnv, createCodexMcpServerConfig } from "../../src/mcp/codex-binding.js";
import type { AppConfig, Policy, Profile } from "../../src/core/types.js";

const policy: Policy = {
  id: "readonly_policy",
  permissionMode: "read-only",
  sandboxMode: "read-only",
  networkAllowed: false,
  approvalPolicy: "orchestrator",
  requireApprovalFor: [],
  maxDepth: 2,
  allowCrossHarnessDelegation: true,
  allowChildEdit: false,
  allowChildNetwork: false,
};

const codexProfile: Profile = {
  id: "codex_child",
  runtime: "codex",
  accountId: "openai_personal",
  policyId: "readonly_policy",
  model: "gpt-5-codex",
  codexSandboxMode: "read-only",
  codexApprovalPolicy: "on-request",
  codexNetworkAccessEnabled: false,
};

const config: AppConfig = {
  accounts: {
    anthropic_personal: {
      id: "anthropic_personal",
      vendor: "anthropic",
      secretRef: "env:ANTHROPIC_API_KEY",
    },
    openai_personal: {
      id: "openai_personal",
      vendor: "openai",
      secretRef: "env:OPENAI_API_KEY",
    },
  },
  policies: {
    readonly_policy: policy,
  },
  profiles: {
    codex_child: codexProfile,
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

describe("AutoPmMcpService", () => {
  it("exposes the same tool surface for stdio MCP as Claude in-process", async () => {
    const handlers = {
      delegateTo: vi.fn(async (input) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, input }) }],
      })),
      requestCapability: vi.fn(async (input) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ capability: input.kind }) }],
      })),
      waitForTask: vi.fn(async (input) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ taskId: input.taskId, status: "completed" }) }],
      })),
      getTaskResult: vi.fn(async (input) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ taskId: input.taskId, latestMessage: "done" }) }],
      })),
      reportArtifact: vi.fn(async (input) => ({
        content: [{ type: "text" as const, text: JSON.stringify(input) }],
      })),
    };
    const service = new AutoPmMcpService(handlers);

    expect(service.toClaudeTools().map((tool) => tool.name)).toEqual([
      "delegate_to",
      "request_capability",
      "wait_for_task",
      "get_task_result",
      "report_artifact",
    ]);

    expect(service.listMcpTools().map((tool) => tool.name)).toEqual([
      "delegate_to",
      "request_capability",
      "wait_for_task",
      "get_task_result",
      "report_artifact",
    ]);

    const result = await service.invokeTool("delegate_to", {
      targetRuntime: "codex",
      taskType: "ask",
      prompt: "review this",
      reason: "cross-check",
      requestedPermissionMode: "read-only",
      workspaceMode: "share",
    });

    expect(handlers.delegateTo).toHaveBeenCalledOnce();
    expect(result.content[0]?.text).toContain("cross-check");
  });

  it("rejects unknown tools and invalid payloads", async () => {
    const service = new AutoPmMcpService({
      delegateTo: async () => ({ content: [] }),
      requestCapability: async () => ({ content: [] }),
      waitForTask: async () => ({ content: [] }),
      getTaskResult: async () => ({ content: [] }),
      reportArtifact: async () => ({ content: [] }),
    });

    await expect(service.invokeTool("missing_tool", {})).rejects.toThrow("Unknown MCP tool");
    await expect(service.invokeTool("request_capability", {})).rejects.toThrow();
  });
});

describe("Codex MCP binding", () => {
  it("builds a stdio server config with task-scoped bridge args", () => {
    const server = createCodexMcpServerConfig({
      config,
      configPath: "D:/Code/Auto-PM-Lite/tmp/config.toml",
      taskId: "task-123",
      cwd: "D:/Code/Auto-PM-Lite",
      entrypointPath: "D:/Code/Auto-PM-Lite/dist/index.js",
    });

    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      ...process.execArgv,
      expect.stringMatching(/dist[\\/]index\.js$/),
      "mcp:serve-stdio",
      "--config",
      expect.stringMatching(/tmp[\\/]config\.toml$/),
      "--task",
      "task-123",
    ]);
    expect(server.cwd).toBe("D:/Code/Auto-PM-Lite");
    expect(server.env?.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    expect(server.env?.OPENAI_API_KEY).toBe(process.env.OPENAI_API_KEY);
  });

  it("limits sidecar env to host essentials plus referenced secret vars", () => {
    const env = buildCodexMcpServerEnv(config);

    expect(Object.keys(env)).toEqual(expect.arrayContaining(["PATH"]));
    expect(env).not.toHaveProperty("UNRELATED_TEST_VAR");
  });

  it("produces a Codex-consumable Auto-PM server entry", () => {
    const server = createCodexMcpServerConfig({
      config,
      configPath: "D:/Code/Auto-PM-Lite/tmp/config.toml",
      taskId: "task-456",
      cwd: "D:/Code/Auto-PM-Lite",
      entrypointPath: "D:/Code/Auto-PM-Lite/dist/index.js",
    });

    expect(server.args).toEqual(expect.arrayContaining(["mcp:serve-stdio", "--task", "task-456"]));
    expect(server.env).toBeDefined();
    expect(server.url).toBeUndefined();
  });
});
