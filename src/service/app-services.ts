import { categorizeApproval } from "../core/types.js";
import type { AppConfig, RuntimeKind } from "../core/types.js";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfigPath, loadConfig } from "../core/config.js";
import { applyLauncherEnvToConfig, loadProjectLauncherEnv, type LauncherEnvSnapshot } from "../core/launcher-env.js";
import { AppDatabase } from "../storage/db.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { EnvSecretBackend, isLocalSecretRef, sourceEnvAuthMode, type SecretBackend } from "../orchestrator/secrets.js";
import { ClaudeRuntimeAdapter } from "../runtime/claude.js";
import { CodexRuntimeAdapter } from "../runtime/codex.js";
import { createCodexMcpServerConfig } from "../mcp/codex-binding.js";
import { probeInProcessMcp, probeStdioMcp } from "../mcp/diagnostics.js";
import {
  apiVersion,
  eventEnvelopeVersion,
  type ApprovalView,
  type ConfigMetadata,
  type EventEnvelope,
  AppError,
  type RuntimeHealth,
  type RuntimeHealthCheck,
  type TaskDetail,
  type TaskResultView,
  type TaskSummary,
} from "../api/types.js";
import {
  applyWorkspaceMergeSchema,
  createTaskRequestSchema,
  eventSubscriptionRequestSchema,
  pauseTaskRequestSchema,
  requestWorkspaceMergeSchema,
  resolveApprovalRequestSchema,
  resumeTaskRequestSchema,
  runTaskRequestSchema,
} from "../api/schemas.js";

export class TaskService {
  constructor(private readonly orchestrator: Orchestrator, private readonly runtimeService?: RuntimeService | undefined, private readonly skipRuntimeHealthGuard = false) {}

  async createTask(input: unknown): Promise<TaskDetail> {
    const parsed = createTaskRequestSchema.parse(input);
    const task = await this.orchestrator.createTask({
      profileId: parsed.profileId,
      cwd: parsed.cwd,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
    });
    return this.getTask(task.id);
  }

  async createChildTaskForSmoke(input: { parentTaskId: string; targetProfileId: string; name?: string | undefined }): Promise<TaskDetail> {
    const parent = this.getTask(input.parentTaskId);
    if (parent.workspace?.repoRoot) {
      await resetGitWorkspace(parent.workspace.path);
    }
    const result = await this.orchestrator.delegateTask({
      parentTaskId: input.parentTaskId,
      targetProfileId: input.targetProfileId,
      taskType: "edit",
      prompt: "desktop smoke child",
      reason: "desktop smoke",
      requestedPermissionMode: "edit",
      workspaceMode: "new-worktree",
      timeoutMs: 1,
    });
    if (!result.childTaskId) {
      throw new AppError("runtime_unavailable", result.message);
    }
    const detail = this.getTask(result.childTaskId);
    if (input.name) {
      return { ...detail, name: input.name };
    }
    return detail;
  }

  listTasks(): TaskSummary[] {
    return this.orchestrator.listTasks();
  }

  getTask(taskId: string): TaskDetail {
    const task = this.orchestrator.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const workspace = this.orchestrator.getWorkspace(task.workspaceId);
    return {
      ...task,
      turns: this.orchestrator.listTurns(task.id),
      artifacts: this.orchestrator.listArtifacts(task.id),
      ...(this.orchestrator.getLatestCompletedMessage(task.id) ? { latestMessage: this.orchestrator.getLatestCompletedMessage(task.id) } : {}),
      ...(this.orchestrator.getLatestTerminalError(task.id) ? { terminalError: this.orchestrator.getLatestTerminalError(task.id) } : {}),
      ...(workspace ? { workspace } : {}),
    };
  }

  listTurns(taskId: string) {
    return this.orchestrator.listTurns(taskId);
  }

  listArtifacts(taskId: string) {
    return this.orchestrator.listArtifacts(taskId);
  }

  async runTask(input: unknown): Promise<{ ok: true; taskId: string }> {
    const parsed = runTaskRequestSchema.parse(input);
    if (!this.skipRuntimeHealthGuard) {
      this.runtimeService?.assertCanRunTask(parsed.taskId);
    }
    await this.orchestrator.runTask(parsed);
    return { ok: true, taskId: parsed.taskId };
  }

  async resumeTask(input: unknown): Promise<{ ok: true; taskId: string; resumed: true }> {
    const parsed = resumeTaskRequestSchema.parse(input);
    if (!this.skipRuntimeHealthGuard) {
      this.runtimeService?.assertCanRunTask(parsed.taskId);
    }
    await this.orchestrator.resumeTask(parsed);
    return { ok: true, taskId: parsed.taskId, resumed: true };
  }

  async pauseTask(input: unknown): Promise<{ ok: true; taskId: string; paused: true }> {
    const parsed = pauseTaskRequestSchema.parse(typeof input === "string" ? { taskId: input } : input);
    await this.orchestrator.pauseTask(parsed.taskId);
    return { ok: true, taskId: parsed.taskId, paused: true };
  }

  async cancelTask(taskId: string): Promise<{ ok: true; taskId: string; cancelled: true }> {
    await this.orchestrator.cancelTask(taskId);
    return { ok: true, taskId, cancelled: true };
  }

  getTaskResult(input: { requesterTaskId: string; taskId: string }): TaskResultView;
  getTaskResult(requesterTaskId: string, taskId: string): TaskResultView;
  getTaskResult(input: { requesterTaskId: string; taskId: string } | string, taskId?: string): TaskResultView {
    const requesterTaskId = typeof input === "string" ? input : input.requesterTaskId;
    const targetTaskId = typeof input === "string" ? taskId : input.taskId;
    if (!targetTaskId) {
      throw new AppError("validation_failed", "taskId is required");
    }
    return this.orchestrator.getTaskResult(requesterTaskId, targetTaskId);
  }
}

async function resetGitWorkspace(cwd: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["-C", cwd, "reset", "--hard", "HEAD"]);
  await exec("git", ["-C", cwd, "clean", "-fd"]);
}

export class ApprovalService {
  constructor(private readonly orchestrator: Orchestrator) {}

  listApprovals(taskId?: string): ApprovalView[] {
    return this.orchestrator.listApprovals(taskId).map((approval) => ({
      ...approval,
      category: categorizeApproval(approval.kind),
    }));
  }

  async resolveApproval(input: unknown): Promise<{ ok: true; approvalId: string; decision: "approved" | "denied" }> {
    const parsed = resolveApprovalRequestSchema.parse(input);
    await this.orchestrator.resolveApproval(parsed);
    return {
      ok: true,
      approvalId: parsed.approvalId,
      decision: parsed.approved ? "approved" : "denied",
    };
  }
}

export class WorkspaceService {
  constructor(private readonly orchestrator: Orchestrator) {}

  listChanges(taskId: string) {
    return this.orchestrator.listWorkspaceChanges(taskId);
  }

  getDiff(taskId: string) {
    return this.orchestrator.getWorkspaceDiff(taskId);
  }

  async requestMerge(input: unknown) {
    return this.orchestrator.requestWorkspaceMerge(requestWorkspaceMergeSchema.parse(input));
  }

  async applyMerge(input: unknown) {
    return this.orchestrator.applyApprovedWorkspaceMerge(applyWorkspaceMergeSchema.parse(input));
  }

  async discard(taskId: string) {
    return this.orchestrator.discardWorkspace(taskId);
  }
}

export class EventService {
  constructor(private readonly orchestrator: Orchestrator) {}

  async replayAndSubscribe(input: {
    taskId?: string | undefined;
    sinceId?: number | undefined;
    listener: (event: EventEnvelope) => void;
  }): Promise<{ unsubscribe: () => void; lastReplayedId: number }> {
    const parsed = eventSubscriptionRequestSchema.parse({
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.sinceId === undefined ? {} : { sinceId: input.sinceId }),
    });
    return this.orchestrator.replayAndSubscribe({
      taskId: parsed.taskId,
      sinceId: parsed.sinceId,
      listener: (event, metadata) => {
        input.listener({
          eventEnvelopeVersion,
          ...(metadata.id === undefined ? {} : { id: metadata.id }),
          durable: metadata.durable,
          ...(metadata.durable ? {} : { ephemeral: true }),
          event,
        });
      },
    });
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    return this.orchestrator.subscribeToEvents((event) => {
      listener({
        eventEnvelopeVersion,
        durable: false,
        ephemeral: true,
        event,
      });
    });
  }
}

export class ConfigService {
  constructor(private readonly config: AppConfig, private readonly launcherEnv?: LauncherEnvSnapshot | undefined) {}

  getMetadata(): ConfigMetadata {
    return {
      apiVersion,
      accounts: Object.keys(this.config.accounts),
      policies: Object.keys(this.config.policies),
      profileIds: Object.keys(this.config.profiles),
      profiles: Object.values(this.config.profiles).map((profile) => {
        if (profile.runtime === "claude") {
          return {
            id: profile.id,
            runtime: profile.runtime,
            model: profile.model,
            ...(profile.allowedModels ? { allowedModels: profile.allowedModels } : {}),
            policyId: profile.policyId,
            claudePermissionMode: profile.claudePermissionMode,
          };
        }
        return {
          id: profile.id,
          runtime: profile.runtime,
          model: profile.model,
          ...(profile.allowedModels ? { allowedModels: profile.allowedModels } : {}),
          policyId: profile.policyId,
          codexSandboxMode: profile.codexSandboxMode,
          codexApprovalPolicy: profile.codexApprovalPolicy,
          codexNetworkAccessEnabled: profile.codexNetworkAccessEnabled,
        };
      }),
      storage: {
        dbPath: this.config.storage.dbPath,
        busyTimeoutMs: this.config.storage.busyTimeoutMs,
      },
      workspace: this.config.workspace,
      ...(this.launcherEnv ? { launcherEnvFiles: this.launcherEnv.files } : {}),
    };
  }
}

export class RuntimeService {
  constructor(
    private readonly config: AppConfig,
    private readonly orchestrator?: Orchestrator | undefined,
    private readonly sourceEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  getHealth(): RuntimeHealth[] {
    return (["claude", "codex"] as const).map((runtime) => {
      const profiles = Object.values(this.config.profiles).filter((profile) => profile.runtime === runtime);
      const missingSecretRefs = profiles
        .map((profile) => this.config.accounts[profile.accountId])
        .filter((account): account is NonNullable<typeof account> => Boolean(account))
        .filter((account) => !isLocalSecretRef(account.secretRef, runtime) && sourceEnvAuthMode(this.sourceEnv, runtime) !== "local")
        .filter((account) => account.secretRef.startsWith("env:") && readEnv(this.sourceEnv, account.secretRef.slice(4)) === undefined)
        .map((account) => account.secretRef);
      const missingAccounts = profiles
        .filter((profile) => !this.config.accounts[profile.accountId])
        .map((profile) => profile.accountId);
      const staticChecks: RuntimeHealthCheck[] = [
        checkPath("config", "Config file", this.config.storage.dbPath ? path.dirname(this.config.storage.dbPath) : undefined, "directory"),
        checkPath("database", "SQLite database", this.config.storage.dbPath, "file-parent"),
        checkPath("workspace-root", "Workspace root", this.config.workspace.rootDir, "directory"),
        checkGit(),
        checkSdk(runtime),
        ...unique(missingAccounts).map((accountId) => ({
          id: `account:${accountId}`,
          label: `Account ${accountId}`,
          status: "error" as const,
          message: "Account referenced by a profile is missing.",
          action: "Fix the profile account id in config.toml.",
        })),
        ...unique(missingSecretRefs).map((secretRef) => ({
          id: `secret:${secretRef}`,
          label: secretRef,
          status: "error" as const,
          message: "Environment secretRef is not set for this process.",
          action: `Set ${secretRef.replace(/^env:/, "")} before running live tasks.`,
        })),
      ];
      if (profiles.length === 0) {
        staticChecks.push({
          id: "profiles",
          label: "Profiles",
          status: "warning",
          message: "No profiles configured for this runtime.",
          action: "Add a profile in config.toml.",
        });
      }
      const capabilityChecks: RuntimeHealthCheck[] = [
        checkGitWorktree(this.config.workspace.rootDir),
        {
          id: `${runtime}:start`,
          label: `${runtime} start`,
          status: staticChecks.some((check) => check.status === "error") ? "unknown" : "ok",
          message: staticChecks.some((check) => check.status === "error")
            ? "Start probe skipped until static checks pass."
            : "Static configuration is sufficient for a dry start.",
          action: "Run explicit live smoke only when credentials are configured.",
        },
        {
          id: `${runtime}:mcp`,
          label: runtime === "codex" ? "Auto-PM MCP stdio" : "Auto-PM MCP in-process",
          status: "ok",
          message: runtime === "codex" ? "MCP stdio bridge entry is configured." : "In-process MCP binding is available.",
        },
      ];
      const messages = [...staticChecks, ...capabilityChecks]
        .filter((check) => check.status === "error")
        .map((check) => `${check.label}: ${check.message ?? check.status}`);

      return {
        runtime,
        profiles: profiles.map((profile) => profile.id),
        available: profiles.length > 0 && messages.length === 0 && staticChecks.every((check) => check.status !== "error"),
        ...(messages.length > 0 ? { message: messages.join("; ") } : {}),
        staticChecks,
        capabilityChecks,
      };
    });
  }

  async probeLive(runtimeName?: string | undefined): Promise<RuntimeHealth[]> {
    const requested = parseRuntimeName(runtimeName);
    const entries: RuntimeHealth[] = [];
    for (const entry of this.getHealth().filter((candidate) => !requested || candidate.runtime === requested)) {
      const mcpCheck = await this.probeMcp(entry.runtime as RuntimeKind);
      entries.push({
        ...entry,
        capabilityChecks: entry.capabilityChecks.map((check) => {
          if (check.id === `${entry.runtime}:mcp`) {
            return mcpCheck;
          }
          if (check.id === `${entry.runtime}:start`) {
            return {
              ...check,
              status: entry.available ? "ok" : check.status,
              message: entry.available
                ? "Non-billable runtime capability checks passed. Live model calls are not executed here."
                : check.message,
              action: entry.available
                ? "Run test:live from a configured shell when you intend to exercise provider credentials."
                : check.action,
            };
          }
          return check;
        }),
      });
    }
    return entries;
  }

  assertCanRunTask(taskId: string): void {
    const task = this.orchestrator?.getTask(taskId);
    if (!task) {
      throw new AppError("task_not_found", `Unknown task: ${taskId}`);
    }
    const profile = this.config.profiles[task.profileId];
    if (!profile) {
      throw new AppError("runtime_unavailable", `Task profile is missing: ${task.profileId}`);
    }
    const account = this.config.accounts[profile.accountId];
    if (!account) {
      throw new AppError("runtime_unavailable", `Task account is missing: ${profile.accountId}`);
    }
    const policy = this.config.policies[profile.policyId];
    if (!policy) {
      throw new AppError("policy_denied", `Task policy is missing: ${profile.policyId}`);
    }
    const health = this.getHealth().find((entry) => entry.runtime === profile.runtime);
    if (!health?.available) {
      throw new AppError("runtime_unavailable", health?.message ?? `Runtime unavailable: ${profile.runtime}`, health);
    }
    const workspace = this.orchestrator?.getWorkspace(task.workspaceId);
    if (!workspace || !fsSync.existsSync(workspace.path)) {
      throw new AppError("workspace_unavailable", `Workspace path is unavailable for task ${task.id}`);
    }
  }

  private async probeMcp(runtime: RuntimeKind): Promise<RuntimeHealthCheck> {
    if (runtime === "claude") {
      const result = this.orchestrator
        ? probeInProcessMcp(this.orchestrator.createDiagnosticMcpHandlers())
        : { ok: false, message: "Orchestrator is unavailable for MCP diagnostics." };
      return {
        id: "claude:mcp",
        label: "Auto-PM MCP in-process",
        status: result.ok ? "ok" : "error",
        message: result.message,
        ...(result.ok ? {} : { action: "Restart the desktop app and check runtime.log for MCP initialization errors." }),
      };
    }

    if (!this.orchestrator) {
      return {
        id: "codex:mcp",
        label: "Auto-PM MCP stdio",
        status: "error",
        message: "Orchestrator is unavailable for MCP diagnostics.",
        action: "Restart the desktop app and try again.",
      };
    }

    try {
      const server = createCodexMcpServerConfig({
        config: this.config,
        configPath: process.env.AUTO_PM_CONFIG_PATH ?? defaultConfigPath(),
        taskId: "__diagnostic__",
        cwd: this.config.workspace.rootDir,
        sourceEnv: this.sourceEnv,
      });
      if (!server.command) {
        throw new Error("Codex MCP command is not configured.");
      }
      const result = await probeStdioMcp({
        command: server.command,
        args: server.args ?? [],
        cwd: server.cwd,
        env: { ...process.env, ...server.env },
      });
      return {
        id: "codex:mcp",
        label: "Auto-PM MCP stdio",
        status: result.ok ? "ok" : "error",
        message: result.message,
        ...(result.ok ? {} : { action: "Verify the packaged CLI/MCP sidecar path and check runtime.log." }),
      };
    } catch (error) {
      return {
        id: "codex:mcp",
        label: "Auto-PM MCP stdio",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        action: "Verify the packaged CLI/MCP sidecar path and check runtime.log.",
      };
    }
  }
}

export interface AppServices {
  config: ConfigService;
  tasks: TaskService;
  approvals: ApprovalService;
  workspaces: WorkspaceService;
  events: EventService;
  runtime: RuntimeService;
  orchestrator: Orchestrator;
  close(): Promise<void>;
}

export interface AppServicesOptions {
  runtimeLog?: ((message: string) => void | Promise<void>) | undefined;
  skipRuntimeHealthGuard?: boolean | undefined;
}

export function createAppServices(config: AppConfig, orchestrator: Orchestrator, options: AppServicesOptions = {}): AppServices {
  return createAppServicesWithRuntimeEnv(config, orchestrator, process.env, undefined, options);
}

function createAppServicesWithRuntimeEnv(
  config: AppConfig,
  orchestrator: Orchestrator,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  launcherEnv?: LauncherEnvSnapshot | undefined,
  options: AppServicesOptions = {},
): AppServices {
  const runtime = new RuntimeService(config, orchestrator, sourceEnv);
  return {
    config: new ConfigService(config, launcherEnv),
    tasks: new TaskService(orchestrator, runtime, options.skipRuntimeHealthGuard),
    approvals: new ApprovalService(orchestrator),
    workspaces: new WorkspaceService(orchestrator),
    events: new EventService(orchestrator),
    runtime,
    orchestrator,
    close: () => orchestrator.close(),
  };
}

export async function openAppServices(configPath: string, options: AppServicesOptions = {}): Promise<AppServices> {
  await ensureDefaultConfig(configPath);
  const loadedConfig = await loadConfig(configPath);
  const launcherEnv = await loadProjectLauncherEnv({ configPath });
  const config = applyLauncherEnvToConfig(loadedConfig, launcherEnv);
  const sourceEnv = launcherEnv?.sourceEnv ?? process.env;
  const secretBackend: SecretBackend = new EnvSecretBackend(sourceEnv);
  const db = new AppDatabase({
    dbPath: config.storage.dbPath,
    busyTimeoutMs: config.storage.busyTimeoutMs,
  });
  let orchestrator: Orchestrator;
  const { Orchestrator: OrchestratorCtor } = await import("../orchestrator/orchestrator.js");
  const claude = new ClaudeRuntimeAdapter({
    config,
    sourceEnv,
    secretBackend,
    runtimeLog: options.runtimeLog,
    createMcpHandlers: (taskId) => orchestrator.createMcpHandlers(taskId),
    requestApproval: (input) => orchestrator.requestCapability(input),
  });
  const codex = new CodexRuntimeAdapter({
    config,
    configPath,
    sourceEnv,
    secretBackend,
    runtimeLog: options.runtimeLog,
  });
  orchestrator = new OrchestratorCtor(config, db, {
    claude,
    codex,
  });
  orchestrator.syncConfig();
  orchestrator.recoverStaleRunningTasks();
  return createAppServicesWithRuntimeEnv(config, orchestrator, sourceEnv, launcherEnv, options);
}

export async function ensureDefaultConfig(configPath = defaultConfigPath()): Promise<void> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    if (raw.includes(defaultConfigMarker)) {
      await writeDefaultConfig(configPath);
    }
    return;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeDefaultConfig(configPath);
}

async function writeDefaultConfig(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const normalizedHomeConfig = configPath.replace(/\\/g, "/");
  const rootDir = path.join(path.dirname(configPath), "workspaces").replace(/\\/g, "/");
  await fs.writeFile(configPath, `${defaultConfigMarker}

[storage]
db_path = "${path.join(path.dirname(configPath), "auto-pm-lite.db").replace(/\\/g, "/")}"
busy_timeout_ms = 5000
max_queue_size = 5000
flush_batch_size = 100

[workspace]
root_dir = "${rootDir}"
top_level_use_worktree = true

[transcript]
store_raw_encrypted = false

[policy.readonly]
permission_mode = "read-only"
sandbox_mode = "read-only"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 1
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[policy.edit]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = ["workspace_merge", "shell", "network", "sandbox_escape"]
max_depth = 2
allow_cross_harness_delegation = true
allow_child_edit = true
allow_child_network = false

[policy.network_edit]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = true
approval_policy = "orchestrator"
require_approval_for = ["workspace_merge", "shell", "sandbox_escape"]
max_depth = 2
allow_cross_harness_delegation = true
allow_child_edit = true
allow_child_network = true

[policy.full_access]
permission_mode = "full"
sandbox_mode = "danger-full-access"
network_allowed = true
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 2
allow_cross_harness_delegation = true
allow_child_edit = true
allow_child_network = true

[account.anthropic_env]
vendor = "anthropic"
secret_ref = "env:ANTHROPIC_API_KEY"

[account.openai_env]
vendor = "openai-compatible"
secret_ref = "env:OPENAI_API_KEY"

[profile.claude_readonly]
runtime = "claude"
account = "anthropic_env"
policy = "readonly"
model = "claude-opus-4-7"
allowed_models = ["claude-opus-4-7", "claude-opus-4-6"]
claude_permission_mode = "dontAsk"

[profile.claude_default]
runtime = "claude"
account = "anthropic_env"
policy = "edit"
model = "claude-opus-4-7"
allowed_models = ["claude-opus-4-7", "claude-opus-4-6"]
claude_permission_mode = "default"

[profile.claude_accept_edits]
runtime = "claude"
account = "anthropic_env"
policy = "edit"
model = "claude-opus-4-7"
allowed_models = ["claude-opus-4-7", "claude-opus-4-6"]
claude_permission_mode = "acceptEdits"

[profile.claude_auto]
runtime = "claude"
account = "anthropic_env"
policy = "edit"
model = "claude-opus-4-7"
allowed_models = ["claude-opus-4-7", "claude-opus-4-6"]
claude_permission_mode = "auto"

[profile.claude_plan]
runtime = "claude"
account = "anthropic_env"
policy = "readonly"
model = "claude-opus-4-7"
allowed_models = ["claude-opus-4-7", "claude-opus-4-6"]
claude_permission_mode = "plan"

[profile.claude_bypass_permissions]
runtime = "claude"
account = "anthropic_env"
policy = "full_access"
model = "claude-opus-4-7"
allowed_models = ["claude-opus-4-7", "claude-opus-4-6"]
claude_permission_mode = "bypassPermissions"

[profile.codex_plan]
runtime = "codex"
account = "openai_env"
policy = "readonly"
model = "gpt-5-codex"
codex_sandbox_mode = "read-only"
codex_approval_policy = "on-request"
codex_network_access_enabled = false

[profile.codex_edit]
runtime = "codex"
account = "openai_env"
policy = "edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = false

[profile.codex_untrusted]
runtime = "codex"
account = "openai_env"
policy = "edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "untrusted"
codex_network_access_enabled = false

[profile.codex_never]
runtime = "codex"
account = "openai_env"
policy = "edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "never"
codex_network_access_enabled = false

[profile.codex_on_failure]
runtime = "codex"
account = "openai_env"
policy = "edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-failure"
codex_network_access_enabled = false

[profile.codex_network]
runtime = "codex"
account = "openai_env"
policy = "network_edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = true

[profile.codex_danger_full_access]
runtime = "codex"
account = "openai_env"
policy = "full_access"
model = "gpt-5-codex"
codex_sandbox_mode = "danger-full-access"
codex_approval_policy = "never"
codex_network_access_enabled = true

# Set ANTHROPIC_API_KEY / OPENAI_API_KEY in the environment, or copy launcher.env.example
# to launcher.env next to this config and choose CLAUDE_PLATFORM / CODEX_PLATFORM there.
# Config path: ${normalizedHomeConfig}
`, "utf8");
}

const defaultConfigMarker = "# Auto-PM Lite default config";

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function readEnv(sourceEnv: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = sourceEnv[key];
  if (exact !== undefined) {
    return exact;
  }

  if (process.platform !== "win32") {
    return undefined;
  }

  const normalized = key.toUpperCase();
  const match = Object.keys(sourceEnv).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? sourceEnv[match] : undefined;
}

function checkPath(id: string, label: string, target: string | undefined, kind: "directory" | "file-parent"): RuntimeHealthCheck {
  if (!target) {
    return {
      id,
      label,
      status: "error",
      message: "Path is not configured.",
      action: "Check config.toml.",
    };
  }
  const probePath = kind === "file-parent" ? path.dirname(target) : target;
  if (!fsSync.existsSync(probePath)) {
    return {
      id,
      label,
      status: "error",
      message: `${probePath} does not exist.`,
      action: "Create the directory or update config.toml.",
    };
  }
  try {
    fsSync.accessSync(probePath, fsSync.constants.R_OK | fsSync.constants.W_OK);
    return { id, label, status: "ok", message: probePath };
  } catch {
    return {
      id,
      label,
      status: "error",
      message: `${probePath} is not readable and writable.`,
      action: "Fix filesystem permissions or choose another path.",
    };
  }
}

function checkGit(): RuntimeHealthCheck {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return { id: "git", label: "Git", status: "ok", message: "git is available." };
  } catch {
    return {
      id: "git",
      label: "Git",
      status: "error",
      message: "git executable is unavailable.",
      action: "Install git and ensure it is on PATH.",
    };
  }
}

function checkGitWorktree(workspaceRoot: string): RuntimeHealthCheck {
  try {
    execFileSync("git", ["worktree", "list"], { cwd: workspaceRoot, stdio: "ignore" });
    return { id: "git:worktree", label: "Git worktree", status: "ok", message: "git worktree is available for the workspace root." };
  } catch {
    return {
      id: "git:worktree",
      label: "Git worktree",
      status: "warning",
      message: "git worktree could not be verified from the workspace root.",
      action: "Use a git-backed workspace before running editable delegated tasks.",
    };
  }
}

function checkSdk(runtime: "claude" | "codex"): RuntimeHealthCheck {
  const packageName = runtime === "claude" ? "@anthropic-ai/claude-agent-sdk" : "@openai/codex-sdk";
  try {
    import.meta.resolve(packageName);
    return { id: `${runtime}:sdk`, label: `${runtime} SDK`, status: "ok", message: `${packageName} is resolvable.` };
  } catch {
    return {
      id: `${runtime}:sdk`,
      label: `${runtime} SDK`,
      status: "error",
      message: `${packageName} is not resolvable.`,
      action: "Run pnpm install.",
    };
  }
}

function parseRuntimeName(runtimeName?: string | undefined): RuntimeKind | null {
  if (runtimeName === undefined || runtimeName === "") {
    return null;
  }
  if (runtimeName === "claude" || runtimeName === "codex") {
    return runtimeName;
  }
  throw new AppError("validation_failed", `Unknown runtime: ${runtimeName}`);
}
