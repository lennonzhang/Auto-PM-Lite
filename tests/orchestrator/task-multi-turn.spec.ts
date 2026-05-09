import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { AppDatabase } from "../../src/storage/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { ForkRuntimeSessionInput, ForkRuntimeSessionResult, RunTurnInput, RuntimeAdapter, RuntimeAdapterOutput, RuntimeSessionControlInput, RuntimeTaskHandle, OpenRuntimeSessionInput } from "../../src/runtime/adapter.js";
import { fileChanged, messageCompleted, turnCompleted, turnStarted } from "../helpers/v2-runtime.js";

const tempPaths: string[] = [];

class MultiTurnRuntime implements RuntimeAdapter {
  readonly runtime: RuntimeAdapter["runtime"];
  readonly opens: OpenRuntimeSessionInput[] = [];
  readonly turns: RunTurnInput[] = [];
  readonly closes: string[] = [];
  readonly cancels: string[] = [];
  readonly forks: ForkRuntimeSessionInput[] = [];
  readonly liveSessions = new Map<string, string>();
  nativeCreateCount = 0;
  nativeResumeCount = 0;
  shutdownCount = 0;
  delayMs = 0;
  failNextTurn = false;
  fileChanges: Array<{ path: string; changeKind: "create" | "modify" | "delete"; binary: boolean }> = [];

  constructor(runtime: RuntimeAdapter["runtime"] = "claude") {
    this.runtime = runtime;
  }

  async openSession(input: OpenRuntimeSessionInput): Promise<RuntimeTaskHandle> {
    this.opens.push(input);
    const existing = this.liveSessions.get(input.sessionId);
    if (existing) {
      return { taskId: input.taskId, sessionId: input.sessionId, backendThreadId: existing };
    }
    const backendThreadId = input.backendThreadId ?? `${this.runtime}-thread-${input.sessionId}`;
    if (input.backendThreadId) {
      this.nativeResumeCount += 1;
    } else {
      this.nativeCreateCount += 1;
    }
    this.liveSessions.set(input.sessionId, backendThreadId);
    return { taskId: input.taskId, sessionId: input.sessionId, backendThreadId };
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
    for (const change of this.fileChanges) {
      yield fileChanged(input, change, ts);
    }
    yield turnCompleted(input, { inputTokens: 1, outputTokens: 1 }, ts);
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<ForkRuntimeSessionResult> {
    this.forks.push(input);
    return { backendThreadId: `forked-${input.targetSessionId}`, forkKind: "native" };
  }

  async interruptTurn(input: RuntimeSessionControlInput): Promise<void> {
    this.cancels.push(input.sessionId);
  }

  async terminateSession(input: RuntimeSessionControlInput): Promise<void> {
    this.closes.push(input.sessionId);
    this.liveSessions.delete(input.sessionId);
  }

  hasLiveSession(sessionId: string): boolean {
    return this.liveSessions.has(sessionId);
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    this.liveSessions.clear();
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
      expect(runtime.opens).toHaveLength(5);
      expect(runtime.nativeCreateCount).toBe(1);
      expect(runtime.nativeResumeCount).toBe(0);
      expect(runtime.hasLiveSession(sessions[0]!.id)).toBe(true);
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
      expect(runtime.hasLiveSession(sessionId ?? "")).toBe(false);
      expect(db.listTaskEvents({ taskId: task.id }).map((row) => row.event.kind)).toEqual(expect.arrayContaining([
        "task.cancellation_requested",
        "task.cancelled",
      ]));
    } finally {
      await orchestrator.close();
    }
  });

  it("only turns closed through explicit closeTask", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sessionId = db.getCurrentSession(task.id)?.id;
      expect(db.getTask(task.id)?.status).toBe("idle");

      await orchestrator.closeTask(task.id, "done");
      expect(db.getTask(task.id)?.status).toBe("closed");
      expect(runtime.closes).toContain(sessionId);
      expect(runtime.hasLiveSession(sessionId ?? "")).toBe(false);
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
      expect(claude.hasLiveSession(sourceSession?.id ?? "")).toBe(false);
      expect(codex.hasLiveSession(db.getCurrentSession(task.id)?.id ?? "")).toBe(true);
      const detail = orchestrator.getTask(task.id);
      const summary = orchestrator.listTasks().find((entry) => entry.id === task.id);
      expect(detail?.defaultRuntime).toBe("claude");
      expect(summary?.currentSession?.runtime).toBe("codex");
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
    const { db, orchestrator, runtime, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "rollover" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sourceSession = db.getCurrentSession(task.id);

      await orchestrator.rolloverSession({ taskId: task.id, reason: "manual", carryOverPrompt: "carry" });

      expect(db.listRuntimeSessions(task.id)).toHaveLength(2);
      expect(db.getRuntimeSession(sourceSession?.id ?? "")?.closeReason).toBe("rollover");
      expect(runtime.hasLiveSession(sourceSession?.id ?? "")).toBe(false);
      expect(runtime.hasLiveSession(db.getCurrentSession(task.id)?.id ?? "")).toBe(true);
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

  it("passes Claude assistant message UUID when forking from a specific turn", async () => {
    const claude = new MultiTurnRuntime("claude");
    const { db, orchestrator, root } = await buildEnv({ claude });
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "mapped fork" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const turn = db.getLatestTurn(task.id);
      expect(turn).toBeDefined();
      db.upsertTurnAssistantMessage({
        turnId: turn!.id,
        assistantMessageId: "assistant-uuid-1",
        createdAt: new Date().toISOString(),
      });

      await orchestrator.forkTask({ taskId: task.id, fromTurnId: turn!.id });

      expect(claude.forks[0]?.upToMessageId).toBe("assistant-uuid-1");
    } finally {
      await orchestrator.close();
    }
  });

  it("recovers stale cancelling tasks to interrupted and closes active sessions", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "recover cancel" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const sessionId = db.getCurrentSession(task.id)?.id;
      db.updateTaskRuntimeState({
        taskId: task.id,
        status: "cancelling",
        updatedAt: new Date().toISOString(),
      });

      const recovered = await orchestrator.recoverStaleRunningTasks();

      expect(recovered.recoveredTaskIds).toEqual([task.id]);
      expect(db.getTask(task.id)?.status).toBe("interrupted");
      expect(db.getRuntimeSession(sessionId ?? "")?.closeReason).toBe("cancelled");
      expect(runtime.closes).toContain(sessionId);
    } finally {
      await orchestrator.close();
    }
  });

  it("fork mode session records a non-active branch without replacing current session", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
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
      expect(runtime.hasLiveSession(result.childSessionId)).toBe(false);
    } finally {
      await orchestrator.close();
    }
  });

  it("rebuilds a live runtime handle from backendThreadId after adapter memory is lost", async () => {
    const runtime = new MultiTurnRuntime("claude");
    const { db, orchestrator, root } = await buildEnv({ claude: runtime });
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "resume live" });
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const session = db.getCurrentSession(task.id);
      expect(session?.backendThreadId).toBeDefined();
      runtime.liveSessions.clear();

      await orchestrator.sendTurn({ taskId: task.id, prompt: "after restart" });

      expect(runtime.nativeCreateCount).toBe(1);
      expect(runtime.nativeResumeCount).toBe(1);
      expect(runtime.opens.at(-1)?.backendThreadId).toBe(session?.backendThreadId);
      expect(runtime.hasLiveSession(session?.id ?? "")).toBe(true);
    } finally {
      await orchestrator.close();
    }
  });

  it("orchestrator close releases live handles without closing DB sessions", async () => {
    const { db, orchestrator, runtime, root } = await buildEnv();
    const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "shutdown" });
    await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
    const sessionId = db.getCurrentSession(task.id)?.id;
    const dbStatusBeforeShutdown = db.getRuntimeSession(sessionId ?? "")?.status;

    await orchestrator.close();

    expect(runtime.shutdownCount).toBe(1);
    expect(runtime.hasLiveSession(sessionId ?? "")).toBe(false);
    expect(dbStatusBeforeShutdown).toBe("active");
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

  it("builds deterministic continuation context fields and orders modified files by recency", async () => {
    const claude = new MultiTurnRuntime("claude");
    const codex = new MultiTurnRuntime("codex");
    const { db, orchestrator, root } = await buildEnv({ claude, codex });
    try {
      const task = await orchestrator.createTask({ profileId: "claude_main", cwd: root, name: "context" });
      claude.fileChanges = [
        { path: "older-long-name.txt", changeKind: "modify", binary: false },
      ];
      await orchestrator.sendTurn({ taskId: task.id, prompt: "seed" });
      const olderTs = new Date(Date.now() - 60_000).toISOString();
      db.insertFileChange({
        taskId: task.id,
        workspaceId: task.workspaceId,
        path: "older-long-name.txt",
        changeKind: "modify",
        ts: olderTs,
      });
      db.insertFileChange({
        taskId: task.id,
        workspaceId: task.workspaceId,
        path: "new.ts",
        changeKind: "modify",
        ts: new Date().toISOString(),
      });

      await orchestrator.handoffTask({ taskId: task.id, targetProfileId: "codex_main", reason: "switch", prompt: "continue" });

      const prompt = codex.turns[0]?.prompt ?? "";
      expect(prompt).toContain("<pending/>");
      expect(prompt).not.toContain("<item>continue</item>");
      expect(prompt.match(/<user_prompt>/g)).toHaveLength(1);
      expect(prompt).toContain("continue");
      expect(prompt.indexOf("modify:new.ts")).toBeLessThan(prompt.indexOf("modify:older-long-name.txt"));
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
