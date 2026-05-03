import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { AppDatabase } from "../../storage/db.js";
import { Orchestrator } from "../../orchestrator/orchestrator.js";
import { createAppServices, type AppServices } from "../../service/app-services.js";
import { loadConfig } from "../../core/config.js";
import type { AgentEvent, AppConfig } from "../../core/types.js";
import type { ResumeRuntimeTaskInput, RunTurnInput, RuntimeAdapter, RuntimeTaskHandle, StartRuntimeTaskInput } from "../../runtime/adapter.js";

export async function openDesktopSmokeServices(configPath: string): Promise<AppServices> {
  await ensureDesktopSmokeConfig(configPath);
  process.env.AUTO_PM_DESKTOP_FAKE_KEY = process.env.AUTO_PM_DESKTOP_FAKE_KEY ?? "desktop-smoke-secret";
  const config = await loadConfig(configPath);
  await prepareSmokeGitWorkspace(config);
  const db = new AppDatabase({
    dbPath: config.storage.dbPath,
    busyTimeoutMs: config.storage.busyTimeoutMs,
  });
  const orchestrator = new Orchestrator(config, db, {
    claude: new DesktopSmokeRuntime("claude", config),
    codex: new DesktopSmokeRuntime("codex", config),
  });
  orchestrator.syncConfig();
  orchestrator.recoverStaleRunningTasks();
  return createAppServices(config, orchestrator);
}

async function ensureDesktopSmokeConfig(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const rootDir = path.join(path.dirname(configPath), "workspaces").replace(/\\/g, "/");
  const dbPath = path.join(path.dirname(configPath), "auto-pm-lite.db").replace(/\\/g, "/");
  await fs.writeFile(configPath, `# Auto-PM Lite desktop smoke config

[storage]
db_path = "${dbPath}"
busy_timeout_ms = 5000
max_queue_size = 5000
flush_batch_size = 100

[workspace]
root_dir = "${rootDir}"
top_level_use_worktree = true

[transcript]
store_raw_encrypted = false

[policy.edit_parent]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 2
allow_cross_harness_delegation = true
allow_child_edit = true
allow_child_network = false
unsafe_direct_cwd = false

[policy.edit_child]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 2
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[account.fake_anthropic]
vendor = "anthropic"
secret_ref = "env:AUTO_PM_DESKTOP_FAKE_KEY"

[account.fake_openai]
vendor = "openai"
secret_ref = "env:AUTO_PM_DESKTOP_FAKE_KEY"

[profile.claude_edit]
runtime = "claude"
account = "fake_anthropic"
policy = "edit_parent"
model = "desktop-smoke"
claude_permission_mode = "default"

[profile.codex_edit]
runtime = "codex"
account = "fake_openai"
policy = "edit_child"
model = "desktop-smoke"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = false
`, "utf8");
}

class DesktopSmokeRuntime implements RuntimeAdapter {
  constructor(readonly runtime: RuntimeAdapter["runtime"], private readonly config: AppConfig) {}

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return { taskId: input.taskId, backendThreadId: `smoke-thread-${input.taskId}` };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const turnId = `turn-${input.taskId}`;
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId, ts };
    yield { type: "message.completed", taskId: input.taskId, turnId, text: `smoke:${input.prompt}`, ts };

    if (this.runtime === "claude") {
      yield { type: "delegation.requested", taskId: input.taskId, request: { taskType: "edit", reason: "desktop smoke" }, ts };
    } else {
      await fs.writeFile(path.join(input.cwd, `smoke-${input.taskId.slice(0, 8)}.txt`), "desktop smoke\n", "utf8");
      yield { type: "file.changed", taskId: input.taskId, path: `smoke-${input.taskId.slice(0, 8)}.txt`, changeKind: "create", ts };
    }

    yield { type: "turn.completed", taskId: input.taskId, turnId, usage: { inputTokens: 1, outputTokens: 1 }, ts };
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return { taskId: input.taskId, backendThreadId: input.backendThreadId };
  }

  async pauseTask(_taskId: string): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async closeTask(_taskId: string): Promise<void> {}
}

async function prepareSmokeGitWorkspace(config: AppConfig): Promise<void> {
  const root = config.workspace.rootDir;
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  if (!fsSync.existsSync(path.join(repo, ".git"))) {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop Smoke"], { cwd: repo, stdio: "ignore" });
  }
  const readme = path.join(repo, "README.md");
  if (!fsSync.existsSync(readme)) {
    await fs.writeFile(readme, "desktop smoke\n", "utf8");
  }
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
  if (status.length > 0) {
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initialize desktop smoke workspace."], { cwd: repo, stdio: "ignore" });
  }
}
