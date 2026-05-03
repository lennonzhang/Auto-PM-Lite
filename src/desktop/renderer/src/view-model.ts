import type { ApprovalView, ArtifactView, RuntimeHealth, TaskDetail, TaskResultView, TaskSummary, WorkspaceDiffView } from "../../../api/types.js";
import type { AppErrorCode } from "../../../api/types.js";

export type TaskFilter = "all" | "active" | "approval" | "failed";

export function filterTasks(tasks: TaskSummary[], filter: TaskFilter): TaskSummary[] {
  switch (filter) {
    case "active":
      return tasks.filter((task) => task.status === "queued" || task.status === "running" || task.status === "paused" || task.status === "interrupted" || task.status === "reconcile_required");
    case "approval":
      return tasks.filter((task) => task.status === "awaiting_approval");
    case "failed":
      return tasks.filter((task) => task.status === "failed" || task.status === "cancelled");
    case "all":
      return tasks;
  }
}

export function taskCanRun(task?: TaskDetail | TaskSummary | null): boolean {
  return Boolean(task && task.status === "queued");
}

export function taskCanResume(task?: TaskDetail | TaskSummary | null): boolean {
  return Boolean(task && (task.status === "paused" || task.status === "interrupted" || task.status === "reconcile_required"));
}

export function taskCanPause(task?: TaskDetail | TaskSummary | null): boolean {
  return Boolean(task && task.status === "running");
}

export function taskCanCancel(task?: TaskDetail | TaskSummary | null): boolean {
  return Boolean(task && (task.status === "running" || task.status === "paused" || task.status === "interrupted" || task.status === "reconcile_required" || task.status === "awaiting_approval"));
}

export function pendingApprovalsForTask(approvals: ApprovalView[], taskId?: string | null): ApprovalView[] {
  return approvals.filter((approval) => approval.status === "pending" && (!taskId || approval.taskId === taskId));
}

export interface TaskTreeNode {
  task: TaskSummary;
  children: TaskTreeNode[];
}

export function buildTaskTree(tasks: TaskSummary[]): TaskTreeNode[] {
  const nodes = new Map<string, TaskTreeNode>();
  for (const task of tasks) {
    nodes.set(task.id, { task, children: [] });
  }

  const roots: TaskTreeNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    if (task.parentTaskId && nodes.has(task.parentTaskId)) {
      nodes.get(task.parentTaskId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (items: TaskTreeNode[]) => {
    items.sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt));
    for (const item of items) {
      sortNodes(item.children);
    }
  };
  sortNodes(roots);
  return roots;
}

export function childTasksForTask(tasks: TaskSummary[], taskId?: string | null): TaskSummary[] {
  if (!taskId) {
    return [];
  }
  return tasks.filter((task) => task.parentTaskId === taskId);
}

export function taskBudgetSummary(task?: TaskDetail | null): { tokens: string; cost: string; warnings: string[] } {
  const budget = task?.budget;
  if (!budget) {
    return { tokens: "-", cost: "-", warnings: [] };
  }
  const usedTokens = (budget.inputTokens ?? 0) + (budget.outputTokens ?? 0);
  const tokens = budget.maxTokens ? `${usedTokens}/${budget.maxTokens}` : String(usedTokens);
  const costValue = budget.estimatedCostUsd ?? 0;
  const cost = budget.maxCostUsd ? `$${costValue.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)}` : `$${costValue.toFixed(4)}`;
  const warnings: string[] = [];
  if (budget.maxTokens && usedTokens >= budget.maxTokens) {
    warnings.push("token budget reached");
  }
  if (budget.maxCostUsd && costValue >= budget.maxCostUsd) {
    warnings.push("cost budget reached");
  }
  return { tokens, cost, warnings };
}

export function artifactLabel(artifact: ArtifactView): string {
  return artifact.description ?? artifact.ref;
}

export function taskResultSummary(result?: TaskResultView | null): string {
  if (!result) {
    return "No result loaded";
  }
  if (result.pendingApprovalIds.length > 0) {
    return `${result.status} with ${result.pendingApprovalIds.length} pending approval(s)`;
  }
  if (result.artifacts.length > 0) {
    return `${result.status} with ${result.artifacts.length} artifact(s)`;
  }
  return result.latestMessage ? result.latestMessage : result.status;
}

export function canRequestMerge(task?: TaskDetail | null, diff?: WorkspaceDiffView | null): boolean {
  return Boolean(
    task?.workspace?.parentWorkspaceId
      && (task.workspace.status === "active" || task.workspace.status === "merge_failed")
      && diff
      && diff.changes.length > 0,
  );
}

export function canApplyMerge(task?: TaskDetail | null, approvals: ApprovalView[] = []): boolean {
  return Boolean(
    task?.workspace?.parentWorkspaceId
      && (task.workspace.status === "merge_requested" || task.workspace.status === "merge_failed")
      && approvals.some((approval) => approval.taskId === task.id && approval.kind === "workspace_merge" && approval.status === "approved"),
  );
}

export function approvedMergeApprovalId(task?: TaskDetail | null, approvals: ApprovalView[] = []): string | null {
  return approvals.find((approval) => approval.taskId === task?.id && approval.kind === "workspace_merge" && approval.status === "approved")?.id ?? null;
}

export function canDiscardWorkspace(task?: TaskDetail | null): boolean {
  return Boolean(task?.workspace?.parentWorkspaceId && task.workspace.status !== "merged" && task.workspace.status !== "discarded");
}

export function diffStats(diff?: WorkspaceDiffView | null): { total: number; binary: number; text: number; truncated: boolean } {
  const changes = diff?.changes ?? [];
  return {
    total: changes.length,
    binary: changes.filter((change) => change.binary).length,
    text: changes.filter((change) => !change.binary).length,
    truncated: Boolean(diff?.truncated),
  };
}

export function runtimeSummary(health: RuntimeHealth[]): { totalErrors: number; totalWarnings: number; available: number } {
  const checks = health.flatMap((entry) => [...entry.staticChecks, ...entry.capabilityChecks]);
  return {
    totalErrors: checks.filter((check) => check.status === "error").length,
    totalWarnings: checks.filter((check) => check.status === "warning").length,
    available: health.filter((entry) => entry.available).length,
  };
}

export interface DisplayError {
  code: AppErrorCode | "error";
  message: string;
  action?: string | undefined;
  details?: string | undefined;
}

export function formatCaughtError(caught: unknown): DisplayError {
  if (caught instanceof Error) {
    const details = errorDetails(caught);
    return {
      code: errorCode(caught),
      message: caught.message,
      ...(details.action ? { action: details.action } : {}),
      ...(details.details ? { details: details.details } : {}),
    };
  }
  return {
    code: "error",
    message: String(caught),
  };
}

function errorCode(error: Error): DisplayError["code"] {
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) {
    return code as DisplayError["code"];
  }
  return error.name && error.name !== "Error" ? error.name as DisplayError["code"] : "error";
}

function errorDetails(error: Error): { action?: string | undefined; details?: string | undefined } {
  const details = (error as Error & { details?: unknown }).details;
  if (!details) {
    return {};
  }
  if (isRuntimeHealthDetails(details)) {
    const checks = details.staticChecks.concat(details.capabilityChecks);
    const firstAction = checks.find((check) => check.status === "error" && check.action)?.action;
    return {
      ...(firstAction ? { action: firstAction } : {}),
      details: checks
        .filter((check) => check.status === "error" || check.status === "warning")
        .map((check) => `${check.label}: ${check.message ?? check.status}`)
        .slice(0, 3)
        .join("; "),
    };
  }
  if (typeof details === "object" && details && "action" in details && typeof (details as { action?: unknown }).action === "string") {
    return {
      action: (details as { action: string }).action,
      details: stringifyDetails(details),
    };
  }
  return {
    details: stringifyDetails(details),
  };
}

function isRuntimeHealthDetails(value: unknown): value is RuntimeHealth {
  return Boolean(
    value
      && typeof value === "object"
      && Array.isArray((value as RuntimeHealth).staticChecks)
      && Array.isArray((value as RuntimeHealth).capabilityChecks),
  );
}

function stringifyDetails(details: unknown): string {
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}
