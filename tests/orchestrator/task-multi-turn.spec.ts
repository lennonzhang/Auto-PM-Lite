import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { AppDatabase } from "../../src/storage/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { ForkRuntimeSessionInput, ForkRuntimeSessionResult, ResumeRuntimeTaskInput, RunTurnInput, RuntimeAdapter, RuntimeAdapterOutput, RuntimeTaskHandle, StartRuntimeTaskInput } from "../../src/runtime/adapter.js";
import { messageCompleted, turnCompleted, turnStarted } from "../helpers/v2-runtime.js";

const tempPaths: string[] = [];

class MultiTurnRuntime implements RuntimeAdapter {
  readonly runtime: RuntimeAdapter["runtime"];
  readonly starts: StartRuntimeTaskInput[] = [];
  readonly resumes: ResumeRuntimeTaskInput[] = [];
  readonly turns: RunTurnInput[] = [];
  readonly closes: string[] = [];
  readonly cancels: string[] = [];
  readonly forks: ForkRuntimeSessionInput[] = [];
  delayMs = 0;
  failNextTurn = false;

  constructor(runtime: RuntimeAdapter["runtime"] = "claude") {
    this.runtime = runtime;
  }

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.starts.push(input);
    return { taskId: input.taskId, sessionId: input.sessionId, backendThreadId: `${this.runtime}-thread-${input.sessionId}` };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<RuntimeAdapterOutput> {
    this.turns.push(input);
    const ts = new Date().toISOString();
    yield turnStarted(input);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failNextTurn) {
      this.failNextTurn = false;
      throw new Error("runtime exploded");
    }
    yield messageCompleted(input, `reply:${input.prompt}`, ts);
    yield turnCompleted(input, { inputTokens: 1, outputTokens: 1 }, ts);
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    this.resumes.push(input);
    return { taskId: input.taskId, sessionId: input.sessionId, backendThreadId: input.backendThreadId };
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<ForkRuntimeSessionResult> {
    this.forks.push(input);
    return { backendThreadId: `forked-${input.targetSessionId}`, forkKind: "native" };
  }

  async pauseTask(sessionId: string): Promise<void> {
    this.cancels.push(sessionId);
  }

  async cancelTask(sessionId: string): Promise<void> {
    this.cancels.push(sessionId);
  }

  async closeTask(sessionId: string): Promise<void> {
    this.closes.push(sessionId);
  }
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("task multi-turn lifecycle", () => {
  it("keeps task idle after each turn and reuses the active session for follow-up turns", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "multi" });

      for (let index = 0; index < 5; index += 1) {
        await orchestrator.sendTurn({ taskId: task.id, prompt: `turn-${index}` });
        expect(db.getTask(task.id)?.status).toBe("idle");
      }

      const sessions = db.listRuntimeSessions(task.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe("active");
      expect(db.listTurns(task.id).map((turn) => turn.turnNumber)).toEqual([1, 2, 3, 4, 5]);
      expect(runtime.starts).toHaveLength(1);
      expect(runtime.resumes).toHaveLength(4);
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects concurrent sendTurn and deduplicates requestId retries", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      runtime.delayMs = 60;
      const running = orchestrator.sendTurn({ taskId: task.id, prompt: "slow", requestId: "req-1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(orchestrator.sendTurn({ taskId: task.id, prompt: "parallel" })).rejects.toThrow("task_busy");
      await running;

      await orchestrator.sendTurn({ taskId: task.id, prompt: "same", requestId: "req-2" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "same ignored", requestId: "req-2" });
      expect(db.listTurns(task.id).map((turn) => turn.requestId)).toEqual(["req-1", "req-2"]);
    } finally {
      await orchestrator.close();
    }
  });

  it("runs cancellation as cancelling to interrupted and closes active sessions", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sessionId = db.getCurrentSession(task.id)?.id;
      await orchestrator.cancelTask(task.id, "stop");

      expect(db.getTask(task.id)?.status).toBe("interrupted");
      expect(db.getRuntimeSession(sessionId ?? "")?.closeReason).toBe("cancelled");
      expect(runtime.cancels).toEqual([sessionId]);
      expect(runtime.closes).toContain(sessionId);
      expect(db.listTaskEvents({ taskId: task.id }).map((row) => row.event.kind)).toEqual(expect.arrayContaining([
        "task.cancellation_requested",
        "task.cancelled",
      ]));
    } finally {
      await orchestrator.close();
    }
  });

  it("only turns closed through explicit closeTask", async () => {
    const { db, orchestrator, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      expect(db.getTask(task.id)?.status).toBe("idle");

      await orchestrator.closeTask(task.id, "done");
      expect(db.getTask(task.id)?.status).toBe("closed");
      expect(db.getTask(task.id)?.closedAt).toBeDefined();
      expect(db.listTaskEvents({ taskId: task.id }).map((row) => row.event.kind)).toContain("task.closed");
    } finally {
      await orchestrator.close();
    }
  });

  it("handoff opens a target session and closes the source only after target turn succeeds", async () => {
    const claude = new MultiTurnRuntime("claude");
    const codex = new MultiTurnRuntime("codex");
    const { db, orchestrator, root } = await buildEnv({ claude, codex });
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "handoff" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sourceSession = db.getCurrentSession(task.id);

      await orchestrator.handoffTask({ taskId: task.id, targetProfileId: "codex_main", reason: "switch", prompt: "continue" });

      const sessions = db.listRuntimeSessions(task.id);
      expect(sessions).toHaveLength(2);
      expect(sessions.find((session) => session.id === sourceSession?.id)?.closeReason).toBe("handoff");
      expect(db.getCurrentSession(task.id)?.runtime).toBe("codex");
      expect(db.getTask(task.id)?.status).toBe("idle");
      expect(db.listTaskEvents({ taskId: task.id }).map((row) => row.event.kind)).toEqual(expect.arrayContaining([
        "task.handoff_started",
        "task.handoff_completed",
      ]));
    } finally {
      await orchestrator.close();
    }
  });

  it("handoff failure rolls back to the original active session", async () => {
    const claude = new MultiTurnRuntime("claude");
    const codex = new MultiTurnRuntime("codex");
    const { db, orchestrator, root } = await buildEnv({ claude, codex });
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "handoff fail" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sourceSession = db.getCurrentSession(task.id);
      codex.failNextTurn = true;

      await expect(orchestrator.handoffTask({
        taskId: task.id,
        targetProfileId: "codex_main",
        reason: "switch",
        prompt: "continue",
      })).rejects.toThrow("handoff_failed");

      expect(db.getTask(task.id)?.status).toBe("idle");
      expect(db.getCurrentSession(task.id)?.id).toBe(sourceSession?.id);
      expect(db.listRuntimeSessions(task.id).find((session) => session.handoffFromSessionId === sourceSession?.id)?.status).toBe("failed");
      expect(db.listTaskEvents({ taskId: task.id }).map((row) => row.event.kind)).toContain("task.handoff_failed");
    } finally {
      await orchestrator.close();
    }
  });

  it("deduplicates handoff requestId before creating another session", async () => {
    const claude = new MultiTurnRuntime("claude");
    const codex = new MultiTurnRuntime("codex");
    const { db, orchestrator, root } = await buildEnv({ claude, codex });
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "handoff idempotent" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });

      await orchestrator.handoffTask({ taskId: task.id, targetProfileId: "codex_main", reason: "switch", prompt: "continue", requestId: "handoff-1" });
      await orchestrator.handoffTask({ taskId: task.id, targetProfileId: "codex_main", reason: "switch again", prompt: "continue again", requestId: "handoff-1" });

      expect(db.listRuntimeSessions(task.id)).toHaveLength(2);
      expect(db.listTurns(task.id).filter((turn) => turn.requestId === "handoff-1")).toHaveLength(1);
    } finally {
      await orchestrator.close();
    }
  });

  it("rollover creates a new active session and closes the old one with rollover reason", async () => {
    const { db, orchestrator, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "rollover" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sourceSession = db.getCurrentSession(task.id);

      await orchestrator.rolloverSession({ taskId: task.id, reason: "manual", carryOverPrompt: "carry" });

      expect(db.listRuntimeSessions(task.id)).toHaveLength(2);
      expect(db.getRuntimeSession(sourceSession?.id ?? "")?.closeReason).toBe("rollover");
      expect(db.getCurrentSession(task.id)?.rolloverFromSessionId).toBe(sourceSession?.id);
      expect(db.listTaskEvents({ taskId: task.id }).map((row) => row.event.kind)).toEqual(expect.arrayContaining([
        "task.rollover_started",
        "task.rollover_completed",
      ]));
    } finally {
      await orchestrator.close();
    }
  });

  it("forks Claude natively and Codex logically", async () => {
    const claude = new MultiTurnRuntime("claude");
    const codex = new MultiTurnRuntime("codex");
    const { db, orchestrator, root } = await buildEnv({ claude, codex });
    try {
      const claudeTask = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "claude" });
      await orchestrator.sendTurn({ taskId: claudeTask.id, prompt: "seed" });
      const nativeFork = await orchestrator.forkTask({ taskId: claudeTask.id, mode: "task", name: "native child" });
      expect(nativeFork.forkKind).toBe("native");
      expect(nativeFork.childTaskId).toBeDefined();
      expect(claude.forks).toHaveLength(1);

      const codexTask = await orchestrator.createTask({ profileId: "codex_main", cwd: root, name: "codex" });
      await orchestrator.sendTurn({ taskId: codexTask.id, prompt: "seed" });
      const logicalFork = await orchestrator.forkTask({ taskId: codexTask.id, mode: "task", prompt: "branch" });
      expect(logicalFork.forkKind).toBe("logical");
      expect(db.getTask(logicalFork.childTaskId ?? "")?.status).toBe("idle");
    } finally {
      await orchestrator.close();
    }
  });

  it("fork mode session records a non-active branch without replacing current session", async () => {
    const { db, orchestrator, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "session fork" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sourceSession = db.getCurrentSession(task.id);

      const result = await orchestrator.forkTask({ taskId: task.id, mode: "session" });

      expect(result.childTaskId).toBeUndefined();
      expect(db.getCurrentSession(task.id)?.id).toBe(sourceSession?.id);
      const forkSession = db.getRuntimeSession(result.childSessionId);
      expect(forkSession?.status).toBe("closed");
      expect(forkSession?.closeReason).toBe("forked");
      expect(forkSession?.parentSessionId).toBe(sourceSession?.id);
    } finally {
      await orchestrator.close();
    }
  });

  it("fails fast when continuation context exceeds 2048 token estimate", async () => {
    const { orchestrator, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "oversized" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      await expect(orchestrator.rolloverSession({
        taskId: task.id,
        reason: "manual",
        carryOverPrompt: "x".repeat(9000),
      })).rejects.toMatchObject({ code: "continuation_context_too_large" });
    } finally {
      await orchestrator.close();
    }
  });
});

async function buildEnv(runtimes?: { claude?: MultiTurnRuntime; codex?: MultiTurnRuntime }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-multi-turn-"));
  tempPaths.push(root);
  const workspaceRoot = path.join(root, "workspaces");
  const dbPath = path.join(root, "auto-pm-lite.db");
  const configPath = path.join(root, "config.toml");
  await fs.writeFile(configPath, `
[storage]
dbPath = "${dbPath.replace(/\\/g, "/")}"
busyTimeoutMs = 1000
maxQueueSize = 100
flushBatchSize = 10

[workspace]
rootDir = "${workspaceRoot.replace(/\\/g, "/")}"
topLevelUseWorktree = false

[policy.main]
permissionMode = "edit"
sandboxMode = "workspace-write"
networkAllowed = false
approvalPolicy = "orchestrator"
requireApprovalFor = []
maxDepth = 3
allowCrossHarnessDelegation = true
allowChildEdit = true
allowChildNetwork = false

[account.anthropic]
vendor = "anthropic"
secretRef = "env:ANTHROPIC_API_KEY"

[account.openai]
vendor = "openai"
secretRef = "env:OPENAI_API_KEY"

[profile.claude_main]
runtime = "claude"
accountId = "anthropic"
policyId = "main"
model = "claude-test"
claudePermissionMode = "default"

[profile.codex_main]
runtime = "codex"
accountId = "openai"
policyId = "main"
model = "codex-test"
codexSandboxMode = "workspace-write"
codexApprovalPolicy = "on-request"
codexNetworkAccessEnabled = false
`, "utf8");
  const config = await loadConfig(configPath);
  const db = new AppDatabase({
    dbPath: config.storage.dbPath,
    busyTimeoutMs: config.storage.busyTimeoutMs,
  });
  const runtime = runtimes?.claude ?? new MultiTurnRuntime("claude");
  const orchestrator = new Orchestrator(config, db, {
    claude: runtime,
    codex: runtimes?.codex ?? new MultiTurnRuntime("codex"),
  });
  orchestrator.syncConfig();
  return { db, orchestrator, runtime, root };
}
