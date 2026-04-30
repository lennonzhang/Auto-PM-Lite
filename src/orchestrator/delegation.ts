import type { PermissionMode, Profile, RuntimeKind, Task, TaskReference } from "../core/types.js";

export interface DelegateTaskInput {
  targetProfileId?: string | undefined;
  targetRuntime?: RuntimeKind | undefined;
  taskType: "ask" | "review" | "edit" | "fix" | "test";
  prompt: string;
  reason: string;
  requestedPermissionMode?: PermissionMode | undefined;
  workspaceMode?: "share" | "new-worktree" | undefined;
  timeoutMs?: number | undefined;
  references?: TaskReference[] | undefined;
}

export function resolveDelegationTargetProfile(config: { profiles: Record<string, Profile> }, parentTask: Task, input: DelegateTaskInput): Profile {
  if (input.targetProfileId) {
    const profile = config.profiles[input.targetProfileId];
    if (!profile) {
      throw new Error(`Unknown target profile: ${input.targetProfileId}`);
    }
    if (input.targetRuntime && profile.runtime !== input.targetRuntime) {
      throw new Error(`Target profile ${profile.id} does not use runtime ${input.targetRuntime}`);
    }
    return profile;
  }

  const preferredRuntime = input.targetRuntime ?? oppositeRuntime(parentTask.runtime);
  const candidates = Object.values(config.profiles)
    .filter((profile) => profile.runtime === preferredRuntime)
    .sort((left, right) => left.id.localeCompare(right.id));

  if (candidates.length === 0) {
    throw new Error(`No profile configured for runtime ${preferredRuntime}`);
  }

  return candidates[0]!;
}

export function assertReadOnlyDelegation(input: DelegateTaskInput): void {
  if (input.requestedPermissionMode && input.requestedPermissionMode !== "read-only") {
    throw new Error("editable_child_not_supported");
  }
  if (input.workspaceMode && input.workspaceMode !== "share") {
    throw new Error("child_workspace_isolation_not_supported");
  }
  if (input.taskType === "edit" || input.taskType === "fix") {
    throw new Error("editable_child_not_supported");
  }
}

export function exceedsDelegationDepth(parentDepth: number, maxDepth: number): boolean {
  return parentDepth + 1 > maxDepth;
}

export function wouldCreateDelegationCycle(lineage: Task[], targetProfile: Profile): boolean {
  return lineage.some((task) => task.profileId === targetProfile.id || task.runtime === targetProfile.runtime);
}

export function canAccessTaskLineage(requesterTaskId: string, candidate: Task, lookupTask: (taskId: string) => Task | null): boolean {
  let current: Task | null = candidate;
  while (current) {
    if (current.id === requesterTaskId) {
      return true;
    }
    current = current.parentTaskId ? lookupTask(current.parentTaskId) : null;
  }
  return false;
}

function oppositeRuntime(runtime: RuntimeKind): RuntimeKind {
  return runtime === "claude" ? "codex" : "claude";
}
