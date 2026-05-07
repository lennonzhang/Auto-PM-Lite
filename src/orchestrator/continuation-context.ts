import { AppError } from "../api/types.js";
import type { BudgetSnapshot, RuntimeKind, WorkspaceChange } from "../core/types.js";

export const CONTINUATION_CONTEXT_TOKEN_LIMIT = 2048;

export interface ContinuationContext {
  schemaVersion: 1;
  kind: "handoff" | "fork" | "rollover";
  task: {
    id: string;
    name?: string | undefined;
    objective: string;
  };
  source: {
    runtime: RuntimeKind;
    profileId: string;
    sessionId: string;
    turnId?: string | undefined;
  };
  progress: {
    completed: string[];
    currentFindings: string[];
    pending: string[];
    blockers: string[];
  };
  workspace: {
    cwd: string;
    modifiedFiles: string[];
    modifiedFilesTruncated: boolean;
    changeSummary?: string | undefined;
    uncommittedChanges: boolean;
  };
  constraints: {
    policyId: string;
    budgetRemaining?: BudgetSnapshot | undefined;
    pendingApprovalIds: string[];
  };
  lineage?: {
    handoffReason?: string | undefined;
    rolloverReason?: string | undefined;
  } | undefined;
  userPrompt?: string | undefined;
}

export interface ContinuationContextInput {
  kind: ContinuationContext["kind"];
  task: ContinuationContext["task"];
  source: ContinuationContext["source"];
  policyId: string;
  budgetRemaining?: BudgetSnapshot | undefined;
  pendingApprovalIds: string[];
  cwd: string;
  latestMessage?: string | undefined;
  terminalError?: string | undefined;
  workspaceChanges: WorkspaceChange[];
  handoffReason?: string | undefined;
  rolloverReason?: string | undefined;
  userPrompt?: string | undefined;
}

export interface SerializedContinuationContext {
  context: ContinuationContext;
  xml: string;
  tokenEstimate: number;
}

export function buildContinuationContext(input: ContinuationContextInput): SerializedContinuationContext {
  const modifiedFiles = input.workspaceChanges
    .slice()
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, 20)
    .map((change) => change.oldPath ? `${change.changeKind}:${change.oldPath}->${change.path}` : `${change.changeKind}:${change.path}`);

  const context: ContinuationContext = {
    schemaVersion: 1,
    kind: input.kind,
    task: input.task,
    source: input.source,
    progress: {
      completed: tail(input.latestMessage ? [input.latestMessage] : [], 10),
      currentFindings: [],
      pending: input.userPrompt ? [input.userPrompt] : [],
      blockers: input.terminalError ? [input.terminalError] : [],
    },
    workspace: {
      cwd: input.cwd,
      modifiedFiles,
      modifiedFilesTruncated: input.workspaceChanges.length > modifiedFiles.length,
      uncommittedChanges: input.workspaceChanges.length > 0,
      ...(input.workspaceChanges.length > 0 ? { changeSummary: `${input.workspaceChanges.length} modified files` } : {}),
    },
    constraints: {
      policyId: input.policyId,
      budgetRemaining: input.budgetRemaining,
      pendingApprovalIds: input.pendingApprovalIds,
    },
    ...(input.handoffReason || input.rolloverReason ? {
      lineage: {
        ...(input.handoffReason ? { handoffReason: input.handoffReason } : {}),
        ...(input.rolloverReason ? { rolloverReason: input.rolloverReason } : {}),
      },
    } : {}),
    ...(input.userPrompt ? { userPrompt: input.userPrompt } : {}),
  };

  return serializeContinuationContext(context);
}

export function serializeContinuationContext(context: ContinuationContext): SerializedContinuationContext {
  const xml = renderXml(context);
  const tokenEstimate = estimateTokens(xml);
  if (tokenEstimate > CONTINUATION_CONTEXT_TOKEN_LIMIT) {
    throw new AppError(
      "continuation_context_too_large",
      `continuation_context_too_large: ${tokenEstimate} tokens > ${CONTINUATION_CONTEXT_TOKEN_LIMIT}`,
      { tokenEstimate, limit: CONTINUATION_CONTEXT_TOKEN_LIMIT },
    );
  }
  return { context, xml, tokenEstimate };
}

export function withContinuationPrompt(xml: string, userPrompt?: string | undefined): string {
  const prompt = userPrompt?.trim();
  return prompt
    ? `${xml}\n<user_prompt>\n${escapeXml(prompt)}\n</user_prompt>`
    : xml;
}

function renderXml(context: ContinuationContext): string {
  const lines = [
    `<continuation_context schema_version="${context.schemaVersion}" kind="${context.kind}">`,
    `  <task id="${escapeXml(context.task.id)}" objective="${escapeXml(context.task.objective)}"${context.task.name ? ` name="${escapeXml(context.task.name)}"` : ""}/>`,
    `  <source runtime="${context.source.runtime}" profile_id="${escapeXml(context.source.profileId)}" session_id="${escapeXml(context.source.sessionId)}"${context.source.turnId ? ` turn_id="${escapeXml(context.source.turnId)}"` : ""}/>`,
    "  <progress>",
    renderList("completed", context.progress.completed),
    renderList("current_findings", context.progress.currentFindings),
    renderList("pending", context.progress.pending),
    renderList("blockers", context.progress.blockers),
    "  </progress>",
    `  <workspace cwd="${escapeXml(context.workspace.cwd)}" uncommitted_changes="${context.workspace.uncommittedChanges}" modified_files_truncated="${context.workspace.modifiedFilesTruncated}">`,
    renderList("modified_files", context.workspace.modifiedFiles),
    context.workspace.changeSummary ? `    <change_summary>${escapeXml(context.workspace.changeSummary)}</change_summary>` : "",
    "  </workspace>",
    `  <constraints policy_id="${escapeXml(context.constraints.policyId)}">`,
    context.constraints.budgetRemaining ? `    <budget_remaining>${escapeXml(JSON.stringify(context.constraints.budgetRemaining))}</budget_remaining>` : "",
    renderList("pending_approval_ids", context.constraints.pendingApprovalIds),
    "  </constraints>",
    context.lineage ? `  <lineage${context.lineage.handoffReason ? ` handoff_reason="${escapeXml(context.lineage.handoffReason)}"` : ""}${context.lineage.rolloverReason ? ` rollover_reason="${escapeXml(context.lineage.rolloverReason)}"` : ""}/>` : "",
    context.userPrompt ? `  <user_prompt>${escapeXml(context.userPrompt)}</user_prompt>` : "",
    "</continuation_context>",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function renderList(tag: string, values: string[]): string {
  if (values.length === 0) {
    return `    <${tag}/>`;
  }
  return [
    `    <${tag}>`,
    ...values.map((value) => `      <item>${escapeXml(value)}</item>`),
    `    </${tag}>`,
  ].join("\n");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function tail<T>(values: T[], limit: number): T[] {
  return values.length > limit ? values.slice(values.length - limit) : values;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
