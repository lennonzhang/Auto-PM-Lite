import { z } from "zod";

export const taskIdSchema = z.string().min(1);
export const apiVersionSchema = z.literal(1);
export const eventEnvelopeVersionSchema = z.literal(1);

export const createTaskRequestSchema = z.object({
  profileId: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().optional(),
});

export const runTaskRequestSchema = z.object({
  taskId: taskIdSchema,
  prompt: z.string().min(1),
});

export const resumeTaskRequestSchema = z.object({
  taskId: taskIdSchema,
  prompt: z.string().optional(),
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
  taskId: z.string().min(1).optional(),
  sinceId: z.number().int().nonnegative().optional(),
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
      "unknown_error",
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const taskSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  profileId: z.string(),
  runtime: z.string(),
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
  promptRedacted: z.string(),
  promptRawEncrypted: z.string().optional(),
  promptRawTtlAt: z.string().optional(),
  status: z.enum(["running", "paused", "completed", "failed"]),
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
  profileId: z.string(),
  runtime: z.enum(["claude", "codex"]),
  cwd: z.string(),
  workspaceId: z.string(),
  parentTaskId: z.string().optional(),
  delegationDepth: z.number().int().nonnegative(),
  delegationChain: z.array(z.string()),
  backendThreadId: z.string().optional(),
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
  completedAt: z.string().optional(),
  turns: z.array(turnViewSchema),
  artifacts: z.array(artifactViewSchema),
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
    policyId: z.string(),
    claudePermissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]),
  }),
  z.object({
    id: z.string(),
    runtime: z.literal("codex"),
    model: z.string(),
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
  runtime: z.string(),
  profileId: z.string(),
  latestMessage: z.string().optional(),
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

export const eventEnvelopeSchema = z.object({
  eventEnvelopeVersion: eventEnvelopeVersionSchema,
  id: z.number().int().positive().optional(),
  durable: z.boolean(),
  ephemeral: z.boolean().optional(),
  event: z.object({
    type: z.string(),
    taskId: z.string(),
    ts: z.string(),
  }).passthrough(),
}).superRefine((value, ctx) => {
  if (value.durable && typeof value.id !== "number") {
    ctx.addIssue({
      code: "custom",
      message: "durable events require an id",
      path: ["id"],
    });
  }
  if (!value.durable && value.ephemeral !== true) {
    ctx.addIssue({
      code: "custom",
      message: "non-durable events must be marked ephemeral",
      path: ["ephemeral"],
    });
  }
});
