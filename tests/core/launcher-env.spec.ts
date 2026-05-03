import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyLauncherEnvToConfig, buildLauncherSessionEnv, loadProjectLauncherEnv, parseLauncherEnv } from "../../src/core/launcher-env.js";
import type { AppConfig } from "../../src/core/types.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("project launcher env", () => {
  it("maps launcher registry selections to session env without exposing unrelated keys", () => {
    const values = parseLauncherEnv(`
CLAUDE_PLATFORM=NOWCODING
CLAUDE_KEY=CX_CC
CLAUDE_CODE_AUTO_COMPACT_WINDOW=258000
CLAUDE__NOWCODING__BASE_URL=https://claude.example
CLAUDE__NOWCODING__KEY__CX_CC=sk-claude
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PRO
CODEX_ENV_KEY=OPENAI_API_KEY
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=sk-codex
IGNORED_VALUE=not-session
`);

    const env = buildLauncherSessionEnv(values);

    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "sk-claude",
      ANTHROPIC_API_KEY: "sk-claude",
      ANTHROPIC_BASE_URL: "https://claude.example",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "258000",
      OPENAI_API_KEY: "sk-codex",
    });
    expect(env).not.toHaveProperty("IGNORED_VALUE");
  });

  it("applies launcher provider defaults to compatible accounts and codex profiles", () => {
    const values = parseLauncherEnv(`
CLAUDE_PLATFORM=NOWCODING
CLAUDE__NOWCODING__BASE_URL=https://claude.example
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_WIRE_API=responses
CODEX_REASONING_EFFORT=xhigh
CODEX__AUTO_CODE_VIP__PROVIDER=OpenAI
CODEX__AUTO_CODE_VIP__BASE_URL=https://codex.example/v1
CODEX__AUTO_CODE_VIP__MODEL=gpt-5.5
CODEX__AUTO_CODE_VIP__MODEL_CONTEXT_WINDOW=258000
CODEX__AUTO_CODE_VIP__MODEL_AUTO_COMPACT_TOKEN_LIMIT=250000
CODEX__AUTO_CODE_VIP__REQUIRES_OPENAI_AUTH=true
`);

    const config = applyLauncherEnvToConfig(buildConfig(), {
      files: ["D:/Code/Auto-PM-Lite/launcher.env"],
      values,
      sessionEnv: buildLauncherSessionEnv(values),
      sourceEnv: values,
    });

    expect(config.accounts.claude_compatible?.baseUrl).toBe("https://claude.example");
    expect(config.accounts.codex_compatible?.baseUrl).toBe("https://codex.example/v1");
    expect(config.accounts.codex_compatible?.extraConfig).toMatchObject({
      provider: "OpenAI",
      wire_api: "responses",
      requires_openai_auth: true,
      model_context_window: 258000,
      model_auto_compact_token_limit: 250000,
      model_reasoning_effort: "xhigh",
    });
    expect(config.profiles.codex_edit?.model).toBe("gpt-5.5");
  });

  it("leaves local auth runtimes on local login state even when launcher provider values exist", () => {
    const values = parseLauncherEnv(`
CLAUDE_AUTH_MODE=local
CLAUDE_PLATFORM=NOWCODING
CLAUDE_KEY=CX_CC
CLAUDE__NOWCODING__BASE_URL=https://claude.example
CLAUDE__NOWCODING__KEY__CX_CC=sk-claude
CODEX_AUTH_MODE=local
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PRO
CODEX__AUTO_CODE_VIP__PROVIDER=OpenAI
CODEX__AUTO_CODE_VIP__BASE_URL=https://codex.example/v1
CODEX__AUTO_CODE_VIP__MODEL=gpt-5.5
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=sk-codex
`);

    const env = buildLauncherSessionEnv(values);
    const config = applyLauncherEnvToConfig(buildConfig(), {
      files: ["D:/Code/Auto-PM-Lite/launcher.env"],
      values,
      sessionEnv: env,
      sourceEnv: values,
    });

    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(config.accounts.claude_compatible?.baseUrl).toBeUndefined();
    expect(config.accounts.codex_compatible?.baseUrl).toBeUndefined();
    expect(config.accounts.codex_compatible?.extraConfig).toBeUndefined();
    expect(config.profiles.codex_edit?.model).toBe("placeholder");
  });

  it("loads config-directory launcher env before project cwd launcher env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-launcher-candidates-"));
    tempPaths.push(root);
    const configDir = path.join(root, "config-home");
    const projectDir = path.join(root, "project");
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "launcher.env"), `
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PLUS
CODEX__AUTO_CODE_VIP__KEY__CX_PLUS=config-key
CODEX__AUTO_CODE_VIP__MODEL=config-model
`, "utf8");
    await fs.writeFile(path.join(projectDir, "launcher.env"), `
CODEX_KEY=CX_PRO
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=project-key
CODEX__AUTO_CODE_VIP__MODEL=project-model
`, "utf8");

    const launcherEnv = await loadProjectLauncherEnv({
      cwd: projectDir,
      configPath: path.join(configDir, "config.toml"),
    });

    expect(launcherEnv?.files).toEqual([
      path.join(configDir, "launcher.env"),
      path.join(projectDir, "launcher.env"),
    ]);
    expect(launcherEnv?.values.CODEX_KEY).toBe("CX_PRO");
    expect(launcherEnv?.sessionEnv.OPENAI_API_KEY).toBe("project-key");
  });
});

function buildConfig(): AppConfig {
  return {
    accounts: {
      claude_compatible: {
        id: "claude_compatible",
        vendor: "anthropic-compatible",
        secretRef: "env:ANTHROPIC_AUTH_TOKEN",
      },
      codex_compatible: {
        id: "codex_compatible",
        vendor: "openai-compatible",
        secretRef: "env:OPENAI_API_KEY",
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
        maxDepth: 1,
        allowCrossHarnessDelegation: false,
        allowChildEdit: false,
        allowChildNetwork: false,
      },
    },
    profiles: {
      codex_edit: {
        id: "codex_edit",
        runtime: "codex",
        accountId: "codex_compatible",
        policyId: "edit",
        model: "placeholder",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        codexNetworkAccessEnabled: false,
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
