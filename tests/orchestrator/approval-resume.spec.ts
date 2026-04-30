import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { AppDatabase } from "../../src/storage/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AgentEvent } from "../../src/core/types.js";
import type { RuntimeAdapter, RuntimeTaskHandle, RunTurnInput, StartRuntimeTaskInput, ResumeRuntimeTaskInput } from "../../src/runtime/adapter.js";

const tempPaths: string[] = [];

class FakeAdapter implements RuntimeAdapter {
  readonly runtime: RuntimeAdapter["runtime"] = "claude";
  public usage = { inputTokens: 100, outputTokens: 50 };
  public resumeCount = 0;
  public startCount = 0;

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.startCount += 1;
    return { taskId: input.taskId, backendThreadId: `thread-${input.taskId}` };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };
    yield { type: "message.completed", taskId: input.taskId, turnId: "turn-1", text: "hi", ts };
    yield { type: "turn.completed", taskId: input.taskId, turnId: "turn-1", usage: this.usage, ts };
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.resumeCount += 1;
    return { taskId: input.taskId, backendThreadId: input.backendThreadId };
  }

  async cancelTask(_taskId: string): Promise<void> {}
  async closeTask(_taskId: string): Promise<void> {}
}

class FakeCodexAdapter implements RuntimeAdapter {
  readonly runtime: RuntimeAdapter["runtime"] = "codex";
  public startCount = 0;

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.startCount += 1;
    return { taskId: input.taskId, backendThreadId: `codex-thread-${input.taskId}` };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };
    yield { type: "message.completed", taskId: input.taskId, turnId: "turn-1", text: `codex:${input.prompt}`, ts };
    yield { type: "turn.completed", taskId: input.taskId, turnId: "turn-1", usage: { inputTokens: 10, outputTokens: 5 }, ts };
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return { taskId: input.taskId, backendThreadId: input.backendThreadId };
  }

  async cancelTask(_taskId: string): Promise<void> {}
  async closeTask(_taskId: string): Promise<void> {}
}

class ThrowingStartAdapter extends FakeAdapter {
  override async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };
    throw new Error("start exploded");
  }
}

class ThrowingResumeAdapter extends FakeAdapter {
  private turnCount = 0;

  override async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    this.turnCount += 1;
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };
    if (this.turnCount === 1) {
      yield { type: "message.completed", taskId: input.taskId, turnId: "turn-1", text: "seed", ts };
      yield { type: "turn.completed", taskId: input.taskId, turnId: "turn-1", usage: this.usage, ts };
      return;
    }
    throw new Error("resume exploded");
  }
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

async function buildEnvWithAdapters(adapters: { claude?: RuntimeAdapter; codex?: RuntimeAdapter }, options?: {
  maxTokens?: number;
  requireApprovalFor?: string[];
  enableDelegation?: boolean;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-budget-"));
  tempPaths.push(root);
  const dbPath = path.join(root, "db.sqlite");
  const configPath = path.join(root, "config.toml");
  const wsRoot = path.join(root, "workspaces");
  const tokenLine = options?.maxTokens === undefined ? "" : `maxTokens = ${options.maxTokens}`;
  const requireApprovalFor = options?.requireApprovalFor ?? [];
  const delegationPolicy = options?.enableDelegation
    ? `allowCrossHarnessDelegation = true\nallowChildEdit = false\nallowChildNetwork = false`
    : `allowCrossHarnessDelegation = false\nallowChildEdit = false\nallowChildNetwork = false`;
  await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${wsRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = false

[policy.basic]
permissionMode = "read-only"
sandboxMode = "read-only"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = [${requireApprovalFor.map((entry) => `"${entry}"`).join(", ")}]
maxDepth = 1
${delegationPolicy}
${tokenLine}

[policy.child]
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

[profile.claude_main]
runtime = "claude"
accountId = "anthropic_personal"
policyId = "basic"
model = "claude-opus-4-7"

[profile.codex_child]
runtime = "codex"
accountId = "openai_personal"
policyId = "child"
model = "gpt-5-codex"
`, "utf8");

  const config = await loadConfig(configPath);
  const db = new AppDatabase({ dbPath: config.storage.dbPath, busyTimeoutMs: config.storage.busyTimeoutMs });
  const claude = adapters.claude ?? new FakeAdapter();
  const codex = adapters.codex ?? new FakeCodexAdapter();
  const orchestrator = new Orchestrator(config, db, { claude, codex });
  orchestrator.syncConfig();
  return { claude, codex, db, orchestrator, root };
}

async function buildEnv(options?: {
  maxTokens?: number;
  requireApprovalFor?: string[];
  enableDelegation?: boolean;
}) {
  const env = await buildEnvWithAdapters({}, options);
  return {
    adapter: env.claude as FakeAdapter,
    codex: env.codex as FakeCodexAdapter,
    db: env.db,
    orchestrator: env.orchestrator,
    root: env.root,
  };
}

describe("budget auto-pause + approval-resume", () => {
  it("pauses task and creates a budget_increase approval when maxTokens is exceeded", async () => {
    const { adapter, db, orchestrator, root } = await buildEnv({ maxTokens: 100 });
    adapter.usage = { inputTokens: 200, outputTokens: 100 };

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });

      const stored = db.getTask(task.id);
      expect(stored?.status).toBe("awaiting_approval");

      const approvals = orchestrator.listApprovals(task.id);
      const budgetApproval = approvals.find((entry) => entry.kind === "budget_increase");
      expect(budgetApproval).toBeDefined();
    } finally {
      await orchestrator.close();
    }
  });

  it("approving budget_increase resets usage and leaves the task in continuation flow", async () => {
    const { adapter, db, orchestrator, root } = await buildEnv({ maxTokens: 100 });
    adapter.usage = { inputTokens: 200, outputTokens: 100 };

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });

      const approval = orchestrator.listApprovals(task.id).find((a) => a.kind === "budget_increase");
      expect(approval).toBeDefined();

      await orchestrator.resolveApproval({ approvalId: approval!.id, approved: true });

      const stored = db.getTask(task.id);
      expect(["queued", "running", "completed", "awaiting_approval"]).toContain(stored?.status);
      expect(stored?.budget.inputTokens).toBe(0);
      expect(stored?.budget.outputTokens).toBe(0);
    } finally {
      await orchestrator.close();
    }
  });

  it("denying budget_increase leaves task in awaiting_approval", async () => {
    const { adapter, db, orchestrator, root } = await buildEnv({ maxTokens: 100 });
    adapter.usage = { inputTokens: 200, outputTokens: 100 };

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });

      const approval = orchestrator.listApprovals(task.id).find((a) => a.kind === "budget_increase");
      await orchestrator.resolveApproval({ approvalId: approval!.id, approved: false });

      const stored = db.getTask(task.id);
      expect(stored?.status).toBe("awaiting_approval");
    } finally {
      await orchestrator.close();
    }
  });

  it("approving budget_increase schedules automatic continuation", async () => {
    const { adapter, orchestrator, root } = await buildEnv({ maxTokens: 100 });
    adapter.usage = { inputTokens: 200, outputTokens: 100 };

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });

      const approval = orchestrator.listApprovals(task.id).find((a) => a.kind === "budget_increase");
      expect(approval).toBeDefined();

      await orchestrator.resolveApproval({ approvalId: approval!.id, approved: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(adapter.resumeCount + adapter.startCount).toBeGreaterThan(1);
    } finally {
      await orchestrator.close();
    }
  });

  it("waits for the last pending approval before continuing", async () => {
    const { adapter, db, orchestrator, root } = await buildEnv({ maxTokens: 100 });
    adapter.usage = { inputTokens: 200, outputTokens: 100 };

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });

      const extraApprovalId = orchestrator.createApproval({
        taskId: task.id,
        kind: "clarification",
        payload: { reason: "need input" },
      });

      const budgetApproval = orchestrator.listApprovals(task.id).find((a) => a.kind === "budget_increase");
      expect(budgetApproval).toBeDefined();

      await orchestrator.resolveApproval({ approvalId: budgetApproval!.id, approved: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(adapter.resumeCount + adapter.startCount).toBe(1);
      expect(db.getTask(task.id)?.status).toBe("awaiting_approval");

      await orchestrator.resolveApproval({ approvalId: extraApprovalId, approved: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(adapter.resumeCount + adapter.startCount).toBeGreaterThan(1);
    } finally {
      await orchestrator.close();
    }
  });

  it("resolving delegation approval requeues but does not auto-replay the child request", async () => {
    const { codex, db, orchestrator, root } = await buildEnv({
      requireApprovalFor: ["cross_harness_delegation"],
      enableDelegation: true,
    });

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      const result = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "ask",
        prompt: "review",
        reason: "approval gate",
        workspaceMode: "share",
        requestedPermissionMode: "read-only",
      });

      expect(result.status).toBe("awaiting_approval");
      expect(codex.startCount).toBe(0);

      await orchestrator.resolveApproval({ approvalId: result.approvalId!, approved: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(db.getTask(parent.id)?.status).toBe("queued");
      expect(codex.startCount).toBe(0);
      expect(db.listTasks().filter((task) => task.runtime === "codex")).toHaveLength(0);
    } finally {
      await orchestrator.close();
    }
  });
});

describe("failure semantics", () => {
  it("marks runTask failures as interrupted and emits task.interrupted", async () => {
    const { db, orchestrator, root } = await buildEnvWithAdapters({ claude: new ThrowingStartAdapter() });

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      const liveTypes: string[] = [];
      const unsubscribe = orchestrator.subscribeToEvents((event) => {
        liveTypes.push(event.type);
      });

      await expect(orchestrator.runTask({ taskId: task.id, prompt: "go" })).rejects.toThrow("start exploded");
      unsubscribe();

      expect(db.getTask(task.id)?.status).toBe("interrupted");
      expect(liveTypes).toContain("task.interrupted");
      expect(db.listEvents({ taskId: task.id }).map((row) => row.type)).toContain("task.interrupted");
    } finally {
      await orchestrator.close();
    }
  });

  it("marks resumeTask failures as failed and emits task.failed", async () => {
    const adapter = new ThrowingResumeAdapter();
    const { db, orchestrator, root } = await buildEnvWithAdapters({ claude: adapter });

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "seed" });

      db.updateTaskRuntimeState({
        taskId: task.id,
        status: "interrupted",
        backendThreadId: `thread-${task.id}`,
        updatedAt: new Date().toISOString(),
      });

      const liveTypes: string[] = [];
      const unsubscribe = orchestrator.subscribeToEvents((event) => {
        liveTypes.push(event.type);
      });

      await expect(orchestrator.resumeTask({ taskId: task.id, prompt: "resume" })).rejects.toThrow("resume exploded");
      unsubscribe();

      expect(db.getTask(task.id)?.status).toBe("failed");
      expect(liveTypes).toContain("task.failed");
      expect(db.listEvents({ taskId: task.id }).map((row) => row.type)).toContain("task.failed");
    } finally {
      await orchestrator.close();
    }
  });
});

describe("event replay", () => {
  it("replayAndSubscribe drains persisted events first then attaches live", async () => {
    const { db, orchestrator, root } = await buildEnv();

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });

      const seenTypes: string[] = [];
      const { unsubscribe } = await orchestrator.replayAndSubscribe({
        taskId: task.id,
        listener: (event) => {
          seenTypes.push(event.type);
        },
      });
      unsubscribe();

      expect(seenTypes).toContain("task.queued");
      expect(seenTypes).toContain("task.started");
      expect(seenTypes).toContain("turn.completed");
      expect(seenTypes).toContain("task.completed");
      const completedCount = seenTypes.filter((t) => t === "task.completed").length;
      expect(completedCount).toBe(1);
      const rows = db.listEvents({ taskId: task.id });
      expect(rows.length).toBe(seenTypes.length);
    } finally {
      await orchestrator.close();
    }
  });

  it("publishes task.queued to live subscribers and durable replay", async () => {
    const { db, orchestrator, root } = await buildEnv();

    try {
      const liveTypes: string[] = [];
      const unsubscribe = orchestrator.subscribeToEvents((event) => {
        liveTypes.push(event.type);
      });

      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      unsubscribe();

      expect(liveTypes).toContain("task.queued");
      expect(db.listEvents({ taskId: task.id }).map((row) => row.type)).toContain("task.queued");
    } finally {
      await orchestrator.close();
    }
  });

  it("publishes task.cancelled to live subscribers and durable replay", async () => {
    const { db, orchestrator, root } = await buildEnv();

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      const liveTypes: string[] = [];
      const unsubscribe = orchestrator.subscribeToEvents((event) => {
        liveTypes.push(event.type);
      });

      await orchestrator.cancelTask(task.id);
      unsubscribe();

      expect(liveTypes).toContain("task.cancelled");
      expect(db.listEvents({ taskId: task.id }).map((row) => row.type)).toContain("task.cancelled");
    } finally {
      await orchestrator.close();
    }
  });

  it("publishes approval.resolved to live subscribers and durable replay", async () => {
    const { adapter, db, orchestrator, root } = await buildEnv({ maxTokens: 100 });
    adapter.usage = { inputTokens: 200, outputTokens: 100 };

    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.runTask({ taskId: task.id, prompt: "go" });
      const approval = orchestrator.listApprovals(task.id).find((a) => a.kind === "budget_increase");
      expect(approval).toBeDefined();

      const liveTypes: string[] = [];
      const unsubscribe = orchestrator.subscribeToEvents((event) => {
        liveTypes.push(event.type);
      });

      await orchestrator.resolveApproval({ approvalId: approval!.id, approved: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      unsubscribe();

      expect(liveTypes).toContain("approval.resolved");
      expect(db.listEvents({ taskId: task.id }).map((row) => row.type)).toContain("approval.resolved");
    } finally {
      await orchestrator.close();
    }
  });
});
