import { describe, expect, it } from "vitest";
import { buildMcpSidecarEnv, buildRuntimeEnv } from "../../src/runtime/env.js";
import type { Account, AppConfig } from "../../src/core/types.js";

describe("runtime environment injection", () => {
  it("passes Claude-compatible session overrides and account secret env", () => {
    const account: Account = {
      id: "claude_compatible",
      vendor: "anthropic-compatible",
      baseUrl: "https://example.invalid",
      secretRef: "env:ANTHROPIC_AUTH_TOKEN",
    };

    const env = buildRuntimeEnv({
      runtime: "claude",
      account,
      secret: "secret-value",
      sourceEnv: {
        PATH: "C:/tools",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "258000",
        CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
        ENABLE_PROMPT_CACHING_1H: "1",
        UNRELATED_TEST_VAR: "ignored",
      },
    });

    expect(env).toMatchObject({
      PATH: "C:/tools",
      ANTHROPIC_AUTH_TOKEN: "secret-value",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      AUTO_PM_KEY_CLAUDE_COMPATIBLE: "secret-value",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "258000",
      CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
      ENABLE_PROMPT_CACHING_1H: "1",
    });
    expect(env).not.toHaveProperty("UNRELATED_TEST_VAR");
  });

  it("passes Codex provider env_key and session-level provider variables", () => {
    const account: Account = {
      id: "codex_vip",
      vendor: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      secretRef: "env:OPENAI_API_KEY",
      extraConfig: {
        env_key: "OPENAI_API_KEY",
      },
    };

    const env = buildRuntimeEnv({
      runtime: "codex",
      account,
      secret: "secret-value",
      sourceEnv: {
        PATH: "C:/tools",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        CODEX_HOME: "D:/tmp/codex",
        OPENAI_ORG_ID: "org_123",
        UNRELATED_TEST_VAR: "ignored",
      },
    });

    expect(env).toMatchObject({
      PATH: "C:/tools",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      CODEX_HOME: "D:/tmp/codex",
      OPENAI_ORG_ID: "org_123",
      OPENAI_API_KEY: "secret-value",
      AUTO_PM_KEY_CODEX_VIP: "secret-value",
    });
    expect(env).not.toHaveProperty("UNRELATED_TEST_VAR");
  });

  it("omits auth env keys for local runtime auth", () => {
    const account: Account = {
      id: "codex_local",
      vendor: "openai-compatible",
      secretRef: "env:OPENAI_API_KEY",
    };

    const env = buildRuntimeEnv({
      runtime: "codex",
      account,
      authMode: "local",
      sourceEnv: {
        PATH: "C:/tools",
        OPENAI_API_KEY: "should-not-pass",
        OPENAI_BASE_URL: "https://should-not-pass.invalid",
        CODEX_HOME: "D:/tmp/codex",
      },
    });

    expect(env).toMatchObject({
      PATH: "C:/tools",
      CODEX_HOME: "D:/tmp/codex",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_BASE_URL");
  });

  it("passes MCP sidecar host essentials, session overrides, and referenced env secrets only", () => {
    const env = buildMcpSidecarEnv(buildConfig(), {
      PATH: "C:/tools",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      OPENAI_API_KEY: "codex-secret",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      UNRELATED_TEST_VAR: "ignored",
    });

    expect(env).toMatchObject({
      PATH: "C:/tools",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      OPENAI_API_KEY: "codex-secret",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(env).not.toHaveProperty("UNRELATED_TEST_VAR");
  });

  it("passes project launcher-derived env to MCP sidecars", () => {
    const env = buildMcpSidecarEnv(buildConfig(), {
      PATH: "C:/tools",
      AUTO_PM_LAUNCHER_ENV_PATH: "D:/Code/Auto-PM-Lite/launcher.env",
      ANTHROPIC_AUTH_TOKEN: "claude-from-launcher",
      OPENAI_API_KEY: "codex-from-launcher",
      CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
      UNRELATED_TEST_VAR: "ignored",
    });

    expect(env).toMatchObject({
      PATH: "C:/tools",
      AUTO_PM_LAUNCHER_ENV_PATH: "D:/Code/Auto-PM-Lite/launcher.env",
      ANTHROPIC_AUTH_TOKEN: "claude-from-launcher",
      OPENAI_API_KEY: "codex-from-launcher",
      CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
    });
    expect(env).not.toHaveProperty("UNRELATED_TEST_VAR");
  });
});

function buildConfig(): AppConfig {
  return {
    accounts: {
      claude: {
        id: "claude",
        vendor: "anthropic-compatible",
        secretRef: "env:ANTHROPIC_AUTH_TOKEN",
      },
      codex: {
        id: "codex",
        vendor: "openai-compatible",
        secretRef: "env:OPENAI_API_KEY",
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
