import { describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../../src/runtime/codex.js";
import type { AppConfig } from "../../src/core/types.js";

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
      model: "gpt-5-codex",
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "never",
      codexNetworkAccessEnabled: true,
    }, "gpt-5-codex", "D:/Code/Auto-PM-Lite");

    expect(options).toMatchObject({
      model: "gpt-5-codex",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      workingDirectory: "D:/Code/Auto-PM-Lite",
    });
    expect(options).not.toHaveProperty("mode");
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
