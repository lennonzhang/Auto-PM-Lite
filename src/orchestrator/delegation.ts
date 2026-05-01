import type { PermissionMode, Policy, Profile, RuntimeKind, Task, TaskReference, Workspace } from "../core/types.js";

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

export type DelegateDenialCode =
  | "editable_delegation_not_supported"
  | "child_workspace_isolation_required"
  | "child_workspace_isolation_not_supported"
  | "cross_harness_delegation_disabled"
  | "cross_harness_delegation_required"
  | "target_profile_not_readonly"
  | "target_profile_not_editable"
  | "child_edit_not_allowed"
  | "child_network_not_allowed"
  | "workspace_not_isolatable:not_git"
  | "workspace_not_isolatable:unsafe_direct_cwd"
  | "workspace_not_isolatable:parent_dirty"
  | "workspace_not_isolatable:parent_not_active"
  | `reference_denied:${string}`
  | `reference_unknown:${string}`
  | "cycle_detected"
  | "max_depth";

export interface DelegationPolicyInput {
  request: DelegateTaskInput;
  parentPolicy: Policy;
  targetPolicy: Policy;
  parentWorkspace: Workspace;
}

export type DelegationPolicyResult =
  | {
      allowed: true;
      workspaceMode: "share" | "new-worktree";
      requestedPermissionMode: PermissionMode;
    }
  | {
      allowed: false;
      denialCode: DelegateDenialCode;
      message: string;
      workspaceMode?: "share" | "new-worktree" | undefined;
    };

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

export function evaluateDelegationPolicy(input: DelegationPolicyInput): DelegationPolicyResult {
  const workspaceMode = input.request.workspaceMode ?? defaultWorkspaceMode(input.request.taskType);
  const requestedPermissionMode = input.request.requestedPermissionMode ?? defaultPermissionMode(input.request.taskType);

  if (isEditTask(input.request.taskType)) {
    if (!input.parentPolicy.allowChildEdit) {
      return deny("child_edit_not_allowed", workspaceMode);
    }
    if (workspaceMode !== "new-worktree") {
      return deny("child_workspace_isolation_required", workspaceMode);
    }
    const workspaceDenial = evaluateIsolatedWorkspace(input.parentWorkspace);
    if (workspaceDenial) {
      return deny(workspaceDenial, workspaceMode);
    }
    if (requestedPermissionMode === "read-only") {
      return deny("editable_delegation_not_supported", workspaceMode);
    }
    if (input.targetPolicy.permissionMode !== "edit" || input.targetPolicy.sandboxMode !== "workspace-write") {
      return deny("target_profile_not_editable", workspaceMode);
    }
    if (input.targetPolicy.networkAllowed && !input.parentPolicy.allowChildNetwork) {
      return deny("child_network_not_allowed", workspaceMode);
    }
    return { allowed: true, workspaceMode, requestedPermissionMode };
  }

  if (requestedPermissionMode !== "read-only") {
    return deny("editable_delegation_not_supported", workspaceMode);
  }
  if (workspaceMode !== "share") {
    return deny("child_workspace_isolation_not_supported", workspaceMode);
  }
  if (input.targetPolicy.permissionMode !== "read-only" || input.targetPolicy.sandboxMode !== "read-only" || input.targetPolicy.networkAllowed) {
    return deny("target_profile_not_readonly", workspaceMode);
  }

  return { allowed: true, workspaceMode, requestedPermissionMode };
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

function defaultWorkspaceMode(taskType: DelegateTaskInput["taskType"]): "share" | "new-worktree" {
  return isEditTask(taskType) ? "new-worktree" : "share";
}

function defaultPermissionMode(taskType: DelegateTaskInput["taskType"]): PermissionMode {
  return isEditTask(taskType) ? "edit" : "read-only";
}

function isEditTask(taskType: DelegateTaskInput["taskType"]): boolean {
  return taskType === "edit" || taskType === "fix" || taskType === "test";
}

function evaluateIsolatedWorkspace(workspace: Workspace): DelegateDenialCode | null {
  if (!workspace.repoRoot) {
    return "workspace_not_isolatable:not_git";
  }
  if (workspace.unsafeDirectCwd) {
    return "workspace_not_isolatable:unsafe_direct_cwd";
  }
  if (workspace.status !== "active") {
    return "workspace_not_isolatable:parent_not_active";
  }
  if (workspace.dirty) {
    return "workspace_not_isolatable:parent_dirty";
  }
  return null;
}

function deny(denialCode: DelegateDenialCode, workspaceMode?: "share" | "new-worktree" | undefined): DelegationPolicyResult {
  return {
    allowed: false,
    denialCode,
    message: denialCode,
    workspaceMode,
  };
}
