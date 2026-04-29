import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { AppDatabase } from "../../src/storage/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { WorkspaceManager } from "../../src/orchestrator/workspace.js";
import type { AgentEvent } from "../../src/core/types.js";
import type { RuntimeAdapter, RuntimeTaskHandle, RunTurnInput, StartRuntimeTaskInput, ResumeRuntimeTaskInput } from "../../src/runtime/adapter.js";

const tempPaths: string[] = [];

class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: RuntimeAdapter["runtime"] = "claude";
  public failNextRun = false;
  public cancelCalls = 0;
  public resumeCalls = 0;

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return {
      taskId: input.taskId,
      backendThreadId: `thread-${input.taskId}`,
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };

    if (this.failNextRun) {
      this.failNextRun = false;
      throw new Error("boom");
    }

    yield { type: "message.completed", taskId: input.taskId, turnId: "turn-1", text: `echo:${input.prompt}`, ts };
    yield { type: "file.changed", taskId: input.taskId, path: "notes.txt", changeKind: "modify", ts };
    yield { type: "turn.completed", taskId: input.taskId, turnId: "turn-1", usage: { inputTokens: 3, outputTokens: 2 }, ts };
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.resumeCalls += 1;
    return {
      taskId: input.taskId,
      backendThreadId: input.backendThreadId,
    };
  }

  async cancelTask(_taskId: string): Promise<void> {
    this.cancelCalls += 1;
  }

  async closeTask(_taskId: string): Promise<void> {}
}

class FakeCodexRuntimeAdapter extends FakeRuntimeAdapter {
  override readonly runtime: RuntimeAdapter["runtime"] = "codex";
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("Phase 1 boundary", () => {
  it("loads config and resolves top-level task workspace policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-phase1-"));
    tempPaths.push(root);

    const dbPath = path.join(root, "auto-pm-lite.db");
    const configPath = path.join(root, "config.toml");
    const workspaceRoot = path.join(root, "workspaces");

    await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = true

[policy.local_readonly]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 1
allowCrossHarnessDelegation = false
allowChildEdit = false
allowChildNetwork = false

[account.anthropic_personal]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[profile.claude_readonly]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "local_readonly"
model = "claude-opus-4-7"
`, "utf8");

    const config = await loadConfig(configPath);
    const manager = new WorkspaceManager(config.workspace);
    const workspace = manager.createTopLevelWorkspace({
      taskId: "phase1-task",
      cwd: "D:/Code/Auto-PM-Lite",
    });

    expect(Object.keys(config.accounts)).toEqual(["anthropic_personal"]);
    expect(Object.keys(config.policies)).toEqual(["local_readonly"]);
    expect(Object.keys(config.profiles)).toEqual(["claude_readonly"]);
    expect(config.storage.dbPath.replace(/\\/g, "/")).toBe(dbPath.replace(/\\/g, "/"));
    expect(workspace.path).toBe(path.join(workspaceRoot, "phase1-task"));
    expect(workspace.unsafeDirectCwd).toBe(false);
  });

  it("persists runtime events and marks tasks completed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-phase2-"));
    tempPaths.push(root);

    const dbPath = path.join(root, "auto-pm-lite.db");
    const configPath = path.join(root, "config.toml");
    const workspaceRoot = path.join(root, "workspaces");

    await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = true

[policy.local_readonly]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 1
allowCrossHarnessDelegation = false
allowChildEdit = false
allowChildNetwork = false

[account.anthropic_personal]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[profile.claude_readonly]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "local_readonly"
model = "claude-opus-4-7"
`, "utf8");

    const config = await loadConfig(configPath);
    const db = new AppDatabase({
      dbPath: config.storage.dbPath,
      busyTimeoutMs: config.storage.busyTimeoutMs,
    });
    const runtime = new FakeRuntimeAdapter();
    const orchestrator = new Orchestrator(config, db, {
      claude: runtime,
    });

    orchestrator.syncConfig();

    try {
      const task = await orchestrator.createTask({
        profileId: "claude_readonly",
        cwd: "D:/Code/Auto-PM-Lite",
        name: "runtime-check",
      });

      await orchestrator.runTask({
        taskId: task.id,
        prompt: "hello",
      });

      const storedTask = db.getTask(task.id);
      expect(storedTask?.status).toBe("completed");
      expect(storedTask?.backendThreadId).toBe(`thread-${task.id}`);

      const events = db.db.prepare(`SELECT type, payload_json FROM events WHERE task_id = ? ORDER BY id ASC`).all(task.id) as Array<{ type: string; payload_json: string }>;
      expect(events.map((event) => event.type)).toEqual([
        "task.queued",
        "task.started",
        "turn.started",
        "message.completed",
        "file.changed",
        "turn.completed",
        "task.completed",
      ]);

      const turns = db.listTurns(task.id);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.status).toBe("completed");
      expect(turns[0]?.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

      const fileChanges = db.db.prepare(`SELECT path, change_kind FROM file_changes WHERE task_id = ?`).all(task.id) as Array<{ path: string; change_kind: string }>;
      expect(fileChanges).toEqual([{ path: "notes.txt", change_kind: "modify" }]);
    } finally {
      await orchestrator.close();
    }
  });

  it("blocks resume when pending approvals exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-approval-"));
    tempPaths.push(root);

    const dbPath = path.join(root, "auto-pm-lite.db");
    const configPath = path.join(root, "config.toml");
    const workspaceRoot = path.join(root, "workspaces");

    await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = false

[policy.local_readonly]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 1
allowCrossHarnessDelegation = false
allowChildEdit = false
allowChildNetwork = false

[account.anthropic_personal]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[profile.claude_readonly]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "local_readonly"
model = "claude-opus-4-7"
`, "utf8");

    const config = await loadConfig(configPath);
    const db = new AppDatabase({
      dbPath: config.storage.dbPath,
      busyTimeoutMs: config.storage.busyTimeoutMs,
    });
    const runtime = new FakeRuntimeAdapter();
    const orchestrator = new Orchestrator(config, db, {
      claude: runtime,
    });

    orchestrator.syncConfig();

    try {
      const task = await orchestrator.createTask({
        profileId: "claude_readonly",
        cwd: root,
        name: "approval-check",
      });

      db.updateTaskRuntimeState({
        taskId: task.id,
        status: "interrupted",
        backendThreadId: `thread-${task.id}`,
        updatedAt: new Date().toISOString(),
      });
      db.createTurn({
        id: "turn-existing",
        taskId: task.id,
        promptRedacted: "resume me",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      orchestrator.createApproval({
        taskId: task.id,
        kind: "filesystem",
        payload: { path: "notes.txt" },
      });

      await expect(orchestrator.resumeTask({ taskId: task.id })).rejects.toThrow("requires reconciliation before resume");
      expect(db.getTask(task.id)?.status).toBe("reconcile_required");
    } finally {
      await orchestrator.close();
    }
  });

  it("delegates read-only work across runtimes and returns child results", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-phase3-"));
    tempPaths.push(root);

    const dbPath = path.join(root, "auto-pm-lite.db");
    const configPath = path.join(root, "config.toml");
    const workspaceRoot = path.join(root, "workspaces");

    await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = false

[policy.delegating_readonly]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 2
allowCrossHarnessDelegation = true
allowChildEdit = false
allowChildNetwork = false

[policy.child_readonly]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 2
allowCrossHarnessDelegation = true
allowChildEdit = false
allowChildNetwork = false

[account.anthropic_personal]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[account.openai_personal]
vendor = "openai"
secretRef = "env:OPENAI_API_KEY"

[profile.claude_parent]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "delegating_readonly"
model = "claude-opus-4-7"

[profile.codex_child]
runtime = "codex"
accountId = "openai_personal"
policyId = "child_readonly"
model = "gpt-5-codex"
`, "utf8");

    const config = await loadConfig(configPath);
    const db = new AppDatabase({
      dbPath: config.storage.dbPath,
      busyTimeoutMs: config.storage.busyTimeoutMs,
    });
    const claude = new FakeRuntimeAdapter();
    const codex = new FakeCodexRuntimeAdapter();
    const orchestrator = new Orchestrator(config, db, {
      claude,
      codex,
    });

    orchestrator.syncConfig();

    try {
      const parent = await orchestrator.createTask({
        profileId: "claude_parent",
        cwd: root,
        name: "parent-task",
      });

      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "ask",
        prompt: "review this",
        reason: "cross-check",
        workspaceMode: "share",
        requestedPermissionMode: "read-only",
      });

      const childTask = orchestrator.getTask(delegated.childTaskId);
      expect(childTask?.parentTaskId).toBe(parent.id);
      expect(childTask?.runtime).toBe("codex");
      expect(childTask?.cwd).toBe(parent.cwd);
      expect(childTask?.status).toBe("completed");
      expect(delegated.result.status).toBe("completed");
      expect(delegated.result.latestMessage).toBe("echo:review this");
      expect(orchestrator.waitForTask(parent.id, delegated.childTaskId).taskId).toBe(delegated.childTaskId);

      const events = db.db.prepare(`SELECT type FROM events WHERE task_id = ? ORDER BY id ASC`).all(parent.id) as Array<{ type: string }>;
      expect(events.map((event) => event.type)).toContain("delegation.requested");
      expect(events.map((event) => event.type)).toContain("delegation.started");
      expect(events.map((event) => event.type)).toContain("delegation.completed");
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects delegation cycles and depth violations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-phase3-guards-"));
    tempPaths.push(root);

    const dbPath = path.join(root, "auto-pm-lite.db");
    const configPath = path.join(root, "config.toml");
    const workspaceRoot = path.join(root, "workspaces");

    await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = false

[policy.strict_parent]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 1
allowCrossHarnessDelegation = true
allowChildEdit = false
allowChildNetwork = false

[policy.strict_child]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 1
allowCrossHarnessDelegation = true
allowChildEdit = false
allowChildNetwork = false

[account.anthropic_personal]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[account.openai_personal]
vendor = "openai"
secretRef = "env:OPENAI_API_KEY"

[profile.claude_parent]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "strict_parent"
model = "claude-opus-4-7"

[profile.codex_child]
runtime = "codex"
accountId = "openai_personal"
policyId = "strict_child"
model = "gpt-5-codex"
`, "utf8");

    const config = await loadConfig(configPath);
    const db = new AppDatabase({
      dbPath: config.storage.dbPath,
      busyTimeoutMs: config.storage.busyTimeoutMs,
    });
    const claude = new FakeRuntimeAdapter();
    const codex = new FakeCodexRuntimeAdapter();
    const orchestrator = new Orchestrator(config, db, {
      claude,
      codex,
    });

    orchestrator.syncConfig();

    try {
      const parent = await orchestrator.createTask({
        profileId: "claude_parent",
        cwd: root,
        name: "depth-parent",
      });

      const child = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "ask",
        prompt: "first hop",
        reason: "cross-check",
        workspaceMode: "share",
        requestedPermissionMode: "read-only",
      });

      await expect(orchestrator.delegateTask({
        parentTaskId: child.childTaskId,
        targetRuntime: "claude",
        taskType: "ask",
        prompt: "second hop",
        reason: "loop back",
        workspaceMode: "share",
        requestedPermissionMode: "read-only",
      })).rejects.toThrow(/max_depth|cycle_detected/);
    } finally {
      await orchestrator.close();
    }
  });

  it("persists capability requests and artifacts for delegated tasks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-phase3-artifacts-"));
    tempPaths.push(root);

    const dbPath = path.join(root, "auto-pm-lite.db");
    const configPath = path.join(root, "config.toml");
    const workspaceRoot = path.join(root, "workspaces");

    await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = false

[policy.delegating_readonly]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 2
allowCrossHarnessDelegation = true
allowChildEdit = false
allowChildNetwork = false

[account.anthropic_personal]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[profile.claude_parent]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "delegating_readonly"
model = "claude-opus-4-7"
`, "utf8");

    const config = await loadConfig(configPath);
    const db = new AppDatabase({
      dbPath: config.storage.dbPath,
      busyTimeoutMs: config.storage.busyTimeoutMs,
    });
    const claude = new FakeRuntimeAdapter();
    const orchestrator = new Orchestrator(config, db, {
      claude,
    });

    orchestrator.syncConfig();

    try {
      const parent = await orchestrator.createTask({
        profileId: "claude_parent",
        cwd: root,
        name: "artifact-parent",
      });

      const approval = await orchestrator.requestCapability({
        taskId: parent.id,
        kind: "filesystem",
        reason: "need write approval",
      });
      expect(approval.status).toBe("pending");
      expect(orchestrator.listApprovals(parent.id)).toHaveLength(1);

      const artifact = orchestrator.reportArtifact({
        taskId: parent.id,
        kind: "file",
        ref: "reports/out.txt",
        description: "generated report",
      });
      expect(artifact.kind).toBe("file");
      expect(orchestrator.listArtifacts(parent.id)).toEqual([artifact]);

      const result = orchestrator.getTaskResult(parent.id, parent.id);
      expect(result.artifacts).toEqual([artifact]);
      expect(result.pendingApprovalIds).toEqual([approval.approvalId]);
    } finally {
      await orchestrator.close();
    }
  });
});
