import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../../src/orchestrator/workspace.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const target of tempPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("WorkspaceManager resolveWorkspacePlan", () => {
  it("returns top-level-worktree for repo roots by default", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pm-lite-ws-plan-"));
    tempPaths.push(root);

    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    fs.writeFileSync(path.join(root, "README.md"), "hello\n", "utf8");
    execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-m", "init"], { stdio: "ignore" });

    const manager = new WorkspaceManager({
      rootDir: path.join(root, ".worktrees"),
      topLevelUseWorktree: true,
    });

    const plan = manager.resolveWorkspacePlan({
      taskKind: "top-level",
      cwd: root,
    });

    expect(plan.kind).toBe("top-level-worktree");
    expect(path.normalize(plan.repoRoot ?? "")).toBe(path.normalize(root));
    expect(path.normalize(plan.basePath)).toBe(path.normalize(root));
    expect(plan.unsafeDirectCwd).toBe(false);
  });

  it("returns direct-cwd for non-repo paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pm-lite-ws-plan-nonrepo-"));
    tempPaths.push(root);

    const manager = new WorkspaceManager({
      rootDir: path.join(root, ".worktrees"),
      topLevelUseWorktree: true,
    });

    const plan = manager.resolveWorkspacePlan({
      taskKind: "top-level",
      cwd: root,
    });

    expect(plan.kind).toBe("direct-cwd");
    expect(plan.repoRoot).toBeUndefined();
    expect(path.normalize(plan.basePath)).toBe(path.normalize(root));
    expect(plan.unsafeDirectCwd).toBe(false);
  });

  it("returns shared-child for child share mode", () => {
    const manager = new WorkspaceManager({
      rootDir: "D:/tmp/auto-pm-workspaces",
      topLevelUseWorktree: true,
    });

    const plan = manager.resolveWorkspacePlan({
      taskKind: "child",
      cwd: "D:/Code/Auto-PM-Lite",
      requestedWorkspaceMode: "share",
      parentWorkspace: {
        id: "ws_parent",
        path: "D:/Code/Auto-PM-Lite/.worktrees/parent",
        repoRoot: "D:/Code/Auto-PM-Lite",
        branch: "main",
        head: "abc123",
        dirty: false,
        baseRef: "abc123",
        status: "active",
        unsafeDirectCwd: false,
        createdAt: new Date().toISOString(),
      },
    });

    expect(plan.kind).toBe("shared-child");
    expect(path.normalize(plan.basePath)).toBe(path.normalize("D:/Code/Auto-PM-Lite/.worktrees/parent"));
    expect(path.normalize(plan.repoRoot ?? "")).toBe(path.normalize("D:/Code/Auto-PM-Lite"));
    expect(plan.unsafeDirectCwd).toBe(false);
  });

  it("returns child-worktree plan for new-worktree requests", () => {
    const manager = new WorkspaceManager({
      rootDir: "D:/tmp/auto-pm-workspaces",
      topLevelUseWorktree: true,
    });

    const plan = manager.resolveWorkspacePlan({
      taskKind: "child",
      cwd: "D:/Code/Auto-PM-Lite",
      requestedWorkspaceMode: "new-worktree",
      parentWorkspace: {
        id: "ws_parent",
        path: "D:/Code/Auto-PM-Lite/.worktrees/parent",
        repoRoot: "D:/Code/Auto-PM-Lite",
        branch: "main",
        head: "abc123",
        dirty: false,
        baseRef: "abc123",
        status: "active",
        unsafeDirectCwd: false,
        createdAt: new Date().toISOString(),
      },
    });

    expect(plan.kind).toBe("child-worktree");
    expect(path.normalize(plan.basePath)).toBe(path.normalize("D:/Code/Auto-PM-Lite/.worktrees/parent"));
    expect(path.normalize(plan.repoRoot ?? "")).toBe(path.normalize("D:/Code/Auto-PM-Lite"));
    expect(plan.unsafeDirectCwd).toBe(false);
  });

  it("rejects child-worktree execution in the current phase", () => {
    const manager = new WorkspaceManager({
      rootDir: "D:/tmp/auto-pm-workspaces",
      topLevelUseWorktree: true,
    });

    expect(() => manager.createChildWorkspace({
      taskId: "task-child",
      cwd: "D:/Code/Auto-PM-Lite",
      parentWorkspace: {
        id: "ws_parent",
        path: "D:/Code/Auto-PM-Lite/.worktrees/parent",
        repoRoot: "D:/Code/Auto-PM-Lite",
        branch: "main",
        head: "abc123",
        dirty: false,
        baseRef: "abc123",
        status: "active",
        unsafeDirectCwd: false,
        createdAt: new Date().toISOString(),
      },
      plan: {
        kind: "child-worktree",
        repoRoot: "D:/Code/Auto-PM-Lite",
        basePath: "D:/Code/Auto-PM-Lite/.worktrees/parent",
        unsafeDirectCwd: false,
      },
    })).toThrowError("child_workspace_isolation_not_supported");
  });
});
