import type {
  AgentEvent,
  ArtifactRef,
  ApprovalKind,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexSandboxMode,
  Task,
  TurnRecord,
  Workspace,
  WorkspaceChange,
  WorkspaceDiff,
  WorkspaceMergeResult,
} from "../core/types.js";
import type { StoredApproval, StoredArtifact } from "../storage/db.js";

export const apiVersion = 1;
export const eventEnvelopeVersion = 1;

export type AppErrorCode =
  | "validation_failed"
  | "task_not_found"
  | "policy_denied"
  | "approval_required"
  | "config_unavailable"
  | "storage_unavailable"
  | "workspace_not_isolatable"
  | "workspace_unavailable"
  | "workspace_not_mergeable"
  | "merge_conflict"
  | "git_unavailable"
  | "mcp_unavailable"
  | "sdk_unavailable"
  | "logs_unavailable"
  | "runtime_probe_failed"
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
    readonly action?: string | undefined,
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
  parentTaskId?: string | undefined;
  delegationDepth: number;
  triggeredBy: string;
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

export type RuntimeHealthStatus = "ok" | "warning" | "error" | "unknown";

export interface RuntimeHealthCheck {
  id: string;
  label: string;
  status: RuntimeHealthStatus;
  message?: string | undefined;
  action?: string | undefined;
}

export interface RuntimeHealth {
  runtime: string;
  available: boolean;
  profiles: string[];
  message?: string | undefined;
  staticChecks: RuntimeHealthCheck[];
  capabilityChecks: RuntimeHealthCheck[];
}

export type ConfigProfileMetadata =
  | {
      id: string;
      runtime: "claude";
      model: string;
      policyId: string;
      claudePermissionMode: ClaudePermissionMode;
    }
  | {
      id: string;
      runtime: "codex";
      model: string;
      policyId: string;
      codexSandboxMode: CodexSandboxMode;
      codexApprovalPolicy: CodexApprovalPolicy;
      codexNetworkAccessEnabled: boolean;
    };

export interface TaskActionAccepted {
  ok: true;
  accepted: true;
  taskId: string;
  actionId: string;
  action: "run" | "resume" | "pause";
}

export interface TaskResultView {
  taskId: string;
  parentTaskId?: string | undefined;
  status: string;
  runtime: string;
  profileId: string;
  latestMessage?: string | undefined;
  artifacts: ArtifactView[];
  pendingApprovalIds: string[];
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
  profileIds: string[];
  profiles: ConfigProfileMetadata[];
  storage: {
    dbPath: string;
    busyTimeoutMs: number;
  };
  workspace: {
    rootDir: string;
    topLevelUseWorktree: boolean;
  };
  launcherEnvFiles?: string[] | undefined;
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
        details: error.action ? { ...(isRecord(error.details) ? error.details : { details: error.details }), action: error.action } : error.details,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
  if (message.includes("workspace_unavailable")) {
    return "workspace_unavailable";
  }
  if (message.includes("workspace_not_mergeable")) {
    return "workspace_not_mergeable";
  }
  if (message.includes("merge_conflict")) {
    return "merge_conflict";
  }
  if (message.includes("config_unavailable")) {
    return "config_unavailable";
  }
  if (message.includes("storage_unavailable")) {
    return "storage_unavailable";
  }
  if (message.includes("git_unavailable")) {
    return "git_unavailable";
  }
  if (message.includes("mcp_unavailable")) {
    return "mcp_unavailable";
  }
  if (message.includes("sdk_unavailable")) {
    return "sdk_unavailable";
  }
  if (message.includes("logs_unavailable")) {
    return "logs_unavailable";
  }
  if (message.includes("runtime_probe_failed")) {
    return "runtime_probe_failed";
  }
  if (message.includes("Runtime adapter not configured")) {
    return "runtime_unavailable";
  }
  return "unknown_error";
}
