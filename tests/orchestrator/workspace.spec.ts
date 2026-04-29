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

describe("WorkspaceManager", () => {
  it("allocates a top-level worktree for git repositories by default", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pm-lite-ws-"));
    tempPaths.push(root);

    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    fs.writeFileSync(path.join(root, "README.md"), "hello\n", "utf8");
    execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-m", "init"], { stdio: "ignore" });

    const workspaceRoot = path.join(root, ".worktrees");
    const manager = new WorkspaceManager({
      rootDir: workspaceRoot,
      topLevelUseWorktree: true,
    });

    const workspace = manager.createTopLevelWorkspace({
      taskId: "task-1",
      cwd: root,
    });

    expect(workspace.path).toBe(path.join(workspaceRoot, "task-1"));
    expect(path.normalize(workspace.repoRoot ?? "")).toBe(path.normalize(root));
    expect(workspace.unsafeDirectCwd).toBe(false);
    expect(fs.existsSync(path.join(workspace.path, ".git"))).toBe(true);
  });

  it("marks direct cwd mode as unsafe when worktrees are disabled", () => {
    const manager = new WorkspaceManager({
      rootDir: "D:/tmp/auto-pm-workspaces",
      topLevelUseWorktree: false,
    });

    const workspace = manager.createTopLevelWorkspace({
      taskId: "task-2",
      cwd: "D:/Code/Auto-PM-Lite",
    });

    expect(path.normalize(workspace.path)).toBe(path.normalize("D:/Code/Auto-PM-Lite"));
    expect(workspace.unsafeDirectCwd).toBe(true);
  });
});
