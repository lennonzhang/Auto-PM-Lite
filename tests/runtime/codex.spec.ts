import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexRuntimeAdapter } from "../../src/runtime/codex.js";
import type { AppConfig } from "../../src/core/types.js";
import type { RuntimeAdapterOutput } from "../../src/runtime/adapter.js";

describe("CodexRuntimeAdapter", () => {
  it("maps account extraConfig to Codex provider config like the launcher script", async () => {
    const adapter = new CodexRuntimeAdapter({
      config: buildConfig(),
      configPath: "D:/tmp/auto-pm-lite/config.toml",
      secretBackend: {
        async resolve() {
          return "secret-value";
        },
      },
    });

    const options = await (
      adapter as unknown as {
        buildCodexOptions(accountId: string, taskId: string, cwd?: string): Promise<{
          baseUrl?: string;
          env?: Record<string, string>;
          config?: Record<string, unknown>;
        }>;
      }
    ).buildCodexOptions("vip", "task-123", "D:/Code/Auto-PM-Lite");

    expect(options.baseUrl).toBeUndefined();
    expect(options.env?.OPENAI_API_KEY).toBe("secret-value");
    expect(options.config).toMatchObject({
      model_provider: "vip_provider",
      model_context_window: 350000,
      model_auto_compact_token_limit: 250000,
      model_reasoning_effort: "xhigh",
      model_providers: {
        vip_provider: {
          name: "vip_provider",
          base_url: "https://vip.example.invalid/v1",
          wire_api: "responses",
          env_key: "OPENAI_API_KEY",
          requires_openai_auth: true,
          supports_websockets: true,
        },
      },
      features: {
        responses_websockets_v2: true,
      },
      mcp_servers: {
        auto_pm_lite: {
          enabled: true,
          startup_timeout_sec: 30,
        },
      },
    });
  });

  it("uses local auth without injecting key env or custom provider config", async () => {
    const adapter = new CodexRuntimeAdapter({
      config: buildConfig({
        secretRef: "env:OPENAI_API_KEY",
      }),
      configPath: "D:/tmp/auto-pm-lite/config.toml",
      sourceEnv: {
        PATH: "C:/tools",
        CODEX_AUTH_MODE: "local",
        OPENAI_API_KEY: "should-not-pass",
      },
      secretBackend: {
        async resolve() {
          throw new Error("should not resolve secret in local auth mode");
        },
      },
    });

    const options = await (
      adapter as unknown as {
        buildCodexOptions(accountId: string, taskId: string, cwd?: string): Promise<{
          baseUrl?: string;
          env?: Record<string, string>;
          config?: Record<string, unknown>;
        }>;
      }
    ).buildCodexOptions("vip", "task-123", "D:/Code/Auto-PM-Lite");

    expect(options.baseUrl).toBeUndefined();
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.config).not.toHaveProperty("model_provider");
    expect(options.config).not.toHaveProperty("model_providers");
    expect(options.config).toMatchObject({
      mcp_servers: {
        auto_pm_lite: {
          enabled: true,
          startup_timeout_sec: 30,
        },
      },
    });
  });

  it("builds thread options from Codex profile native permissions", () => {
    const adapter = new CodexRuntimeAdapter({
      config: buildConfig(),
      configPath: "D:/tmp/auto-pm-lite/config.toml",
      secretBackend: {
        async resolve() {
          return "secret-value";
        },
      },
    });

    const options = (
      adapter as unknown as {
        toThreadOptions(profile: AppConfig["profiles"][string], model: string, cwd?: string): Record<string, unknown>;
      }
    ).toThreadOptions({
      id: "codex_plan",
      runtime: "codex",
      accountId: "vip",
      policyId: "edit",
      model: "gpt-5-4",
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "never",
      codexNetworkAccessEnabled: true,
    }, "gpt-5-4", "D:/Code/Auto-PM-Lite");

    expect(options).toMatchObject({
      model: "gpt-5-4",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      workingDirectory: "D:/Code/Auto-PM-Lite",
    });
    expect(options).not.toHaveProperty("mode");
  });

  it("ignores Windows taskkill parse noise after a Codex turn terminal event", async () => {
    const adapter = buildAdapterWithThread(fakeThread([
      turnStarted(),
      turnCompleted(),
      new Error("Failed to parse item: SUCCESS: The process with PID 1234 (child process of PID 5678) has been terminated."),
    ]));

    const outputs = await collectRunTurn(adapter);

    expect(outputs.map((output) => outputEvents(output).map((event) => event.kind))).toEqual([
      ["turn.started"],
      ["turn.completed"],
    ]);
  });

  it("does not ignore Windows taskkill parse noise before a Codex turn terminal event", async () => {
    const adapter = buildAdapterWithThread(fakeThread([
      turnStarted(),
      new Error("Failed to parse item: SUCCESS: The process with PID 1234 has been terminated."),
    ]));

    await expect(collectRunTurn(adapter)).rejects.toThrow("Failed to parse item: SUCCESS: The process with PID 1234 has been terminated.");
  });

  it("does not ignore unrelated parse errors after a Codex turn terminal event", async () => {
    const adapter = buildAdapterWithThread(fakeThread([
      turnCompleted(),
      new Error("Failed to parse item: not json"),
    ]));

    await expect(collectRunTurn(adapter)).rejects.toThrow("Failed to parse item: not json");
  });
});

function buildConfig(overrides?: { secretRef?: string | undefined }): AppConfig {
  return {
    accounts: {
      vip: {
        id: "vip",
        vendor: "openai-compatible",
        baseUrl: "https://vip.example.invalid/v1",
        secretRef: overrides?.secretRef ?? "env:OPENAI_API_KEY",
        extraConfig: {
          provider: "vip_provider",
          env_key: "OPENAI_API_KEY",
          wire_api: "responses",
          requires_openai_auth: true,
          supports_websockets: true,
          model_context_window: 350000,
          model_auto_compact_token_limit: 250000,
          model_reasoning_effort: "xhigh",
          codex_config: {
            features: {
              responses_websockets_v2: true,
            },
          },
        },
      },
    },
    policies: {},
    profiles: {},
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

function buildAdapterWithThread(thread: FakeThread): CodexRuntimeAdapter {
  const adapter = new CodexRuntimeAdapter({
    config: buildConfig(),
    configPath: "D:/tmp/auto-pm-lite/config.toml",
    secretBackend: {
      async resolve() {
        return "secret-value";
      },
    },
  });
  (adapter as unknown as { threads: Map<string, FakeThread> }).threads.set("session-1", thread);
  return adapter;
}

async function collectRunTurn(adapter: CodexRuntimeAdapter) {
  const outputs: RuntimeAdapterOutput[] = [];
  for await (const output of adapter.runTurn({
    taskId: "task-1",
    sessionId: "session-1",
    turnId: "turn-1",
    profileId: "codex_plan",
    model: "gpt-5-4",
    cwd: "D:/Code/Auto-PM-Lite",
    prompt: "hello",
  })) {
    outputs.push(output);
  }
  return outputs;
}

function outputEvents(output: RuntimeAdapterOutput) {
  return "events" in output ? output.events : [output.event];
}

interface FakeThread {
  id?: string | undefined;
  runStreamed(prompt: string, options: { signal: AbortSignal }): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

function fakeThread(events: Array<ThreadEvent | Error>): FakeThread {
  return {
    id: "thread-1",
    async runStreamed() {
      return {
        events: fakeEventStream(events),
      };
    },
  };
}

async function* fakeEventStream(events: Array<ThreadEvent | Error>): AsyncIterable<ThreadEvent> {
  for (const event of events) {
    if (event instanceof Error) {
      throw event;
    }
    yield event;
  }
}

function turnStarted(): ThreadEvent {
  return { type: "turn.started" };
}

function turnCompleted(): ThreadEvent {
  return {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
    },
  };
}
