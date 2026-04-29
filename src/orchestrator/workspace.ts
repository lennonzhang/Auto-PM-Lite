import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AppConfig, Workspace } from "../core/types.js";

export interface CreateWorkspaceInput {
  taskId: string;
  cwd: string;
}

export class WorkspaceManager {
  constructor(private readonly config: AppConfig["workspace"]) {}

  createTopLevelWorkspace(input: CreateWorkspaceInput): Workspace {
    const repoRoot = findRepoRoot(input.cwd);
    const createdAt = new Date().toISOString();
    const useWorktree = Boolean(repoRoot) && this.config.topLevelUseWorktree;

    if (!repoRoot || !useWorktree) {
      return {
        id: `ws_${input.taskId}`,
        path: input.cwd,
        repoRoot: repoRoot ?? undefined,
        branch: repoRoot ? readGitBranch(repoRoot) : undefined,
        baseRef: repoRoot ? readGitBranch(repoRoot) : undefined,
        status: "active",
        unsafeDirectCwd: Boolean(repoRoot) && !useWorktree,
        createdAt,
      };
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
      baseRef: readGitBranch(repoRoot),
      status: "active",
      unsafeDirectCwd: false,
      createdAt,
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
