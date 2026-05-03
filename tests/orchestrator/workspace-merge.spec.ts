import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/storage/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AgentEvent, AppConfig } from "../../src/core/types.js";
import type { RuntimeAdapter, RuntimeTaskHandle, RunTurnInput, StartRuntimeTaskInput, ResumeRuntimeTaskInput } from "../../src/runtime/adapter.js";

const tempPaths: string[] = [];

class FakeRuntime implements RuntimeAdapter {
  constructor(readonly runtime: RuntimeAdapter["runtime"]) {}

  async startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle> {
    return { taskId: input.taskId, backendThreadId: `thread-${input.taskId}` };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const ts = new Date().toISOString();
    yield { type: "turn.started", taskId: input.taskId, turnId: "turn-1", ts };
    yield { type: "message.completed", taskId: input.taskId, turnId: "turn-1", text: input.prompt, ts };
    yield { type: "turn.completed", taskId: input.taskId, turnId: "turn-1", usage: { inputTokens: 1, outputTokens: 1 }, ts };
  }

  async resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle> {
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

describe("workspace merge lifecycle", () => {
  it("creates editable delegated child worktrees and merges approved patches", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });

      expect(delegated.status).toBe("completed");
      const childTask = db.getTask(delegated.childTaskId!);
      expect(childTask?.cwd).not.toBe(parent.cwd);
      expect(childTask?.cwd).toContain("workspaces");

      await fs.writeFile(path.join(childTask!.cwd, "feature.txt"), "feature\n", "utf8");
      const changes = orchestrator.listWorkspaceChanges(childTask!.id);
      expect(changes).toEqual([{ path: "feature.txt", changeKind: "create", binary: false }]);

      const diff = orchestrator.getWorkspaceDiff(childTask!.id);
      expect(diff.patch).toContain("feature");

      const mergeRequest = await orchestrator.requestWorkspaceMerge({
        taskId: childTask!.id,
        reason: "ready",
      });
      await orchestrator.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      const result = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask!.id,
        approvalId: mergeRequest.approvalId,
      });

      expect(result.status).toBe("merged");
      const mergedContent = await fs.readFile(path.join(parent.cwd, "feature.txt"), "utf8");
      expect(mergedContent.replace(/\r\n/g, "\n")).toBe("feature\n");
      expect(db.getWorkspace(childTask!.workspaceId)?.status).toBe("merged");
      expect(db.listEvents({ taskId: childTask!.id }).map((event) => event.type)).toEqual(expect.arrayContaining([
        "workspace.merge_requested",
        "workspace.merge_started",
        "workspace.merged",
      ]));
      const migrations = db.db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
      expect(migrations.map((row) => row.id)).toEqual(["001_initial", "002_workspace_lifecycle"]);
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects editable shared workspace delegation", async () => {
    const env = await buildEnv();
    const { orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "fix",
        prompt: "fix",
        reason: "needs edits",
        workspaceMode: "share",
        requestedPermissionMode: "edit",
      });

      expect(delegated.status).toBe("denied");
      expect(delegated.message).toBe("child_workspace_isolation_required");
      expect(delegated.denialCode).toBe("child_workspace_isolation_required");
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects editable delegation when parent policy disallows child edits", async () => {
    const env = await buildEnv({ allowChildEdit: false });
    const { orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const denied = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "policy gate",
      });

      expect(denied.status).toBe("denied");
      expect(denied.denialCode).toBe("child_edit_not_allowed");
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects editable delegation before child creation when parent workspace is dirty", async () => {
    const env = await buildEnv();
    const { orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      await fs.writeFile(path.join(parent.cwd, "dirty-before-child.txt"), "dirty\n", "utf8");
      const denied = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "dirty parent",
      });

      expect(denied.status).toBe("denied");
      expect(denied.denialCode).toBe("workspace_not_isolatable:parent_dirty");
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects merge request when parent workspace is dirty", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      await fs.writeFile(path.join(childTask.cwd, "feature.txt"), "feature\n", "utf8");
      await fs.writeFile(path.join(parent.cwd, "dirty-before-request.txt"), "dirty\n", "utf8");

      await expect(orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "ready" })).rejects.toThrow("parent_workspace_dirty");
      expect(db.getWorkspace(childTask.workspaceId)?.status).toBe("active");
    } finally {
      await orchestrator.close();
    }
  });

  it("records merge_failed when parent workspace is dirty and allows discard", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      await fs.writeFile(path.join(childTask.cwd, "feature.txt"), "feature\n", "utf8");
      const mergeRequest = await orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "ready" });
      await orchestrator.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      await fs.writeFile(path.join(parent.cwd, "dirty.txt"), "dirty\n", "utf8");

      const result = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask.id,
        approvalId: mergeRequest.approvalId,
      });
      expect(result.status).toBe("merge_failed");
      expect(result.error?.code).toBe("parent_dirty");
      expect(result.error?.changes).toEqual([{ path: "feature.txt", changeKind: "create", binary: false }]);

      const discarded = await orchestrator.discardWorkspace(childTask.id);
      expect(discarded.status).toBe("discarded");
      expect(fss.existsSync(childTask.cwd)).toBe(false);
    } finally {
      await orchestrator.close();
    }
  });

  it("summarizes rename delete and binary workspace changes", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      await fs.writeFile(path.join(repoRoot, "delete-me.txt"), "delete\n", "utf8");
      await fs.writeFile(path.join(repoRoot, "rename-me.txt"), "rename\n", "utf8");
      execFileSync("git", ["-C", repoRoot, "add", "delete-me.txt", "rename-me.txt"], { stdio: "ignore" });
      execFileSync("git", ["-C", repoRoot, "commit", "-m", "fixtures"], { stdio: "ignore" });

      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      await fs.rm(path.join(childTask.cwd, "delete-me.txt"));
      await fs.rename(path.join(childTask.cwd, "rename-me.txt"), path.join(childTask.cwd, "renamed.txt"));
      await fs.writeFile(path.join(childTask.cwd, "image.bin"), Buffer.from([0, 1, 2, 3]));

      const changes = orchestrator.listWorkspaceChanges(childTask.id);
      expect(changes).toEqual(expect.arrayContaining([
        { path: "delete-me.txt", changeKind: "delete", binary: false },
        { path: "renamed.txt", oldPath: "rename-me.txt", changeKind: "rename", binary: false },
        { path: "image.bin", changeKind: "create", binary: true },
      ]));
    } finally {
      await orchestrator.close();
    }
  });

  it("applies binary patches that git diff --binary can express", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "binary",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      await fs.writeFile(path.join(childTask.cwd, "image.bin"), Buffer.from([0, 1, 2, 3]));
      const mergeRequest = await orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "ready" });
      await orchestrator.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      const result = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask.id,
        approvalId: mergeRequest.approvalId,
      });

      expect(result.status).toBe("merged");
      expect(Buffer.from(await fs.readFile(path.join(parent.cwd, "image.bin")))).toEqual(Buffer.from([0, 1, 2, 3]));
    } finally {
      await orchestrator.close();
    }
  });

  it("records merge_failed when binary patch apply conflicts", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      await fs.writeFile(path.join(repoRoot, "image.bin"), Buffer.from([0, 1, 2, 3]));
      execFileSync("git", ["-C", repoRoot, "add", "image.bin"], { stdio: "ignore" });
      execFileSync("git", ["-C", repoRoot, "commit", "-m", "binary fixture"], { stdio: "ignore" });

      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "binary conflict",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      await fs.writeFile(path.join(childTask.cwd, "image.bin"), Buffer.from([9, 9, 9, 9]));

      await fs.writeFile(path.join(parent.cwd, "image.bin"), Buffer.from([8, 8, 8, 8]));
      execFileSync("git", ["-C", parent.cwd, "add", "image.bin"], { stdio: "ignore" });
      execFileSync("git", ["-C", parent.cwd, "commit", "-m", "parent binary conflict"], { stdio: "ignore" });

      const mergeRequest = await orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "ready" });
      await orchestrator.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      const failed = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask.id,
        approvalId: mergeRequest.approvalId,
      });

      expect(failed.status).toBe("merge_failed");
      expect(failed.error?.code).toBe("merge_conflict");
      expect(failed.error?.changes).toEqual([{ path: "image.bin", changeKind: "modify", binary: true }]);
      expect(db.getWorkspace(childTask.workspaceId)?.status).toBe("merge_failed");
    } finally {
      await orchestrator.close();
    }
  });

  it("uses shared workspaces by default for ask and review delegations", async () => {
    const env = await buildEnv({ includeReadonlyCodex: true });
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });

      for (const taskType of ["ask", "review"] as const) {
        const delegated = await orchestrator.delegateTask({
          parentTaskId: parent.id,
          targetProfileId: "codex_readonly",
          taskType,
          prompt: taskType,
          reason: "default workspace",
        });
        expect(delegated.status).toBe("completed");
        const childTask = db.getTask(delegated.childTaskId!)!;
        const childWorkspace = db.getWorkspace(childTask.workspaceId)!;
        expect(childWorkspace.path).toBe(parent.cwd);
        expect(childWorkspace.parentWorkspaceId).toBe(parent.workspaceId);
      }
    } finally {
      await orchestrator.close();
    }
  });

  it("uses isolated child worktrees by default for test delegations", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "test",
        prompt: "test",
        reason: "default isolated workspace",
      });

      expect(delegated.status).toBe("completed");
      const childTask = db.getTask(delegated.childTaskId!)!;
      const childWorkspace = db.getWorkspace(childTask.workspaceId)!;
      expect(childWorkspace.path).not.toBe(parent.cwd);
      expect(childWorkspace.path).toContain("workspaces");
      expect(childWorkspace.parentWorkspaceId).toBe(parent.workspaceId);
    } finally {
      await orchestrator.close();
    }
  });

  it("marks parentAdvanced when parent head moved after child creation", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      await fs.writeFile(path.join(childTask.cwd, "child.txt"), "child\n", "utf8");
      await fs.writeFile(path.join(parent.cwd, "parent.txt"), "parent\n", "utf8");
      execFileSync("git", ["-C", parent.cwd, "add", "parent.txt"], { stdio: "ignore" });
      execFileSync("git", ["-C", parent.cwd, "commit", "-m", "parent advanced"], { stdio: "ignore" });

      const mergeRequest = await orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "ready" });
      await orchestrator.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      const result = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask.id,
        approvalId: mergeRequest.approvalId,
      });

      expect(result.status).toBe("merged");
      expect(result.parentAdvanced).toBe(true);
      expect((await fs.readFile(path.join(parent.cwd, "child.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("child\n");
    } finally {
      await orchestrator.close();
    }
  });

  it("records merge conflict and can retry after parent conflict is cleared", async () => {
    const env = await buildEnv();
    const { db, orchestrator, repoRoot } = env;

    try {
      const parent = await orchestrator.createTask({ profileId: "claude_parent", cwd: repoRoot });
      const delegated = await orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      const childTask = db.getTask(delegated.childTaskId!)!;
      const childWorkspace = db.getWorkspace(childTask.workspaceId)!;
      await fs.writeFile(path.join(childTask.cwd, "README.md"), "child\n", "utf8");
      await fs.writeFile(path.join(parent.cwd, "README.md"), "parent\n", "utf8");
      execFileSync("git", ["-C", parent.cwd, "add", "README.md"], { stdio: "ignore" });
      execFileSync("git", ["-C", parent.cwd, "commit", "-m", "conflicting parent"], { stdio: "ignore" });

      const mergeRequest = await orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "ready" });
      await orchestrator.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
      const failed = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask.id,
        approvalId: mergeRequest.approvalId,
      });
      expect(failed.status).toBe("merge_failed");
      expect(failed.error?.code).toBe("merge_conflict");

      execFileSync("git", ["-C", parent.cwd, "reset", "--hard", childWorkspace.baseRef!], { stdio: "ignore" });
      const retryRequest = await orchestrator.requestWorkspaceMerge({ taskId: childTask.id, reason: "retry" });
      await orchestrator.resolveApproval({ approvalId: retryRequest.approvalId, approved: true });
      const retried = await orchestrator.applyApprovedWorkspaceMerge({
        taskId: childTask.id,
        approvalId: retryRequest.approvalId,
      });
      expect(retried.status).toBe("merged");
      expect((await fs.readFile(path.join(parent.cwd, "README.md"), "utf8")).replace(/\r\n/g, "\n")).toBe("child\n");
    } finally {
      await orchestrator.close();
    }
  });

  it("denies editable delegation for non-git and unsafe direct parent workspaces", async () => {
    const nonGit = await buildEnv({ initializeGit: false, topLevelUseWorktree: false });
    try {
      const parent = await nonGit.orchestrator.createTask({ profileId: "claude_parent", cwd: nonGit.repoRoot });
      const denied = await nonGit.orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      expect(denied.status).toBe("denied");
      expect(denied.message).toBe("workspace_not_isolatable:not_git");
      expect(denied.denialCode).toBe("workspace_not_isolatable:not_git");
    } finally {
      await nonGit.orchestrator.close();
    }

    const unsafe = await buildEnv({ topLevelUseWorktree: false, unsafeDirectCwd: true });
    try {
      const parent = await unsafe.orchestrator.createTask({ profileId: "claude_parent", cwd: unsafe.repoRoot });
      const denied = await unsafe.orchestrator.delegateTask({
        parentTaskId: parent.id,
        targetRuntime: "codex",
        taskType: "edit",
        prompt: "edit",
        reason: "implement",
      });
      expect(denied.status).toBe("denied");
      expect(denied.message).toBe("workspace_not_isolatable:unsafe_direct_cwd");
      expect(denied.denialCode).toBe("workspace_not_isolatable:unsafe_direct_cwd");
    } finally {
      await unsafe.orchestrator.close();
    }
  });
});

async function buildEnv(options?: { initializeGit?: boolean; topLevelUseWorktree?: boolean; unsafeDirectCwd?: boolean; allowChildEdit?: boolean; includeReadonlyCodex?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-merge-"));
  tempPaths.push(root);
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  if (options?.initializeGit !== false) {
    execFileSync("git", ["init", repoRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "init"], { stdio: "ignore" });
  }

  const config: AppConfig = {
    accounts: {
      anthropic: { id: "anthropic", vendor: "anthropic", secretRef: "env:ANTHROPIC_API_KEY" },
      openai: { id: "openai", vendor: "openai", secretRef: "env:OPENAI_API_KEY" },
    },
    policies: {
      parent_edit: {
        id: "parent_edit",
        permissionMode: "read-only",
        sandboxMode: "read-only",
        networkAllowed: false,
        approvalPolicy: "orchestrator",
        requireApprovalFor: [],
        maxDepth: 2,
        allowCrossHarnessDelegation: true,
        allowChildEdit: options?.allowChildEdit ?? true,
        allowChildNetwork: false,
        ...(options?.unsafeDirectCwd ? { unsafeDirectCwd: true } : {}),
      },
      child_edit: {
        id: "child_edit",
        permissionMode: "edit",
        sandboxMode: "workspace-write",
        networkAllowed: false,
        approvalPolicy: "orchestrator",
        requireApprovalFor: [],
        maxDepth: 2,
        allowCrossHarnessDelegation: false,
        allowChildEdit: false,
        allowChildNetwork: false,
      },
      ...(options?.includeReadonlyCodex
        ? {
            codex_readonly: {
              id: "codex_readonly",
              permissionMode: "read-only" as const,
              sandboxMode: "read-only" as const,
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
      claude_parent: {
        id: "claude_parent",
        runtime: "claude",
        accountId: "anthropic",
        policyId: "parent_edit",
        model: "claude-opus-4-7",
        claudePermissionMode: "dontAsk",
      },
      codex_child: {
        id: "codex_child",
        runtime: "codex",
        accountId: "openai",
        policyId: "child_edit",
        model: "gpt-5-codex",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        codexNetworkAccessEnabled: false,
      },
      ...(options?.includeReadonlyCodex
        ? {
            codex_readonly: {
              id: "codex_readonly",
              runtime: "codex" as const,
              accountId: "openai",
              policyId: "codex_readonly",
              model: "gpt-5-codex",
              codexSandboxMode: "read-only" as const,
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
      rootDir: path.join(root, "workspaces"),
      topLevelUseWorktree: options?.topLevelUseWorktree ?? true,
    },
    scheduler: {
      maxConcurrentTasksGlobal: 5,
      maxConcurrentTasksPerAccount: 2,
    },
    rateLimit: { enabled: false },
  };
  const db = new AppDatabase({ dbPath: config.storage.dbPath, busyTimeoutMs: config.storage.busyTimeoutMs });
  const orchestrator = new Orchestrator(config, db, {
    claude: new FakeRuntime("claude"),
    codex: new FakeRuntime("codex"),
  });
  orchestrator.syncConfig();
  return { db, orchestrator, repoRoot };
}
