import type { AgentEvent, ArtifactRef, ApprovalKind, Task, TurnRecord, Workspace, WorkspaceChange, WorkspaceDiff, WorkspaceMergeResult } from "../core/types.js";
import type { StoredApproval, StoredArtifact } from "../storage/db.js";

export const apiVersion = 1;
export const eventEnvelopeVersion = 1;

export type AppErrorCode =
  | "validation_failed"
  | "task_not_found"
  | "policy_denied"
  | "approval_required"
  | "workspace_not_isolatable"
  | "workspace_not_mergeable"
  | "merge_conflict"
  | "runtime_unavailable"
  | "unknown_error";

export interface ErrorEnvelope {
  apiVersion: number;
  error: {
    code: AppErrorCode;
    message: string;
    details?: unknown | undefined;
  };
}

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: unknown | undefined,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface TaskSummary {
  id: string;
  name: string | null;
  profileId: string;
  runtime: string;
  status: string;
  cwd: string;
  createdAt: string;
}

export interface TaskDetail extends Task {
  turns: TurnView[];
  artifacts: ArtifactView[];
  workspace?: WorkspaceView | undefined;
}

export interface TurnView extends TurnRecord {}

export interface ApprovalView extends StoredApproval {
  category: "tool_approval" | "privilege_escalation" | "clarification" | "capability_request";
}

export interface ArtifactView extends StoredArtifact {}

export interface WorkspaceView extends Workspace {}

export interface WorkspaceDiffView extends WorkspaceDiff {}

export interface WorkspaceMergeView extends WorkspaceMergeResult {}

export interface RuntimeHealth {
  runtime: string;
  available: boolean;
  profiles: string[];
  message?: string | undefined;
}

export interface EventEnvelope {
  eventEnvelopeVersion: number;
  id?: number | undefined;
  durable: boolean;
  ephemeral?: boolean | undefined;
  event: AgentEvent;
}

export interface ConfigMetadata {
  apiVersion: number;
  accounts: string[];
  policies: string[];
  profiles: string[];
  storage: {
    dbPath: string;
    busyTimeoutMs: number;
  };
  workspace: {
    rootDir: string;
    topLevelUseWorktree: boolean;
  };
}

export type WorkspaceChangesView = WorkspaceChange[];
export type ArtifactRefsView = ArtifactRef[];

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AppError) {
    return {
      apiVersion,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  if (isZodErrorLike(error)) {
    return {
      apiVersion,
      error: {
        code: "validation_failed",
        message: "validation_failed",
        details: error.issues,
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    apiVersion,
    error: {
      code: inferErrorCode(message),
      message,
    },
  };
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { apiVersion?: unknown; error?: unknown };
  if (candidate.apiVersion !== apiVersion || !candidate.error || typeof candidate.error !== "object") {
    return false;
  }
  const error = candidate.error as { code?: unknown; message?: unknown };
  return typeof error.code === "string" && typeof error.message === "string";
}

function isZodErrorLike(error: unknown): error is { issues: unknown[] } {
  return Boolean(
    error
      && typeof error === "object"
      && "issues" in error
      && Array.isArray((error as { issues?: unknown }).issues),
  );
}

function inferErrorCode(message: string): AppErrorCode {
  if (message.includes("Unknown task")) {
    return "task_not_found";
  }
  if (message.includes("approval_required")) {
    return "approval_required";
  }
  if (message.includes("workspace_not_isolatable")) {
    return "workspace_not_isolatable";
  }
  if (message.includes("workspace_not_mergeable")) {
    return "workspace_not_mergeable";
  }
  if (message.includes("merge_conflict")) {
    return "merge_conflict";
  }
  if (message.includes("Runtime adapter not configured")) {
    return "runtime_unavailable";
  }
  return "unknown_error";
}
