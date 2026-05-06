import { z } from "zod";
import type { ApprovalKind, BudgetSnapshot, RuntimeKind, TurnUsage, WorkspaceChange } from "./types.js";

export const canonicalEventVersion = 2;

export type DeliveryTier = "lossless" | "coalescible" | "best_effort";

export interface EventEnvelope<E extends CanonicalEvent = CanonicalEvent> {
  v: 2;
  eventId: string;
  seq: number;
  taskSeq: number;
  runtime: RuntimeKind;
  taskId: string;
  sessionId: string;
  turnId?: string | undefined;
  itemId?: string | undefined;
  parentItemId?: string | undefined;
  ts: string;
  rawRef?: string | undefined;
  delivery: DeliveryTier;
  event: E;
}

export type CanonicalEvent = LifecycleEvent | ItemEvent | ControlEvent;

export type LifecycleEvent =
  | { kind: "session.started"; profileId: string; model: string; tools?: ToolSummary[] | undefined; mcpServers?: McpServerSummary[] | undefined }
  | { kind: "session.updated"; patch: SessionPatch }
  | { kind: "task.started"; profileId: string; model: string; cwd: string }
  | { kind: "task.queued" }
  | { kind: "task.backend_thread"; backendThreadId: string }
  | { kind: "task.paused" }
  | { kind: "task.cancelled"; reason?: string | undefined }
  | { kind: "task.completed"; summary: string }
  | { kind: "task.failed"; error: TaskError }
  | { kind: "task.interrupted"; error: TaskError }
  | { kind: "turn.started"; turnId: string; promptRedacted?: string | undefined }
  | { kind: "turn.completed"; turnId: string; usage?: TurnUsage | undefined }
  | { kind: "turn.failed"; turnId: string; error: TaskError };

export interface ToolSummary {
  name: string;
  description?: string | undefined;
}

export interface McpServerSummary {
  name: string;
  status: string;
}

export interface SessionPatch {
  model?: string | undefined;
  tools?: ToolSummary[] | undefined;
  mcpServers?: McpServerSummary[] | undefined;
  permissionMode?: string | undefined;
  version?: string | undefined;
}

export type ItemKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "command_execution"
  | "tool_call"
  | "file_change"
  | "todo_list"
  | "web_search"
  | "delegation"
  | "context_compaction"
  | "system_notice";

export type ItemStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export interface AgentItem<K extends ItemKind = ItemKind> {
  id: string;
  taskId: string;
  sessionId: string;
  turnId?: string | undefined;
  parentItemId?: string | undefined;
  kind: K;
  status: ItemStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  payload: ItemPayload[K];
  error?: ItemError | undefined;
}

export interface ItemPayload {
  user_message: {
    text: string;
    attachments?: ArtifactRef[] | undefined;
  };
  assistant_message: {
    text: string;
    phase?: "preamble" | "answer" | "summary" | undefined;
    citations?: unknown[] | undefined;
  };
  reasoning: {
    summary: string[];
    content: string[];
    redacted?: boolean | undefined;
  };
  command_execution: {
    command: string;
    cwd: string;
    processId?: string | undefined;
    source: "model" | "user" | "hook" | "system";
    status: CommandExecutionStatus;
    commandActions?: CommandAction[] | undefined;
    aggregatedOutput: string;
    outputChunks: CommandOutputChunk[];
    exitCode?: number | undefined;
    durationMs?: number | undefined;
    interactions?: TerminalInteraction[] | undefined;
  };
  tool_call: {
    tool: ToolIdentity;
    phase: ToolCallPhase;
    input: ToolInput;
    inputText?: string | undefined;
    output?: ToolOutput | undefined;
    error?: ItemError | undefined;
    durationMs?: number | undefined;
  };
  file_change: {
    changes: WorkspaceChange[];
    status: "proposed" | "applying" | "applied" | "failed";
    patchPreview?: string | undefined;
  };
  todo_list: {
    items: TodoItem[];
  };
  web_search: {
    query: string;
    action?: unknown;
    results?: WebSearchResult[] | undefined;
  };
  delegation: {
    childTaskId?: string | undefined;
    targetRuntime?: RuntimeKind | undefined;
    targetProfileId?: string | undefined;
    prompt?: string | undefined;
    status: "requested" | "started" | "completed" | "failed" | "denied";
    finalResponse?: string | undefined;
  };
  context_compaction: {
    trigger: "manual" | "auto" | "unknown";
    preTokens?: number | undefined;
    postTokens?: number | undefined;
    status: "started" | "completed";
  };
  system_notice: {
    level: "info" | "warning" | "error";
    code: NoticeCode;
    message: string;
    details?: unknown;
  };
}

export interface ArtifactRef {
  id: string;
  kind: "file" | "blob" | "url";
  ref: string;
  description?: string | undefined;
}

export type CommandExecutionStatus = "queued" | "in_progress" | "completed" | "failed" | "declined" | "cancelled";

export interface CommandOutputChunk {
  stream: "stdout" | "stderr" | "pty" | "system";
  text: string;
  byteLength?: number | undefined;
  truncated?: boolean | undefined;
}

export interface CommandAction {
  kind: string;
  label?: string | undefined;
  payload?: unknown;
}

export interface TerminalInteraction {
  input?: string | undefined;
  output?: string | undefined;
  ts?: string | undefined;
}

export type ToolCallPhase =
  | "input_streaming"
  | "queued"
  | "waiting_for_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolIdentity {
  runtime: RuntimeKind;
  namespace?: string | undefined;
  name: string;
}

export type ToolInput = unknown;
export type ToolOutput = unknown;

export interface TodoItem {
  text: string;
  completed: boolean;
}

export interface WebSearchResult {
  title?: string | undefined;
  url?: string | undefined;
  snippet?: string | undefined;
  metadata?: unknown;
}

export type NoticeCode =
  | "rate_limit_warning"
  | "auth_renewing"
  | "api_retry"
  | "hook_started"
  | "hook_finished"
  | "compact_started"
  | "compact_finished"
  | "stream_resync_required"
  | "runtime_notice";

export type ItemEvent =
  | { kind: "item.started"; item: AgentItem }
  | { kind: "item.updated"; itemId: string; patch: ItemPatch }
  | ItemCompletedEvent
  | { kind: "item.failed"; itemId: string; error: ItemError; completedAt: string }
  | { kind: "item.cancelled"; itemId: string; reason?: string | undefined; completedAt: string };

export type ItemCompletedEvent = {
  [K in ItemKind]: {
    kind: "item.completed";
    itemId: string;
    itemKind: K;
    finalPayload: ItemPayload[K];
    completedAt: string;
  };
}[ItemKind];

export type ItemPatch =
  | AppendTextPatch
  | AppendArrayTextPatch
  | AppendCommandOutputPatch
  | AppendToolInputJsonPatch
  | MergePayloadPatch
  | ReplacePayloadPatch
  | SetStatusPatch
  | SetToolPhasePatch;

export interface AppendTextPatch {
  op: "append_text";
  path: "payload.text";
  value: string;
  baseLength: number;
}

export interface AppendArrayTextPatch {
  op: "append_array_text";
  path: "payload.summary" | "payload.content";
  index: number;
  value: string;
  baseLength: number;
}

export interface AppendCommandOutputPatch {
  op: "append_command_output";
  value: CommandOutputChunk;
  baseLength: number;
}

export interface AppendToolInputJsonPatch {
  op: "append_tool_input_json";
  value: string;
  baseLength: number;
  partialParsed?: unknown;
}

export interface MergePayloadPatch {
  op: "merge_payload";
  value: Record<string, unknown>;
}

export type ReplacePayloadPatch = {
  [K in ItemKind]: {
    op: "replace_payload";
    itemKind: K;
    value: ItemPayload[K];
    reason: "snapshot" | "mismatch" | "final_reconcile";
  };
}[ItemKind];

export interface SetStatusPatch {
  op: "set_status";
  status: ItemStatus;
}

export interface SetToolPhasePatch {
  op: "set_tool_phase";
  phase: ToolCallPhase;
}

export type ControlEvent =
  | { kind: "approval.requested"; approval: ApprovalView }
  | { kind: "approval.resolved"; approvalId: string; approved: boolean; reason?: string | undefined }
  | { kind: "workspace.merge_requested"; workspaceId: string; approvalId: string }
  | { kind: "workspace.merge_started"; workspaceId: string; parentAdvanced: boolean }
  | { kind: "workspace.merged"; workspaceId: string; parentAdvanced: boolean }
  | { kind: "workspace.merge_failed"; workspaceId: string; error: TaskError }
  | { kind: "workspace.discarded"; workspaceId: string }
  | { kind: "budget.warning"; message: string; budget: BudgetSnapshot }
  | { kind: "budget.exceeded"; message: string; budget: BudgetSnapshot };

export interface ApprovalView {
  id: string;
  taskId: string;
  parentTaskId?: string | undefined;
  kind: ApprovalKind;
  payload: ApprovalPayload;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt?: string | undefined;
  resolutionReason?: string | undefined;
  expiresAt?: string | undefined;
}

export type ApprovalPayload =
  | { kind: "shell"; command: string; cwd: string; risk?: string | undefined }
  | { kind: "file_edit"; path: string; action: "create" | "modify" | "delete"; preview?: string | undefined }
  | { kind: "network"; host?: string | undefined; url?: string | undefined; reason?: string | undefined }
  | { kind: "workspace_merge"; workspaceId: string; changes: WorkspaceChange[] }
  | { kind: "cross_harness_delegation"; request: unknown }
  | { kind: "clarification"; question: string; choices?: string[] | undefined }
  | { kind: "generic"; reason?: string | undefined; data?: unknown };

export interface TaskError {
  code: "rate_limit" | "auth" | "network" | "sdk_unavailable" | "policy_denied" | "budget" | "timeout" | "internal";
  message: string;
  retriable: boolean;
  retryAfterMs?: number | undefined;
  details?: unknown;
}

export interface ItemError {
  code: "tool_failed" | "approval_denied" | "tool_timeout" | "validation_failed" | "process_failed" | "unknown";
  message: string;
  details?: unknown;
}

export interface RedactedRawRuntimeEvent {
  runtime: RuntimeKind;
  taskId: string;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  ts: string;
  redacted: unknown;
  encryptedRawBlob?: Buffer | undefined;
  ttlAt?: string | undefined;
}

export const runtimeKindSchema = z.enum(["claude", "codex"]);
export const deliveryTierSchema = z.enum(["lossless", "coalescible", "best_effort"]);
export const itemKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "tool_call",
  "file_change",
  "todo_list",
  "web_search",
  "delegation",
  "context_compaction",
  "system_notice",
]);
export const itemStatusSchema = z.enum(["queued", "in_progress", "completed", "failed", "cancelled"]);
export const commandOutputChunkSchema = z.object({
  stream: z.enum(["stdout", "stderr", "pty", "system"]),
  text: z.string(),
  byteLength: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
});
export const taskErrorSchema = z.object({
  code: z.enum(["rate_limit", "auth", "network", "sdk_unavailable", "policy_denied", "budget", "timeout", "internal"]),
  message: z.string(),
  retriable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  details: z.unknown().optional(),
});
export const itemErrorSchema = z.object({
  code: z.enum(["tool_failed", "approval_denied", "tool_timeout", "validation_failed", "process_failed", "unknown"]),
  message: z.string(),
  details: z.unknown().optional(),
});

const workspaceChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  changeKind: z.enum(["create", "modify", "delete", "rename"]),
  binary: z.boolean(),
});

const itemPayloadSchemas = {
  user_message: z.object({
    text: z.string(),
    attachments: z.array(z.object({
      id: z.string(),
      kind: z.enum(["file", "blob", "url"]),
      ref: z.string(),
      description: z.string().optional(),
    })).optional(),
  }),
  assistant_message: z.object({
    text: z.string(),
    phase: z.enum(["preamble", "answer", "summary"]).optional(),
    citations: z.array(z.unknown()).optional(),
  }),
  reasoning: z.object({
    summary: z.array(z.string()),
    content: z.array(z.string()),
    redacted: z.boolean().optional(),
  }),
  command_execution: z.object({
    command: z.string(),
    cwd: z.string(),
    processId: z.string().optional(),
    source: z.enum(["model", "user", "hook", "system"]),
    status: z.enum(["queued", "in_progress", "completed", "failed", "declined", "cancelled"]),
    commandActions: z.array(z.object({
      kind: z.string(),
      label: z.string().optional(),
      payload: z.unknown().optional(),
    })).optional(),
    aggregatedOutput: z.string(),
    outputChunks: z.array(commandOutputChunkSchema),
    exitCode: z.number().int().optional(),
    durationMs: z.number().nonnegative().optional(),
    interactions: z.array(z.object({
      input: z.string().optional(),
      output: z.string().optional(),
      ts: z.string().optional(),
    })).optional(),
  }),
  tool_call: z.object({
    tool: z.object({
      runtime: runtimeKindSchema,
      namespace: z.string().optional(),
      name: z.string(),
    }),
    phase: z.enum(["input_streaming", "queued", "waiting_for_approval", "running", "completed", "failed", "cancelled"]),
    input: z.unknown(),
    inputText: z.string().optional(),
    output: z.unknown().optional(),
    error: itemErrorSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  file_change: z.object({
    changes: z.array(workspaceChangeSchema),
    status: z.enum(["proposed", "applying", "applied", "failed"]),
    patchPreview: z.string().optional(),
  }),
  todo_list: z.object({
    items: z.array(z.object({
      text: z.string(),
      completed: z.boolean(),
    })),
  }),
  web_search: z.object({
    query: z.string(),
    action: z.unknown().optional(),
    results: z.array(z.object({
      title: z.string().optional(),
      url: z.string().optional(),
      snippet: z.string().optional(),
      metadata: z.unknown().optional(),
    })).optional(),
  }),
  delegation: z.object({
    childTaskId: z.string().optional(),
    targetRuntime: runtimeKindSchema.optional(),
    targetProfileId: z.string().optional(),
    prompt: z.string().optional(),
    status: z.enum(["requested", "started", "completed", "failed", "denied"]),
    finalResponse: z.string().optional(),
  }),
  context_compaction: z.object({
    trigger: z.enum(["manual", "auto", "unknown"]),
    preTokens: z.number().int().nonnegative().optional(),
    postTokens: z.number().int().nonnegative().optional(),
    status: z.enum(["started", "completed"]),
  }),
  system_notice: z.object({
    level: z.enum(["info", "warning", "error"]),
    code: z.enum([
      "rate_limit_warning",
      "auth_renewing",
      "api_retry",
      "hook_started",
      "hook_finished",
      "compact_started",
      "compact_finished",
      "stream_resync_required",
      "runtime_notice",
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
} satisfies { [K in ItemKind]: z.ZodType<ItemPayload[K]> };

export const agentItemSchema: z.ZodType<AgentItem> = z.discriminatedUnion("kind", [
  agentItemOf("user_message"),
  agentItemOf("assistant_message"),
  agentItemOf("reasoning"),
  agentItemOf("command_execution"),
  agentItemOf("tool_call"),
  agentItemOf("file_change"),
  agentItemOf("todo_list"),
  agentItemOf("web_search"),
  agentItemOf("delegation"),
  agentItemOf("context_compaction"),
  agentItemOf("system_notice"),
]) as z.ZodType<AgentItem>;

export const itemPatchSchema: z.ZodType<ItemPatch> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append_text"), path: z.literal("payload.text"), value: z.string(), baseLength: z.number().int().nonnegative() }),
  z.object({
    op: z.literal("append_array_text"),
    path: z.enum(["payload.summary", "payload.content"]),
    index: z.number().int().nonnegative(),
    value: z.string(),
    baseLength: z.number().int().nonnegative(),
  }),
  z.object({ op: z.literal("append_command_output"), value: commandOutputChunkSchema, baseLength: z.number().int().nonnegative() }),
  z.object({
    op: z.literal("append_tool_input_json"),
    value: z.string(),
    baseLength: z.number().int().nonnegative(),
    partialParsed: z.unknown().optional(),
  }),
  z.object({ op: z.literal("merge_payload"), value: z.record(z.string(), z.unknown()) }),
  z.object({
    op: z.literal("replace_payload"),
    itemKind: itemKindSchema,
    value: z.unknown(),
    reason: z.enum(["snapshot", "mismatch", "final_reconcile"]),
  }).superRefine((value, ctx) => {
    const schema = itemPayloadSchemas[value.itemKind];
    const parsed = schema.safeParse(value.value);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: `invalid replace_payload for ${value.itemKind}`, path: ["value"] });
    }
  }),
  z.object({ op: z.literal("set_status"), status: itemStatusSchema }),
  z.object({
    op: z.literal("set_tool_phase"),
    phase: z.enum(["input_streaming", "queued", "waiting_for_approval", "running", "completed", "failed", "cancelled"]),
  }),
]) as z.ZodType<ItemPatch>;

export const itemEventSchema: z.ZodType<ItemEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item.started"), item: agentItemSchema }),
  z.object({ kind: z.literal("item.updated"), itemId: z.string(), patch: itemPatchSchema }),
  z.object({
    kind: z.literal("item.completed"),
    itemId: z.string(),
    itemKind: itemKindSchema,
    finalPayload: z.unknown(),
    completedAt: z.string(),
  }).superRefine((value, ctx) => {
    const schema = itemPayloadSchemas[value.itemKind];
    const parsed = schema.safeParse(value.finalPayload);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: `invalid finalPayload for ${value.itemKind}`, path: ["finalPayload"] });
    }
  }),
  z.object({ kind: z.literal("item.failed"), itemId: z.string(), error: itemErrorSchema, completedAt: z.string() }),
  z.object({ kind: z.literal("item.cancelled"), itemId: z.string(), reason: z.string().optional(), completedAt: z.string() }),
]) as z.ZodType<ItemEvent>;

export const lifecycleEventSchema: z.ZodType<LifecycleEvent> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session.started"),
    profileId: z.string(),
    model: z.string(),
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
  }),
  z.object({ kind: z.literal("session.updated"), patch: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("task.started"), profileId: z.string(), model: z.string(), cwd: z.string() }),
  z.object({ kind: z.literal("task.queued") }),
  z.object({ kind: z.literal("task.backend_thread"), backendThreadId: z.string() }),
  z.object({ kind: z.literal("task.paused") }),
  z.object({ kind: z.literal("task.cancelled"), reason: z.string().optional() }),
  z.object({ kind: z.literal("task.completed"), summary: z.string() }),
  z.object({ kind: z.literal("task.failed"), error: taskErrorSchema }),
  z.object({ kind: z.literal("task.interrupted"), error: taskErrorSchema }),
  z.object({ kind: z.literal("turn.started"), turnId: z.string(), promptRedacted: z.string().optional() }),
  z.object({
    kind: z.literal("turn.completed"),
    turnId: z.string(),
    usage: z.object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cacheCreationInputTokens: z.number().optional(),
      reasoningOutputTokens: z.number().optional(),
      costUsd: z.number().optional(),
    }).optional(),
  }),
  z.object({ kind: z.literal("turn.failed"), turnId: z.string(), error: taskErrorSchema }),
]) as z.ZodType<LifecycleEvent>;

const approvalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), command: z.string(), cwd: z.string(), risk: z.string().optional() }),
  z.object({ kind: z.literal("file_edit"), path: z.string(), action: z.enum(["create", "modify", "delete"]), preview: z.string().optional() }),
  z.object({ kind: z.literal("network"), host: z.string().optional(), url: z.string().optional(), reason: z.string().optional() }),
  z.object({ kind: z.literal("workspace_merge"), workspaceId: z.string(), changes: z.array(workspaceChangeSchema) }),
  z.object({ kind: z.literal("cross_harness_delegation"), request: z.unknown() }),
  z.object({ kind: z.literal("clarification"), question: z.string(), choices: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("generic"), reason: z.string().optional(), data: z.unknown().optional() }),
]);

export const controlEventSchema: z.ZodType<ControlEvent> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval.requested"),
    approval: z.object({
      id: z.string(),
      taskId: z.string(),
      parentTaskId: z.string().optional(),
      kind: z.string(),
      payload: approvalPayloadSchema,
      status: z.enum(["pending", "approved", "denied", "expired"]),
      requestedAt: z.string(),
      resolvedAt: z.string().optional(),
      resolutionReason: z.string().optional(),
      expiresAt: z.string().optional(),
    }),
  }),
  z.object({ kind: z.literal("approval.resolved"), approvalId: z.string(), approved: z.boolean(), reason: z.string().optional() }),
  z.object({ kind: z.literal("workspace.merge_requested"), workspaceId: z.string(), approvalId: z.string() }),
  z.object({ kind: z.literal("workspace.merge_started"), workspaceId: z.string(), parentAdvanced: z.boolean() }),
  z.object({ kind: z.literal("workspace.merged"), workspaceId: z.string(), parentAdvanced: z.boolean() }),
  z.object({ kind: z.literal("workspace.merge_failed"), workspaceId: z.string(), error: taskErrorSchema }),
  z.object({ kind: z.literal("workspace.discarded"), workspaceId: z.string() }),
  z.object({
    kind: z.literal("budget.warning"),
    message: z.string(),
    budget: z.object({
      maxTokens: z.number().optional(),
      maxCostUsd: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      estimatedCostUsd: z.number().optional(),
    }),
  }),
  z.object({
    kind: z.literal("budget.exceeded"),
    message: z.string(),
    budget: z.object({
      maxTokens: z.number().optional(),
      maxCostUsd: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      estimatedCostUsd: z.number().optional(),
    }),
  }),
]) as z.ZodType<ControlEvent>;

export const canonicalEventSchema: z.ZodType<CanonicalEvent> = z.union([
  lifecycleEventSchema,
  itemEventSchema,
  controlEventSchema,
]);

export const eventEnvelopeSchemaV2: z.ZodType<EventEnvelope> = z.object({
  v: z.literal(2),
  eventId: z.string(),
  seq: z.number().int().positive(),
  taskSeq: z.number().int().positive(),
  runtime: runtimeKindSchema,
  taskId: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  parentItemId: z.string().optional(),
  ts: z.string(),
  rawRef: z.string().optional(),
  delivery: deliveryTierSchema,
  event: canonicalEventSchema,
}) as z.ZodType<EventEnvelope>;

export function validateCanonicalEvent(event: unknown): CanonicalEvent {
  return canonicalEventSchema.parse(event);
}

export function validateEventEnvelope(event: unknown): EventEnvelope {
  return eventEnvelopeSchemaV2.parse(event);
}

function agentItemOf<K extends ItemKind>(kind: K) {
  return z.object({
    id: z.string(),
    taskId: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    parentItemId: z.string().optional(),
    kind: z.literal(kind),
    status: itemStatusSchema,
    startedAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().optional(),
    payload: itemPayloadSchemas[kind],
    error: itemErrorSchema.optional(),
  });
}
