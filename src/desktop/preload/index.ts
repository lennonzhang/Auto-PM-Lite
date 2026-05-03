import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels, type DesktopApi } from "../shared/ipc.js";
import { isErrorEnvelope } from "../../api/types.js";

const api: DesktopApi = {
  getConfig: () => invokeApi(ipcChannels.configGet),
  listTasks: () => invokeApi(ipcChannels.tasksList),
  getTask: (taskId) => invokeApi(ipcChannels.tasksGet, taskId),
  getTaskResult: (input) => invokeApi(ipcChannels.tasksResult, input),
  createTask: (input) => invokeApi(ipcChannels.tasksCreate, input),
  createSmokeChildTask: (input) => invokeApi(ipcChannels.tasksCreateSmokeChild, input),
  runTask: (input) => invokeApi(ipcChannels.tasksRun, input),
  resumeTask: (input) => invokeApi(ipcChannels.tasksResume, input),
  pauseTask: (taskId) => invokeApi(ipcChannels.tasksPause, taskId),
  cancelTask: (taskId) => invokeApi(ipcChannels.tasksCancel, taskId),
  listApprovals: (taskId) => invokeApi(ipcChannels.approvalsList, taskId),
  resolveApproval: (input) => invokeApi(ipcChannels.approvalsResolve, input),
  listWorkspaceChanges: (taskId) => invokeApi(ipcChannels.workspaceChanges, taskId),
  getWorkspaceDiff: (taskId) => invokeApi(ipcChannels.workspaceDiff, taskId),
  requestWorkspaceMerge: (input) => invokeApi(ipcChannels.workspaceMergeRequest, input),
  applyWorkspaceMerge: (input) => invokeApi(ipcChannels.workspaceMergeApply, input),
  discardWorkspace: (taskId) => invokeApi(ipcChannels.workspaceDiscard, taskId),
  getRuntimeHealth: () => invokeApi(ipcChannels.runtimeHealth),
  probeRuntimeLive: (runtime) => invokeApi(ipcChannels.runtimeProbeLive, runtime),
  openLogsDirectory: () => invokeApi(ipcChannels.logsOpen),
  replayAndSubscribeToEvents: async (input, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(ipcChannels.eventsPush, wrapped);
    try {
      const result = await invokeApi<{ subscriptionId: number; lastReplayedId: number }>(ipcChannels.eventsReplaySubscribe, input);
      return {
        lastReplayedId: Number(result.lastReplayedId),
        unsubscribe: () => {
          ipcRenderer.off(ipcChannels.eventsPush, wrapped);
          void ipcRenderer.invoke(ipcChannels.eventsUnsubscribe, result.subscriptionId);
        },
      };
    } catch (error) {
      ipcRenderer.off(ipcChannels.eventsPush, wrapped);
      throw error;
    }
  },
};

contextBridge.exposeInMainWorld("autoPm", api);

async function invokeApi<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (isErrorEnvelope(result)) {
    const error = new Error(result.error.message);
    error.name = result.error.code;
    Object.assign(error, {
      code: result.error.code,
      details: result.error.details,
    });
    throw error;
  }
  return result as T;
}
