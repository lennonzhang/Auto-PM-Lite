import { z } from "zod";
import { eventEnvelopeSchemaV2 } from "../core/events.js";

export const taskIdSchema = z.string().min(1);
export const apiVersionSchema = z.literal(1);
export const eventEnvelopeVersionSchema = z.literal(2);

export const createTaskRequestSchema = z.object({
  profileId: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().optional(),
  model: z.string().min(1).optional(),
});

export const runTaskRequestSchema = z.object({
  taskId: taskIdSchema,
  prompt: z.string().min(1),
  requestId: z.string().min(1).optional(),
});

export const sendTurnRequestSchema = runTaskRequestSchema;

export const resumeTaskRequestSchema = z.object({
  taskId: taskIdSchema,
  prompt: z.string().optional(),
  requestId: z.string().min(1).optional(),
});

export const handoffTaskRequestSchema = z.object({
  taskId: taskIdSchema,
  targetProfileId: z.string().min(1),
  prompt: z.string().optional(),
  reason: z.string().min(1),
  requestId: z.string().min(1).optional(),
});

export const forkTaskRequestSchema = z.object({
  taskId: taskIdSchema,
  fromTurnId: z.string().min(1).optional(),
  name: z.string().optional(),
  mode: z.enum(["task", "session"]).default("task"),
  prompt: z.string().optional(),
  requestId: z.string().min(1).optional(),
});

export const rolloverSessionRequestSchema = z.object({
  taskId: taskIdSchema,
  reason: z.enum(["context_limit", "model_change", "profile_change", "session_corrupt", "manual"]),
  targetProfileId: z.string().min(1).optional(),
  carryOverPrompt: z.string().optional(),
  requestId: z.string().min(1).optional(),
});

export const pauseTaskRequestSchema = z.object({
  taskId: taskIdSchema,
});

export const resolveApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const requestWorkspaceMergeSchema = z.object({
  taskId: taskIdSchema,
  reason: z.string().min(1),
});

export const applyWorkspaceMergeSchema = z.object({
  taskId: taskIdSchema,
  approvalId: z.string().min(1),
});

export const eventSubscriptionRequestSchema = z.object({
  taskId: z.string().min(1),
  sinceTaskSeq: z.number().int().nonnegative().optional(),
});

export const eventDebugRequestSchema = z.object({
  sinceGlobalSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  taskId: z.string().min(1).optional(),
  runtime: z.enum(["claude", "codex"]).optional(),
  kind: z.string().min(1).optional(),
});

export const rawEventRequestSchema = z.object({
  rawRef: z.string().min(1),
});

export const projectionCheckRequestSchema = z.object({
  taskId: z.string().min(1),
});

export const errorEnvelopeSchema = z.object({
  apiVersion: apiVersionSchema,
  error: z.object({
    code: z.enum([
      "validation_failed",
      "task_not_found",
      "policy_denied",
      "approval_required",
      "config_unavailable",
      "storage_unavailable",
      "workspace_not_isolatable",
      "workspace_unavailable",
      "workspace_not_mergeable",
      "merge_conflict",
      "git_unavailable",
      "mcp_unavailable",
      "sdk_unavailable",
      "logs_unavailable",
      "runtime_probe_failed",
      "runtime_unavailable",
      "task_busy",
      "task_terminal",
      "not_recoverable",
      "session_unavailable",
      "runtime_capability_unavailable",
      "fork_not_supported",
      "fork_truncation_required",
      "handoff_failed",
      "rollover_failed",
      "continuation_context_too_large",
      "unknown_error",
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const taskSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  defaultProfileId: z.string(),
  defaultRuntime: z.string(),
  defaultModel: z.string(),
  currentSession: z.object({
    id: z.string(),
    taskId: z.string(),
    runtime: z.enum(["claude", "codex"]),
    profileId: z.string(),
    model: z.string(),
    cwd: z.string(),
    backendThreadId: z.string().optional(),
    parentSessionId: z.string().optional(),
    forkedFromTurnId: z.string().optional(),
    handoffFromSessionId: z.string().optional(),
    rolloverFromSessionId: z.string().optional(),
    status: z.enum(["opening", "active", "closed", "failed"]),
    closeReason: z.enum(["handoff", "rollover", "forked", "cancelled", "failed", "task_closed"]).optional(),
    createdAt: z.string(),
    lastUsedAt: z.string().optional(),
    closedAt: z.string().optional(),
  }).optional(),
  status: z.string(),
  cwd: z.string(),
  parentTaskId: z.string().optional(),
  delegationDepth: z.number().int().nonnegative(),
  triggeredBy: z.string(),
  createdAt: z.string(),
});

export const turnViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  turnNumber: z.number().int().positive(),
  requestId: z.string().optional(),
  promptRedacted: z.string(),
  promptRawEncrypted: z.string().optional(),
  promptRawTtlAt: z.string().optional(),
  status: z.enum(["running", "paused", "completed", "failed", "cancelled"]),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    reasoningOutputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  }).optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

export const artifactViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["file", "blob", "url"]),
  ref: z.string(),
  description: z.string().optional(),
  ts: z.string(),
});

export const workspaceChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  changeKind: z.enum(["create", "modify", "delete", "rename"]),
  binary: z.boolean(),
});

export const workspaceMergeErrorSchema = z.object({
  code: z.enum(["parent_dirty", "merge_conflict", "workspace_not_mergeable", "git_error"]),
  message: z.string(),
  parentHead: z.string().optional(),
  childHead: z.string().optional(),
  changes: z.array(workspaceChangeSchema).optional(),
});

export const workspaceViewSchema = z.object({
  id: z.string(),
  path: z.string(),
  repoRoot: z.string().optional(),
  branch: z.string().optional(),
  head: z.string().optional(),
  dirty: z.boolean().optional(),
  baseRef: z.string().optional(),
  parentWorkspaceId: z.string().optional(),
  status: z.enum(["active", "merge_requested", "merging", "merged", "merge_failed", "discarded"]),
  unsafeDirectCwd: z.boolean(),
  createdAt: z.string(),
  mergeRequestedAt: z.string().optional(),
  mergeApprovalId: z.string().optional(),
  mergedAt: z.string().optional(),
  discardedAt: z.string().optional(),
  mergeError: workspaceMergeErrorSchema.optional(),
});

export const taskDetailSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  defaultProfileId: z.string(),
  defaultRuntime: z.enum(["claude", "codex"]),
  defaultModel: z.string(),
  cwd: z.string(),
  workspaceId: z.string(),
  parentTaskId: z.string().optional(),
  delegationDepth: z.number().int().nonnegative(),
  delegationChain: z.array(z.string()),
  status: z.string(),
  budget: z.object({
    maxTokens: z.number().optional(),
    maxCostUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    estimatedCostUsd: z.number().optional(),
  }),
  triggeredBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  turns: z.array(turnViewSchema),
  artifacts: z.array(artifactViewSchema),
  latestMessage: z.string().optional(),
  terminalError: z.string().optional(),
  workspace: workspaceViewSchema.optional(),
});

export const approvalViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  parentTaskId: z.string().optional(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  resolutionReason: z.string().optional(),
  expiresAt: z.string().optional(),
  category: z.enum(["tool_approval", "privilege_escalation", "clarification", "capability_request"]),
});

export const workspaceDiffSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  baseRef: z.string(),
  head: z.string().optional(),
  changes: z.array(workspaceChangeSchema),
  patch: z.string(),
  truncated: z.boolean(),
});

export const workspaceMergeResultSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  status: z.enum(["active", "merge_requested", "merging", "merged", "merge_failed", "discarded"]),
  parentAdvanced: z.boolean(),
  parentHead: z.string().optional(),
  childHead: z.string().optional(),
  changes: z.array(workspaceChangeSchema),
  error: workspaceMergeErrorSchema.optional(),
});

export const runtimeHealthCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ok", "warning", "error", "unknown"]),
  message: z.string().optional(),
  action: z.string().optional(),
});

export const runtimeHealthSchema = z.object({
  runtime: z.string(),
  available: z.boolean(),
  profiles: z.array(z.string()),
  message: z.string().optional(),
  staticChecks: z.array(runtimeHealthCheckSchema),
  capabilityChecks: z.array(runtimeHealthCheckSchema),
});

const configProfileMetadataSchema = z.discriminatedUnion("runtime", [
  z.object({
    id: z.string(),
    runtime: z.literal("claude"),
    model: z.string(),
    allowedModels: z.array(z.string()).optional(),
    policyId: z.string(),
    claudePermissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]),
  }),
  z.object({
    id: z.string(),
    runtime: z.literal("codex"),
    model: z.string(),
    allowedModels: z.array(z.string()).optional(),
    policyId: z.string(),
    codexSandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    codexApprovalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]),
    codexNetworkAccessEnabled: z.boolean(),
  }),
]);

export const taskActionAcceptedSchema = z.object({
  ok: z.literal(true),
  accepted: z.literal(true),
  taskId: z.string(),
  actionId: z.string(),
  action: z.enum(["run", "resume", "pause"]),
});

export const taskResultViewSchema = z.object({
  taskId: z.string(),
  parentTaskId: z.string().optional(),
  status: z.string(),
  defaultRuntime: z.string(),
  defaultProfileId: z.string(),
  defaultModel: z.string(),
  currentSession: taskSummarySchema.shape.currentSession,
  latestMessage: z.string().optional(),
  terminalError: z.string().optional(),
  artifacts: z.array(artifactViewSchema),
  pendingApprovalIds: z.array(z.string()),
});

export const configMetadataSchema = z.object({
  apiVersion: apiVersionSchema,
  accounts: z.array(z.string()),
  policies: z.array(z.string()),
  profileIds: z.array(z.string()),
  profiles: z.array(configProfileMetadataSchema),
  storage: z.object({
    dbPath: z.string(),
    busyTimeoutMs: z.number(),
  }),
  workspace: z.object({
    rootDir: z.string(),
    topLevelUseWorktree: z.boolean(),
  }),
  launcherEnvFiles: z.array(z.string()).optional(),
});

export const eventEnvelopeSchema = eventEnvelopeSchemaV2;
