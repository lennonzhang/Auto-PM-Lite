import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AppConfig, Workspace, WorkspaceChange } from "../core/types.js";

export type WorkspacePlanKind = "direct-cwd" | "top-level-worktree" | "shared-child" | "child-worktree";

export interface WorkspacePlan {
  kind: WorkspacePlanKind;
  repoRoot?: string | undefined;
  basePath: string;
  unsafeDirectCwd: boolean;
}

export interface ResolveWorkspacePlanInput {
  taskKind: "top-level" | "child";
  cwd: string;
  parentWorkspace?: Workspace | undefined;
  requestedWorkspaceMode?: "share" | "new-worktree" | undefined;
  policyUnsafeDirectCwd?: boolean | undefined;
}

export interface CreateTopLevelWorkspaceInput {
  taskId: string;
  cwd: string;
  plan?: WorkspacePlan | undefined;
  createdAt?: string | undefined;
}

export interface CreateChildWorkspaceInput {
  taskId: string;
  cwd: string;
  parentWorkspace: Workspace;
  plan: WorkspacePlan;
  createdAt?: string | undefined;
}

export interface WorkspaceInspection {
  head?: string | undefined;
  dirty?: boolean | undefined;
}

export interface ApplyPatchResult {
  parentAdvanced: boolean;
  parentHead?: string | undefined;
  childHead?: string | undefined;
}

export class WorkspaceManager {
  constructor(private readonly config: AppConfig["workspace"]) {}

  resolveWorkspacePlan(input: ResolveWorkspacePlanInput): WorkspacePlan {
    if (input.taskKind === "top-level") {
      const repoRoot = findRepoRoot(input.cwd);
      const useWorktree = Boolean(repoRoot) && this.config.topLevelUseWorktree && !input.policyUnsafeDirectCwd;
      if (repoRoot && useWorktree) {
        return {
          kind: "top-level-worktree",
          repoRoot,
          basePath: input.cwd,
          unsafeDirectCwd: false,
        };
      }
      return {
        kind: "direct-cwd",
        repoRoot: repoRoot ?? undefined,
        basePath: input.cwd,
        unsafeDirectCwd: Boolean(repoRoot),
      };
    }

    if (input.requestedWorkspaceMode === "new-worktree") {
      return {
        kind: "child-worktree",
        repoRoot: input.parentWorkspace?.repoRoot,
        basePath: input.parentWorkspace?.path ?? input.cwd,
        unsafeDirectCwd: false,
      };
    }

    return {
      kind: "shared-child",
      repoRoot: input.parentWorkspace?.repoRoot,
      basePath: input.parentWorkspace?.path ?? input.cwd,
      unsafeDirectCwd: false,
    };
  }

  createTopLevelWorkspace(input: CreateTopLevelWorkspaceInput): Workspace {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const plan = input.plan ?? this.resolveWorkspacePlan({
      taskKind: "top-level",
      cwd: input.cwd,
    });
    switch (plan.kind) {
      case "top-level-worktree": {
        const repoRoot = plan.repoRoot;
        if (!repoRoot) {
          throw new Error("workspace_plan_missing_repo_root");
        }
        const workspacePath = path.join(this.config.rootDir, input.taskId);
        fs.mkdirSync(this.config.rootDir, { recursive: true });
        if (!fs.existsSync(workspacePath)) {
          execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", workspacePath, "HEAD"], {
            stdio: "ignore",
          });
        }
        return {
          id: `ws_${input.taskId}`,
          path: workspacePath,
          repoRoot,
          branch: readGitBranch(repoRoot),
          head: readGitHead(repoRoot),
          dirty: isGitDirty(repoRoot),
          baseRef: readGitHead(repoRoot),
          status: "active",
          unsafeDirectCwd: false,
          createdAt,
        };
      }
      case "direct-cwd":
        return {
          id: `ws_${input.taskId}`,
          path: input.cwd,
          repoRoot: plan.repoRoot,
          branch: plan.repoRoot ? readGitBranch(plan.repoRoot) : undefined,
          head: plan.repoRoot ? readGitHead(plan.repoRoot) : undefined,
          dirty: plan.repoRoot ? isGitDirty(plan.repoRoot) : undefined,
          baseRef: plan.repoRoot ? readGitHead(plan.repoRoot) : undefined,
          status: "active",
          unsafeDirectCwd: plan.unsafeDirectCwd,
          createdAt,
        };
      default:
        throw new Error(`invalid_top_level_workspace_plan:${plan.kind}`);
    }
  }

  createChildWorkspace(input: CreateChildWorkspaceInput): Workspace {
    const createdAt = input.createdAt ?? new Date().toISOString();
    switch (input.plan.kind) {
      case "shared-child":
        return {
          id: `ws_${input.taskId}`,
          path: input.parentWorkspace.path,
          repoRoot: input.parentWorkspace.repoRoot,
          branch: input.parentWorkspace.branch,
          head: input.parentWorkspace.head,
          dirty: input.parentWorkspace.dirty,
          baseRef: input.parentWorkspace.baseRef,
          parentWorkspaceId: input.parentWorkspace.id,
          status: "active",
          unsafeDirectCwd: input.parentWorkspace.unsafeDirectCwd,
          createdAt,
        };
      case "child-worktree":
        return this.createChildWorktree(input);
      default:
        throw new Error(`invalid_child_workspace_plan:${input.plan.kind}`);
    }
  }

  inspectWorkspace(workspace: Workspace): WorkspaceInspection {
    if (!workspace.repoRoot) {
      return {};
    }
    return {
      head: readGitHead(workspace.path),
      dirty: isGitDirty(workspace.path),
    };
  }

  listChanges(workspace: Workspace): WorkspaceChange[] {
    if (!workspace.baseRef) {
      throw new Error("workspace_missing_base_ref");
    }
    const baseRef = workspace.baseRef;
    return withTemporaryIndex(workspace.path, () => {
      execGit(workspace.path, ["add", "-A"]);
      const output = execGit(workspace.path, ["diff", "--cached", "--name-status", "--find-renames", baseRef]);
      const binaryPaths = findBinaryChangedPaths(workspace, baseRef);
      return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseNameStatusLine(line, binaryPaths));
    });
  }

  getDiffPatch(workspace: Workspace): string {
    if (!workspace.baseRef) {
      throw new Error("workspace_missing_base_ref");
    }
    const baseRef = workspace.baseRef;
    return withTemporaryIndex(workspace.path, () => {
      execGit(workspace.path, ["add", "-A"]);
      return execGitRaw(workspace.path, ["diff", "--cached", "--binary", baseRef]);
    });
  }

  applyPatchToParent(input: { parentWorkspace: Workspace; childWorkspace: Workspace; patch: string }): ApplyPatchResult {
    if (!input.childWorkspace.baseRef) {
      throw new Error("workspace_missing_base_ref");
    }
    if (isGitDirty(input.parentWorkspace.path)) {
      throw new Error("parent_workspace_dirty");
    }
    const parentHead = readGitHead(input.parentWorkspace.path);
    const childHead = readGitHead(input.childWorkspace.path);
    execGit(input.parentWorkspace.path, ["apply", "--3way", "--index", "-"], input.patch);
    execGit(input.parentWorkspace.path, ["reset"]);
    return {
      parentAdvanced: Boolean(parentHead && parentHead !== input.childWorkspace.baseRef),
      parentHead,
      childHead,
    };
  }

  discardWorkspace(workspace: Workspace): void {
    if (!workspace.parentWorkspaceId) {
      throw new Error("cannot_discard_top_level_workspace");
    }
    if (fs.existsSync(workspace.path)) {
      try {
        execGit(workspace.path, ["worktree", "remove", "--force", workspace.path]);
      } catch {
        fs.rmSync(workspace.path, { recursive: true, force: true });
      }
    }
  }

  private createChildWorktree(input: CreateChildWorkspaceInput): Workspace {
    const parent = input.parentWorkspace;
    if (!parent.repoRoot) {
      throw new Error("workspace_not_isolatable:not_git");
    }
    if (parent.unsafeDirectCwd) {
      throw new Error("workspace_not_isolatable:unsafe_direct_cwd");
    }
    if (parent.status !== "active") {
      throw new Error("workspace_not_isolatable:parent_not_active");
    }
    if (isGitDirty(parent.path)) {
      throw new Error("workspace_not_isolatable:parent_dirty");
    }

    const parentHead = readGitHead(parent.path);
    if (!parentHead) {
      throw new Error("workspace_not_isolatable:missing_parent_head");
    }

    const workspacePath = path.join(this.config.rootDir, input.taskId);
    fs.mkdirSync(this.config.rootDir, { recursive: true });
    if (!fs.existsSync(workspacePath)) {
      execGit(parent.path, ["worktree", "add", "--detach", workspacePath, parentHead], undefined, "ignore");
    }

    return {
      id: `ws_${input.taskId}`,
      path: workspacePath,
      repoRoot: parent.repoRoot,
      branch: readGitBranch(workspacePath),
      head: readGitHead(workspacePath) ?? parentHead,
      dirty: isGitDirty(workspacePath),
      baseRef: parentHead,
      parentWorkspaceId: parent.id,
      status: "active",
      unsafeDirectCwd: false,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }
}

function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function readGitBranch(repoRoot: string): string | undefined {
  const gitPath = path.join(repoRoot, ".git");
  const headPath = fs.statSync(gitPath).isDirectory()
    ? path.join(gitPath, "HEAD")
    : gitPath;

  if (!fs.existsSync(headPath)) {
    return undefined;
  }

  const head = fs.readFileSync(headPath, "utf8").trim();
  const match = head.match(/^ref:\s+refs\/heads\/(.+)$/);
  return match?.[1];
}

function readGitHead(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function isGitDirty(repoRoot: string): boolean {
  try {
    return execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
  } catch {
    return false;
  }
}

function execGit(cwd: string, args: string[], input?: string | undefined, stderr: "pipe" | "ignore" = "pipe", env?: NodeJS.ProcessEnv | undefined): string {
  return execGitRaw(cwd, args, input, stderr, env).trim();
}

function execGitRaw(cwd: string, args: string[], input?: string | undefined, stderr: "pipe" | "ignore" = "pipe", env?: NodeJS.ProcessEnv | undefined): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: env ?? process.env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", stderr],
  });
}

function findBinaryChangedPaths(workspace: Workspace, baseRef: string): Set<string> {
  const binaryPaths = new Set<string>();
  const output = execGit(workspace.path, ["diff", "--cached", "--numstat", baseRef]);
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length >= 3 && parts[0] === "-" && parts[1] === "-") {
      binaryPaths.add(parts[2]!);
    }
  }
  return binaryPaths;
}

function withTemporaryIndex<T>(cwd: string, run: () => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pm-lite-index-"));
  const tempIndex = path.join(tempDir, "index");
  const originalIndex = execGit(cwd, ["rev-parse", "--git-path", "index"]);
  if (fs.existsSync(originalIndex)) {
    fs.copyFileSync(originalIndex, tempIndex);
  }
  const previousIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = tempIndex;
  try {
    return run();
  } finally {
    if (previousIndex === undefined) {
      delete process.env.GIT_INDEX_FILE;
    } else {
      process.env.GIT_INDEX_FILE = previousIndex;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseNameStatusLine(line: string, binaryPaths: Set<string>): WorkspaceChange {
  const parts = line.split("\t");
  const status = parts[0] ?? "";
  if (status.startsWith("R")) {
    const oldPath = parts[1] ?? "";
    const newPath = parts[2] ?? oldPath;
    return {
      path: newPath,
      oldPath,
      changeKind: "rename",
      binary: binaryPaths.has(newPath) || binaryPaths.has(oldPath),
    };
  }

  const filePath = parts[1] ?? "";
  const changeKind = status === "A"
    ? "create"
    : status === "D"
      ? "delete"
      : "modify";
  return {
    path: filePath,
    changeKind,
    binary: binaryPaths.has(filePath),
  };
}
