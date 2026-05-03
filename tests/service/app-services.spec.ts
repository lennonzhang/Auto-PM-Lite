import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/storage/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { createAppServices, ensureDefaultConfig, openAppServices } from "../../src/service/app-services.js";
import { apiVersion, toErrorEnvelope, type RuntimeHealth } from "../../src/api/types.js";
import { loadConfig } from "../../src/core/config.js";
import { applyLauncherEnvToConfig, loadProjectLauncherEnv } from "../../src/core/launcher-env.js";
import {
  approvalViewSchema,
  configMetadataSchema,
  createTaskRequestSchema,
  eventEnvelopeSchema,
  eventSubscriptionRequestSchema,
  requestWorkspaceMergeSchema,
  resolveApprovalRequestSchema,
  runtimeHealthSchema,
  taskDetailSchema,
  taskSummarySchema,
  workspaceChangeSchema,
  workspaceDiffSchema,
  workspaceMergeResultSchema,
} from "../../src/api/schemas.js";
import type { AgentEvent, AppConfig } from "../../src/core/types.js";
import type { RuntimeAdapter, RuntimeTaskHandle, RunTurnInput, StartRuntimeTaskInput, ResumeRuntimeTaskInput } from "../../src/runtime/adapter.js";

const tempPaths: string[] = [];

class FakeRuntime implements RuntimeAdapter {
  readonly started: StartRuntimeTaskInput[] = [];
  readonly turns: RunTurnInput[] = [];
  readonly resumed: ResumeRuntimeTaskInput[] = [];

  constructor(readonly runtime: RuntimeAdapter["runtime"] = "claude") {}

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.started.push(input);
    return { taskId: input.taskId, backendThreadId: `thread-${input.taskId}` };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    this.turns.push(input);
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };
    yield { type: "message.completed", taskId: input.taskId, turnId: "turn-1", text: input.prompt, ts };
    yield { type: "turn.completed", taskId: input.taskId, turnId: "turn-1", usage: { inputTokens: 1, outputTokens: 1 }, ts };
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.resumed.push(input);
    return { taskId: input.taskId, backendThreadId: input.backendThreadId };
  }

  async pauseTask(_taskId: string): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async closeTask(_taskId: string): Promise<void> {}
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("AppServices", () => {
  it("exposes versioned config metadata and task DTOs", async () => {
    const { services } = await buildServices();

    try {
      expect(services.config.getMetadata().apiVersion).toBe(apiVersion);
      expect(configMetadataSchema.parse(services.config.getMetadata()).apiVersion).toBe(apiVersion);

      const task = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
        name: "service-task",
      });

      expect(taskDetailSchema.parse(task).id).toBe(task.id);
      expect(task.model).toBe("claude-opus-4-7");
      expect(task.workspace).toBeDefined();
      expect(task.turns).toEqual([]);
      expect(services.tasks.listTasks()).toHaveLength(1);
      expect(taskSummarySchema.parse(services.tasks.listTasks()[0]!).id).toBe(task.id);
      expect(services.tasks.getTask(task.id).name).toBe("service-task");
      const runtimeHealth = services.runtime.getHealth();
      expect(runtimeHealth.map((entry) => runtimeHealthSchema.parse(entry).runtime)).toEqual(["claude", "codex"]);
      expect(runtimeHealth.find((entry) => entry.runtime === "claude")?.profiles).toEqual(["claude_main"]);
      expect(runtimeHealth.find((entry) => entry.runtime === "claude")?.staticChecks.length).toBeGreaterThan(0);
    } finally {
      await services.close();
    }
  });

  it("persists task model overrides and passes them to runtime turns", async () => {
    const { runtimes, services } = await buildServices({ skipRuntimeHealthGuard: true });

    try {
      const task = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
        model: "claude-sonnet-4-6",
      });

      expect(task.model).toBe("claude-sonnet-4-6");
      await services.tasks.runTask({ taskId: task.id, prompt: "selected model" });

      expect(runtimes.claude.started[0]?.model).toBe("claude-sonnet-4-6");
      expect(runtimes.claude.turns[0]?.model).toBe("claude-sonnet-4-6");
      const detail = services.tasks.getTask(task.id);
      expect(detail.latestMessage).toBe("selected model");
      expect(services.tasks.listTasks()[0]?.latestMessage).toBe("selected model");
    } finally {
      await services.close();
    }
  });

  it("rejects task model overrides outside profile allowed models", async () => {
    const { services } = await buildServices();

    try {
      await expect(services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
        model: "claude-haiku-4-5",
      })).rejects.toMatchObject({
        code: "validation_failed",
      });
    } finally {
      await services.close();
    }
  });

  it("guards task runs when runtime health is blocked", async () => {
    const { services } = await buildServices({
      secretRef: "env:AUTO_PM_LITE_MISSING_SECRET_FOR_TEST",
    });

    try {
      const task = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
      });

      await expect(services.tasks.runTask({ taskId: task.id, prompt: "go" })).rejects.toMatchObject({
        code: "runtime_unavailable",
      });
    } finally {
      await services.close();
    }
  });

  it("uses project launcher env as the local secret source for runtime health", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-launcher-env-"));
    tempPaths.push(root);
    const configPath = path.join(root, "config.toml");
    const dbPath = path.join(root, "db.sqlite");
    const workspaceRoot = path.join(root, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(configPath, `
[storage]
db_path = "${dbPath.replace(/\\/g, "/")}"
busy_timeout_ms = 1000

[workspace]
root_dir = "${workspaceRoot.replace(/\\/g, "/")}"
top_level_use_worktree = false

[policy.edit]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 1
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[account.codex_local]
vendor = "openai-compatible"
secret_ref = "env:OPENAI_API_KEY"

[profile.codex_edit]
runtime = "codex"
account = "codex_local"
policy = "edit"
model = "placeholder"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = false
`, "utf8");
    await fs.writeFile(path.join(root, "launcher.env"), `
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PRO
CODEX_ENV_KEY=OPENAI_API_KEY
CODEX__AUTO_CODE_VIP__PROVIDER=OpenAI
CODEX__AUTO_CODE_VIP__BASE_URL=https://codex.example/v1
CODEX__AUTO_CODE_VIP__MODEL=gpt-5.5
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=sk-codex
`, "utf8");

    const originalCwd = process.cwd();
    let services: Awaited<ReturnType<typeof openAppServices>> | undefined;
    try {
      process.chdir(root);
      services = await openAppServices(configPath);
      const metadata = services.config.getMetadata();
      const codexHealth = services.runtime.getHealth().find((entry: RuntimeHealth) => entry.runtime === "codex");
      expect(metadata.launcherEnvFiles).toEqual([path.join(root, "launcher.env")]);
      expect(codexHealth?.staticChecks).not.toContainEqual(expect.objectContaining({
        id: "secret:env:OPENAI_API_KEY",
        status: "error",
      }));
    } finally {
      await services?.close();
      process.chdir(originalCwd);
    }
  });

  it("uses cwd launcher env when config lives outside the project directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-launcher-cwd-"));
    tempPaths.push(root);
    const configDir = path.join(root, "config-home");
    const projectDir = path.join(root, "project");
    const dbPath = path.join(configDir, "db.sqlite");
    const workspaceRoot = path.join(configDir, "workspaces");
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    const configPath = path.join(configDir, "config.toml");
    await fs.writeFile(configPath, `
[storage]
db_path = "${dbPath.replace(/\\/g, "/")}"
busy_timeout_ms = 1000

[workspace]
root_dir = "${workspaceRoot.replace(/\\/g, "/")}"
top_level_use_worktree = false

[policy.edit]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 1
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[account.codex_local]
vendor = "openai-compatible"
secret_ref = "env:OPENAI_API_KEY"

[profile.codex_edit]
runtime = "codex"
account = "codex_local"
policy = "edit"
model = "placeholder"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = false
`, "utf8");
    await fs.writeFile(path.join(projectDir, "launcher.env"), `
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PRO
CODEX_ENV_KEY=OPENAI_API_KEY
CODEX__AUTO_CODE_VIP__MODEL=gpt-5.5
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=sk-codex
`, "utf8");

    const originalCwd = process.cwd();
    let services: Awaited<ReturnType<typeof openAppServices>> | undefined;
    try {
      process.chdir(projectDir);
      services = await openAppServices(configPath);
      const metadata = services.config.getMetadata();
      const codexHealth = services.runtime.getHealth().find((entry: RuntimeHealth) => entry.runtime === "codex");
      expect(metadata.launcherEnvFiles).toEqual([path.join(projectDir, "launcher.env")]);
      expect(metadata.profiles.find((profile) => profile.id === "codex_edit")?.model).toBe("gpt-5.5");
      expect(codexHealth?.staticChecks).not.toContainEqual(expect.objectContaining({
        id: "secret:env:OPENAI_API_KEY",
        status: "error",
      }));
    } finally {
      await services?.close();
      process.chdir(originalCwd);
    }
  });

  it("applies launcher codex provider settings to the generated default config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-default-launcher-"));
    tempPaths.push(root);
    const configPath = path.join(root, "config.toml");
    await fs.writeFile(path.join(root, "launcher.env"), `
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PRO
CODEX_ENV_KEY=OPENAI_API_KEY
CODEX__AUTO_CODE_VIP__PROVIDER=OpenAI
CODEX__AUTO_CODE_VIP__BASE_URL=https://codex.example/v1
CODEX__AUTO_CODE_VIP__MODEL=gpt-5.5
CODEX__AUTO_CODE_VIP__MODEL_CONTEXT_WINDOW=258000
CODEX__AUTO_CODE_VIP__MODEL_AUTO_COMPACT_TOKEN_LIMIT=250000
CODEX__AUTO_CODE_VIP__REQUIRES_OPENAI_AUTH=true
CODEX__AUTO_CODE_VIP__WIRE_API=responses
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=sk-codex
`, "utf8");

    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await ensureDefaultConfig(configPath);
      const launcherEnv = await loadProjectLauncherEnv({ configPath });
      const config = applyLauncherEnvToConfig(await loadConfig(configPath), launcherEnv);
      const account = config.accounts.openai_env;
      const profile = config.profiles.codex_edit;

      expect(account?.vendor).toBe("openai-compatible");
      expect(account?.baseUrl).toBe("https://codex.example/v1");
      expect(account?.extraConfig).toMatchObject({
        provider: "OpenAI",
        wire_api: "responses",
        requires_openai_auth: true,
        model_context_window: 258000,
        model_auto_compact_token_limit: 250000,
      });
      expect(profile?.model).toBe("gpt-5.5");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("allows launcher local auth mode without requiring env secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-local-auth-"));
    tempPaths.push(root);
    const configPath = path.join(root, "config.toml");
    const dbPath = path.join(root, "db.sqlite");
    const workspaceRoot = path.join(root, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(configPath, `
[storage]
db_path = "${dbPath.replace(/\\/g, "/")}"
busy_timeout_ms = 1000

[workspace]
root_dir = "${workspaceRoot.replace(/\\/g, "/")}"
top_level_use_worktree = false

[policy.edit]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 1
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[account.codex_local]
vendor = "openai-compatible"
secret_ref = "env:OPENAI_API_KEY"

[profile.codex_edit]
runtime = "codex"
account = "codex_local"
policy = "edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = false
`, "utf8");
    await fs.writeFile(path.join(root, "launcher.env"), `
CODEX_AUTH_MODE=local
CODEX_PLATFORM=AUTO_CODE_VIP
CODEX_KEY=CX_PRO
CODEX__AUTO_CODE_VIP__PROVIDER=OpenAI
CODEX__AUTO_CODE_VIP__BASE_URL=https://codex.example/v1
CODEX__AUTO_CODE_VIP__KEY__CX_PRO=sk-codex
`, "utf8");

    const services = await openAppServices(configPath);

    try {
      const codexHealth = services.runtime.getHealth().find((entry: RuntimeHealth) => entry.runtime === "codex");
      expect(codexHealth?.staticChecks).not.toContainEqual(expect.objectContaining({
        id: "secret:env:OPENAI_API_KEY",
        status: "error",
      }));
    } finally {
      await services.close();
    }
  });

  it("recovers stale running tasks to reconcile_required", async () => {
    const { db, services } = await buildServices();

    try {
      const task = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
      });
      db.updateTaskRuntimeState({
        taskId: task.id,
        status: "running",
        backendThreadId: "thread-stale",
        updatedAt: new Date().toISOString(),
      });

      const recovered = services.orchestrator.recoverStaleRunningTasks();
      expect(recovered.recoveredTaskIds).toEqual([task.id]);
      expect(services.tasks.getTask(task.id).status).toBe("reconcile_required");
    } finally {
      await services.close();
    }
  });

  it("wraps replayed events in event envelopes", async () => {
    const { services } = await buildServices();

    try {
      const task = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
      });

      const seen: string[] = [];
      const replay = await services.events.replayAndSubscribe({
        taskId: task.id,
        listener: (event) => {
          expect(event.eventEnvelopeVersion).toBe(1);
          expect(event.durable).toBe(true);
          expect(event.id).toEqual(expect.any(Number));
          expect(eventEnvelopeSchema.parse(event).id).toBe(event.id);
          seen.push(event.event.type);
        },
      });
      replay.unsubscribe();

      expect(seen).toContain("task.queued");
    } finally {
      await services.close();
    }
  });

  it("uses sinceId as an exclusive event cursor", async () => {
    const { db, services } = await buildServices();

    try {
      const first = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
      });
      const second = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: services.config.getMetadata().workspace.rootDir,
      });
      const firstEvent = db.listEvents({ taskId: first.id })[0]!;

      const seen: string[] = [];
      const replay = await services.events.replayAndSubscribe({
        sinceId: firstEvent.id,
        listener: (event) => {
          seen.push(event.event.taskId);
        },
      });
      replay.unsubscribe();

      expect(seen).not.toContain(first.id);
      expect(seen).toContain(second.id);
    } finally {
      await services.close();
    }
  });

  it("validates workspace use cases at the service contract layer", async () => {
    const { repoRoot, services } = await buildServices({ editableWorkspace: true });

    try {
      const parent = await services.tasks.createTask({
        profileId: "claude_main",
        cwd: repoRoot,
      });
      const delegated = await services.orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetProfileId: "codex_child",
        taskType: "edit",
        prompt: "edit",
        reason: "service contract",
      });
      const childTaskId = delegated.childTaskId!;
      const childTask = services.tasks.getTask(childTaskId);
      const workspacePath = childTask.workspace?.path ?? childTask.cwd;
      await fs.writeFile(path.join(workspacePath, "service-change.txt"), "service\n", "utf8");

      const changes = services.workspaces.listChanges(childTaskId);
      expect(changes.map((change) => workspaceChangeSchema.parse(change).path)).toEqual(["service-change.txt"]);

      const diff = services.workspaces.getDiff(childTaskId);
      expect(workspaceDiffSchema.parse(diff).patch).toContain("service");

      const mergeRequest = await services.workspaces.requestMerge({
        taskId: childTaskId,
        reason: "service contract",
      });
      await services.approvals.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      const merged = await services.workspaces.applyMerge({
        taskId: childTaskId,
        approvalId: mergeRequest.approvalId,
      });
      expect(workspaceMergeResultSchema.parse(merged).status).toBe("merged");
    } finally {
      await services.close();
    }
  });

  it("keeps API schemas and error envelopes stable", () => {
    expect(createTaskRequestSchema.parse({ profileId: "p", cwd: "c" })).toEqual({ profileId: "p", cwd: "c" });
    expect(resolveApprovalRequestSchema.parse({ approvalId: "a", approved: true })).toEqual({ approvalId: "a", approved: true });
    expect(requestWorkspaceMergeSchema.parse({ taskId: "t", reason: "ready" })).toEqual({ taskId: "t", reason: "ready" });
    expect(eventSubscriptionRequestSchema.parse({ sinceId: 10 })).toEqual({ sinceId: 10 });
    expect(approvalViewSchema.parse({
      id: "a",
      taskId: "t",
      kind: "workspace_merge",
      payload: {},
      status: "pending",
      requestedAt: new Date().toISOString(),
      category: "capability_request",
    }).id).toBe("a");

    expect(toErrorEnvelope(new Error("workspace_not_mergeable:invalid_status"))).toEqual({
      apiVersion,
      error: {
        code: "workspace_not_mergeable",
        message: "workspace_not_mergeable:invalid_status",
      },
    });
  });
});

async function buildServices(options?: { editableWorkspace?: boolean; secretRef?: string; skipRuntimeHealthGuard?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-service-"));
  tempPaths.push(root);
  const repoRoot = options?.editableWorkspace ? path.join(root, "repo") : root;
  const workspaceRoot = options?.editableWorkspace ? path.join(root, "workspaces") : root;
  if (options?.editableWorkspace) {
    initializeGitRepo(repoRoot);
  }
  const config: AppConfig = {
    accounts: {
      anthropic: { id: "anthropic", vendor: "anthropic", secretRef: options?.secretRef ?? "env:ANTHROPIC_API_KEY" },
    },
    policies: {
      readonly: {
        id: "readonly",
        permissionMode: "read-only",
        sandboxMode: "read-only",
        networkAllowed: false,
        approvalPolicy: "orchestrator",
        requireApprovalFor: [],
        maxDepth: options?.editableWorkspace ? 2 : 1,
        allowCrossHarnessDelegation: Boolean(options?.editableWorkspace),
        allowChildEdit: Boolean(options?.editableWorkspace),
        allowChildNetwork: false,
        unsafeDirectCwd: !options?.editableWorkspace,
      },
      ...(options?.editableWorkspace
        ? {
            child_edit: {
              id: "child_edit",
              permissionMode: "edit" as const,
              sandboxMode: "workspace-write" as const,
              networkAllowed: false,
              approvalPolicy: "orchestrator" as const,
              requireApprovalFor: [],
              maxDepth: 2,
              allowCrossHarnessDelegation: false,
              allowChildEdit: false,
              allowChildNetwork: false,
            },
          }
        : {}),
    },
    profiles: {
      claude_main: {
        id: "claude_main",
        runtime: "claude",
        accountId: "anthropic",
        policyId: "readonly",
        model: "claude-opus-4-7",
        allowedModels: ["claude-opus-4-7", "claude-sonnet-4-6"],
        claudePermissionMode: "dontAsk",
      },
      ...(options?.editableWorkspace
        ? {
            codex_child: {
              id: "codex_child",
              runtime: "codex" as const,
              accountId: "anthropic",
              policyId: "child_edit",
              model: "gpt-5-codex",
              codexSandboxMode: "workspace-write" as const,
              codexApprovalPolicy: "on-request" as const,
              codexNetworkAccessEnabled: false,
            },
          }
        : {}),
    },
    redaction: { additionalPatterns: [] },
    transcript: { storeRawEncrypted: false },
    storage: {
      dbPath: path.join(root, "db.sqlite"),
      busyTimeoutMs: 1000,
      maxQueueSize: 100,
      flushBatchSize: 10,
    },
    workspace: {
      rootDir: workspaceRoot,
      topLevelUseWorktree: Boolean(options?.editableWorkspace),
    },
    scheduler: {
      maxConcurrentTasksGlobal: 5,
      maxConcurrentTasksPerAccount: 2,
    },
    rateLimit: { enabled: false },
  };
  const db = new AppDatabase({ dbPath: config.storage.dbPath, busyTimeoutMs: config.storage.busyTimeoutMs });
  const runtimes = {
    claude: new FakeRuntime("claude"),
    ...(options?.editableWorkspace ? { codex: new FakeRuntime("codex") } : {}),
  };
  const orchestrator = new Orchestrator(config, db, {
    ...runtimes,
  });
  orchestrator.syncConfig();
  return { db, repoRoot, runtimes, services: createAppServices(config, orchestrator, { skipRuntimeHealthGuard: options?.skipRuntimeHealthGuard ?? false }) };
}

function initializeGitRepo(root: string): void {
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
}
