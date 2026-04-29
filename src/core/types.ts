export type RuntimeKind = "claude" | "codex";

export type VendorKind =
  | "anthropic"
  | "anthropic-bedrock"
  | "anthropic-vertex"
  | "anthropic-compatible"
  | "openai"
  | "openai-compatible"
  | "openai-azure";

export type PermissionMode = "read-only" | "edit" | "full";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalKind =
  | "tool"
  | "network"
  | "filesystem"
  | "delegation"
  | "workspace_merge"
  | "budget_increase"
  | "reference_access";

export interface Account {
  id: string;
  vendor: VendorKind;
  baseUrl?: string | undefined;
  secretRef: string;
  extraHeaders?: Record<string, string> | undefined;
  extraConfig?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
}

export interface Policy {
  id: string;
  permissionMode: PermissionMode;
  sandboxMode: SandboxMode;
  networkAllowed: boolean;
  approvalPolicy: "never" | "on-request" | "untrusted" | "orchestrator";
  requireApprovalFor: ApprovalKind[];
  maxDepth: number;
  maxTurns?: number | undefined;
  maxMinutes?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  allowCrossHarnessDelegation: boolean;
  allowChildEdit: boolean;
  allowChildNetwork: boolean;
  unsafeDirectCwd?: boolean | undefined;
}

export interface Profile {
  id: string;
  runtime: RuntimeKind;
  accountId: string;
  policyId: string;
  model: string;
  allowedModels?: string[] | undefined;
  systemPromptOverride?: string | undefined;
  tags?: string[] | undefined;
}

export interface BudgetSnapshot {
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  estimatedCostUsd?: number | undefined;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "interrupted"
  | "reconcile_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface Workspace {
  id: string;
  path: string;
  repoRoot?: string | undefined;
  branch?: string | undefined;
  baseRef?: string | undefined;
  parentWorkspaceId?: string | undefined;
  status: "active" | "merged" | "discarded";
  unsafeDirectCwd: boolean;
  createdAt: string;
}

export interface Task {
  id: string;
  name?: string | undefined;
  profileId: string;
  runtime: RuntimeKind;
  cwd: string;
  workspaceId: string;
  parentTaskId?: string | undefined;
  delegationDepth: number;
  delegationChain: string[];
  backendThreadId?: string | undefined;
  status: TaskStatus;
  budget: BudgetSnapshot;
  triggeredBy: "user" | `delegate:${string}`;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

export interface TurnUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  reasoningOutputTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface TurnRecord {
  id: string;
  taskId: string;
  promptRedacted: string;
  promptRawEncrypted?: string | undefined;
  promptRawTtlAt?: string | undefined;
  status: "running" | "completed" | "failed";
  usage?: TurnUsage | undefined;
  startedAt: string;
  completedAt?: string | undefined;
}

export interface TaskReference {
  taskId: string;
  turnId?: string | undefined;
  turnNumber?: number | undefined;
}

export type AgentEvent =
  | { type: "task.queued"; taskId: string; ts: string }
  | { type: "task.started"; taskId: string; runtime: RuntimeKind; profileId: string; ts: string }
  | { type: "turn.started"; taskId: string; turnId: string; ts: string }
  | { type: "turn.completed"; taskId: string; turnId: string; usage?: TurnUsage | undefined; ts: string }
  | { type: "message.delta"; taskId: string; turnId?: string; text: string; ts: string }
  | { type: "message.completed"; taskId: string; turnId?: string; text: string; ts: string }
  | { type: "tool.call"; taskId: string; tool: string; input: unknown; ts: string }
  | { type: "tool.result"; taskId: string; tool: string; result: unknown; ts: string }
  | { type: "approval.requested"; taskId: string; approvalId: string; kind: ApprovalKind; ts: string }
  | { type: "approval.resolved"; taskId: string; approvalId: string; approved: boolean; ts: string }
  | { type: "delegation.requested"; taskId: string; request: unknown; ts: string }
  | { type: "delegation.started"; taskId: string; childTaskId: string; ts: string }
  | { type: "delegation.completed"; taskId: string; childTaskId: string; ts: string }
  | { type: "reference.expanded"; taskId: string; sourceTaskId: string; requestedByTaskId: string; ts: string }
  | { type: "file.changed"; taskId: string; path: string; changeKind: "create" | "modify" | "delete"; ts: string }
  | { type: "budget.warning"; taskId: string; message: string; ts: string }
  | { type: "budget.exceeded"; taskId: string; message: string; ts: string }
  | { type: "task.completed"; taskId: string; summary: string; ts: string }
  | { type: "task.failed"; taskId: string; error: string; ts: string }
  | { type: "task.cancelled"; taskId: string; ts: string };

export interface AppConfig {
  accounts: Record<string, Account>;
  policies: Record<string, Policy>;
  profiles: Record<string, Profile>;
  redaction: {
    additionalPatterns: string[];
  };
  transcript: {
    storeRawEncrypted: boolean;
    rawTtlHours?: number | undefined;
  };
  storage: {
    dbPath: string;
    busyTimeoutMs: number;
    maxQueueSize: number;
    flushBatchSize: number;
  };
  workspace: {
    rootDir: string;
    topLevelUseWorktree: boolean;
  };
}
