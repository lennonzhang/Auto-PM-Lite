import type { ApprovalView, ConfigMetadata, EventEnvelope, RuntimeHealth, TaskActionAccepted, TaskDetail, TaskResultView, TaskSummary, WorkspaceDiffView, WorkspaceMergeView } from "../../api/types.js";
import type { WorkspaceChange } from "../../core/types.js";

export const ipcChannels = {
  configGet: "config:get",
  tasksList: "tasks:list",
  tasksGet: "tasks:get",
  tasksResult: "tasks:result",
  tasksCreate: "tasks:create",
  tasksCreateSmokeChild: "tasks:create-smoke-child",
  tasksRun: "tasks:run",
  tasksSendTurn: "tasks:send-turn",
  tasksResume: "tasks:resume",
  tasksPause: "tasks:pause",
  tasksCancel: "tasks:cancel",
  tasksClose: "tasks:close",
  tasksHandoff: "tasks:handoff",
  tasksFork: "tasks:fork",
  tasksRollover: "tasks:rollover",
  approvalsList: "approvals:list",
  approvalsResolve: "approvals:resolve",
  workspaceChanges: "workspace:changes",
  workspaceDiff: "workspace:diff",
  workspaceMergeRequest: "workspace:merge-request",
  workspaceMergeApply: "workspace:merge-apply",
  workspaceDiscard: "workspace:discard",
  runtimeHealth: "runtime:health",
  runtimeProbeLive: "runtime:probe-live",
  logsOpen: "logs:open",
  eventsReplaySubscribe: "events:replay-subscribe",
  eventsUnsubscribe: "events:unsubscribe",
  eventsPush: "events:push",
} as const;

export interface DesktopApi {
  getConfig(): Promise<ConfigMetadata>;
  listTasks(): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  getTaskResult(input: { requesterTaskId: string; taskId: string }): Promise<TaskResultView>;
  createTask(input: { profileId: string; cwd: string; name?: string | undefined; model?: string | undefined }): Promise<TaskDetail>;
  createSmokeChildTask(input: { parentTaskId: string; targetProfileId: string; name?: string | undefined }): Promise<TaskDetail>;
  runTask(input: { taskId: string; prompt: string; requestId?: string | undefined }): Promise<TaskActionAccepted>;
  sendTurn(input: { taskId: string; prompt: string; requestId?: string | undefined }): Promise<TaskActionAccepted>;
  resumeTask(input: { taskId: string; prompt?: string | undefined; requestId?: string | undefined }): Promise<TaskActionAccepted & { resumed: true }>;
  pauseTask(taskId: string): Promise<TaskActionAccepted>;
  cancelTask(taskId: string): Promise<{ ok: true; taskId: string; cancelled: true }>;
  closeTask(input: { taskId: string; summary?: string | undefined } | string): Promise<TaskActionAccepted>;
  handoffTask(input: { taskId: string; targetProfileId: string; prompt?: string | undefined; reason: string; requestId?: string | undefined }): Promise<TaskActionAccepted>;
  forkTask(input: { taskId: string; fromTurnId?: string | undefined; name?: string | undefined; mode?: "task" | "session" | undefined; prompt?: string | undefined; requestId?: string | undefined }): Promise<TaskActionAccepted>;
  rolloverSession(input: { taskId: string; reason: "context_limit" | "model_change" | "profile_change" | "session_corrupt" | "manual"; targetProfileId?: string | undefined; carryOverPrompt?: string | undefined; requestId?: string | undefined }): Promise<TaskActionAccepted>;
  listApprovals(taskId?: string | undefined): Promise<ApprovalView[]>;
  resolveApproval(input: { approvalId: string; approved: boolean; reason?: string | undefined }): Promise<unknown>;
  listWorkspaceChanges(taskId: string): Promise<WorkspaceChange[]>;
  getWorkspaceDiff(taskId: string): Promise<WorkspaceDiffView>;
  requestWorkspaceMerge(input: { taskId: string; reason: string }): Promise<{ approvalId: string; workspaceId: string }>;
  applyWorkspaceMerge(input: { taskId: string; approvalId: string }): Promise<WorkspaceMergeView>;
  discardWorkspace(taskId: string): Promise<unknown>;
  getRuntimeHealth(): Promise<RuntimeHealth[]>;
  probeRuntimeLive(runtime?: string | undefined): Promise<RuntimeHealth[]>;
  openLogsDirectory(): Promise<{ ok: true }>;
  replayAndSubscribeToEvents(input: { taskId: string; sinceTaskSeq?: number | undefined }, listener: (event: EventEnvelope) => void): Promise<{ unsubscribe: () => void; lastTaskSeq: number }>;
}

declare global {
  interface Window {
    autoPm: DesktopApi;
  }
}
