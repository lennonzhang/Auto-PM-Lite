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
  tasksResume: "tasks:resume",
  tasksPause: "tasks:pause",
  tasksCancel: "tasks:cancel",
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
  runTask(input: { taskId: string; prompt: string }): Promise<TaskActionAccepted>;
  resumeTask(input: { taskId: string; prompt?: string | undefined }): Promise<TaskActionAccepted & { resumed: true }>;
  pauseTask(taskId: string): Promise<TaskActionAccepted>;
  cancelTask(taskId: string): Promise<{ ok: true; taskId: string; cancelled: true }>;
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
  replayAndSubscribeToEvents(input: { taskId?: string | undefined; sinceId?: number | undefined }, listener: (event: EventEnvelope) => void): Promise<{ unsubscribe: () => void; lastReplayedId: number }>;
}

declare global {
  interface Window {
    autoPm: DesktopApi;
  }
}
