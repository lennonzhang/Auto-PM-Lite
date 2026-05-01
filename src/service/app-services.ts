import { categorizeApproval } from "../core/types.js";
import type { AppConfig } from "../core/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfigPath, loadConfig } from "../core/config.js";
import { AppDatabase } from "../storage/db.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { ClaudeRuntimeAdapter } from "../runtime/claude.js";
import { CodexRuntimeAdapter } from "../runtime/codex.js";
import {
  apiVersion,
  eventEnvelopeVersion,
  type ApprovalView,
  type ConfigMetadata,
  type EventEnvelope,
  type RuntimeHealth,
  type TaskDetail,
  type TaskSummary,
} from "../api/types.js";
import {
  applyWorkspaceMergeSchema,
  createTaskRequestSchema,
  eventSubscriptionRequestSchema,
  requestWorkspaceMergeSchema,
  resolveApprovalRequestSchema,
  resumeTaskRequestSchema,
  runTaskRequestSchema,
} from "../api/schemas.js";

export class TaskService {
  constructor(private readonly orchestrator: Orchestrator) {}

  async createTask(input: unknown): Promise<TaskDetail> {
    const parsed = createTaskRequestSchema.parse(input);
    const task = await this.orchestrator.createTask({
      profileId: parsed.profileId,
      cwd: parsed.cwd,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
    });
    return this.getTask(task.id);
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
    await this.orchestrator.runTask(parsed);
    return { ok: true, taskId: parsed.taskId };
  }

  async resumeTask(input: unknown): Promise<{ ok: true; taskId: string; resumed: true }> {
    const parsed = resumeTaskRequestSchema.parse(input);
    await this.orchestrator.resumeTask(parsed);
    return { ok: true, taskId: parsed.taskId, resumed: true };
  }

  async cancelTask(taskId: string): Promise<{ ok: true; taskId: string; cancelled: true }> {
    await this.orchestrator.cancelTask(taskId);
    return { ok: true, taskId, cancelled: true };
  }

  getTaskResult(requesterTaskId: string, taskId: string) {
    return this.orchestrator.getTaskResult(requesterTaskId, taskId);
  }
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
  constructor(private readonly config: AppConfig) {}

  getMetadata(): ConfigMetadata {
    return {
      apiVersion,
      accounts: Object.keys(this.config.accounts),
      policies: Object.keys(this.config.policies),
      profiles: Object.keys(this.config.profiles),
      storage: {
        dbPath: this.config.storage.dbPath,
        busyTimeoutMs: this.config.storage.busyTimeoutMs,
      },
      workspace: this.config.workspace,
    };
  }
}

export class RuntimeService {
  constructor(private readonly config: AppConfig) {}

  getHealth(): RuntimeHealth[] {
    return (["claude", "codex"] as const).map((runtime) => {
      const profiles = Object.values(this.config.profiles).filter((profile) => profile.runtime === runtime);
      const missingSecretRefs = profiles
        .map((profile) => this.config.accounts[profile.accountId])
        .filter((account): account is NonNullable<typeof account> => Boolean(account))
        .filter((account) => account.secretRef.startsWith("env:") && process.env[account.secretRef.slice(4)] === undefined)
        .map((account) => account.secretRef);
      const missingAccounts = profiles
        .filter((profile) => !this.config.accounts[profile.accountId])
        .map((profile) => profile.accountId);
      const messages = [
        ...(profiles.length === 0 ? ["no profiles configured"] : []),
        ...unique(missingAccounts).map((accountId) => `missing account:${accountId}`),
        ...unique(missingSecretRefs).map((secretRef) => `missing ${secretRef}`),
      ];

      return {
        runtime,
        profiles: profiles.map((profile) => profile.id),
        available: profiles.length > 0 && messages.length === 0,
        ...(messages.length > 0 ? { message: messages.join("; ") } : {}),
      };
    });
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

export function createAppServices(config: AppConfig, orchestrator: Orchestrator): AppServices {
  return {
    config: new ConfigService(config),
    tasks: new TaskService(orchestrator),
    approvals: new ApprovalService(orchestrator),
    workspaces: new WorkspaceService(orchestrator),
    events: new EventService(orchestrator),
    runtime: new RuntimeService(config),
    orchestrator,
    close: () => orchestrator.close(),
  };
}

export async function openAppServices(configPath: string): Promise<AppServices> {
  await ensureDefaultConfig(configPath);
  const config = await loadConfig(configPath);
  const db = new AppDatabase({
    dbPath: config.storage.dbPath,
    busyTimeoutMs: config.storage.busyTimeoutMs,
  });
  let orchestrator: Orchestrator;
  const { Orchestrator: OrchestratorCtor } = await import("../orchestrator/orchestrator.js");
  const claude = new ClaudeRuntimeAdapter({
    config,
    createMcpHandlers: (taskId) => orchestrator.createMcpHandlers(taskId),
    requestApproval: (input) => orchestrator.requestCapability(input),
  });
  const codex = new CodexRuntimeAdapter({
    config,
    configPath,
  });
  orchestrator = new OrchestratorCtor(config, db, {
    claude,
    codex,
  });
  orchestrator.syncConfig();
  return createAppServices(config, orchestrator);
}

export async function ensureDefaultConfig(configPath = defaultConfigPath()): Promise<void> {
  try {
    await fs.access(configPath);
    return;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const normalizedHomeConfig = configPath.replace(/\\/g, "/");
  const rootDir = path.join(path.dirname(configPath), "workspaces").replace(/\\/g, "/");
  await fs.writeFile(configPath, `# Auto-PM Lite default config

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

[account.anthropic_env]
vendor = "anthropic"
secret_ref = "env:ANTHROPIC_API_KEY"

[account.openai_env]
vendor = "openai"
secret_ref = "env:OPENAI_API_KEY"

[profile.claude_readonly]
runtime = "claude"
account = "anthropic_env"
policy = "readonly"
model = "claude-opus-4-7"

[profile.codex_edit]
runtime = "codex"
account = "openai_env"
policy = "edit"
model = "gpt-5-codex"

# Set ANTHROPIC_API_KEY / OPENAI_API_KEY in the environment before running live tasks.
# Config path: ${normalizedHomeConfig}
`, "utf8");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
