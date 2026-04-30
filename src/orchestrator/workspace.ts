import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AppConfig, Workspace } from "../core/types.js";

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
        throw new Error("child_workspace_isolation_not_supported");
      default:
        throw new Error(`invalid_child_workspace_plan:${input.plan.kind}`);
    }
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
