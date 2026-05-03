import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { shell } from "electron";
import { toErrorEnvelope, type EventEnvelope } from "../../api/types.js";
import type { AppServices } from "../../service/app-services.js";
import { ipcChannels } from "../shared/ipc.js";
import { DesktopJobRunner } from "./job-runner.js";

export interface IpcHandlerRuntime {
  getServices(): Promise<AppServices>;
  getNextSubscriptionId(): number;
  getLogDir?: (() => string | null) | undefined;
  writeLog?: ((message: string) => void | Promise<void>) | undefined;
}

export function registerIpcHandlers(ipcMain: Pick<IpcMain, "handle">, runtime: IpcHandlerRuntime): Map<number, () => void> {
  const eventSubscriptions = new Map<number, () => void>();
  const senderSubscriptions = new WeakMap<WebContents, Set<number>>();
  const jobs = new DesktopJobRunner({ log: runtime.writeLog });

  ipcMain.handle(ipcChannels.configGet, handleApi(async () => (await runtime.getServices()).config.getMetadata()));
  ipcMain.handle(ipcChannels.tasksList, handleApi(async () => (await runtime.getServices()).tasks.listTasks()));
  ipcMain.handle(ipcChannels.tasksGet, handleApi(async (_event, taskId: string) => (await runtime.getServices()).tasks.getTask(taskId)));
  ipcMain.handle(ipcChannels.tasksResult, handleApi(async (_event, input: { requesterTaskId: string; taskId: string }) => (
    await runtime.getServices()
  ).tasks.getTaskResult(input.requesterTaskId, input.taskId)));
  ipcMain.handle(ipcChannels.tasksCreate, handleApi(async (_event, input) => (await runtime.getServices()).tasks.createTask(input)));
  ipcMain.handle(ipcChannels.tasksCreateSmokeChild, handleApi(async (_event, input) => {
    if (process.env.AUTO_PM_DESKTOP_FAKE_RUNTIME !== "1") {
      throw new Error("smoke_child_task_unavailable");
    }
    return (await runtime.getServices()).tasks.createChildTaskForSmoke(input);
  }));
  ipcMain.handle(ipcChannels.tasksRun, handleApi(async (_event, input) => jobs.acceptRun(await runtime.getServices(), input)));
  ipcMain.handle(ipcChannels.tasksResume, handleApi(async (_event, input) => jobs.acceptResume(await runtime.getServices(), input)));
  ipcMain.handle(ipcChannels.tasksPause, handleApi(async (_event, taskId: string) => jobs.acceptPause(await runtime.getServices(), taskId)));
  ipcMain.handle(ipcChannels.tasksCancel, handleApi(async (_event, taskId: string) => (await runtime.getServices()).tasks.cancelTask(taskId)));
  ipcMain.handle(ipcChannels.approvalsList, handleApi(async (_event, taskId?: string) => (await runtime.getServices()).approvals.listApprovals(taskId)));
  ipcMain.handle(ipcChannels.approvalsResolve, handleApi(async (_event, input) => (await runtime.getServices()).approvals.resolveApproval(input)));
  ipcMain.handle(ipcChannels.workspaceChanges, handleApi(async (_event, taskId: string) => (await runtime.getServices()).workspaces.listChanges(taskId)));
  ipcMain.handle(ipcChannels.workspaceDiff, handleApi(async (_event, taskId: string) => (await runtime.getServices()).workspaces.getDiff(taskId)));
  ipcMain.handle(ipcChannels.workspaceMergeRequest, handleApi(async (_event, input) => (await runtime.getServices()).workspaces.requestMerge(input)));
  ipcMain.handle(ipcChannels.workspaceMergeApply, handleApi(async (_event, input) => (await runtime.getServices()).workspaces.applyMerge(input)));
  ipcMain.handle(ipcChannels.workspaceDiscard, handleApi(async (_event, taskId: string) => (await runtime.getServices()).workspaces.discard(taskId)));
  ipcMain.handle(ipcChannels.runtimeHealth, handleApi(async () => (await runtime.getServices()).runtime.getHealth()));
  ipcMain.handle(ipcChannels.runtimeProbeLive, handleApi(async (_event, runtimeName?: string) => (
    await runtime.getServices()
  ).runtime.probeLive(runtimeName)));
  ipcMain.handle(ipcChannels.logsOpen, handleApi(async () => {
    const logDir = runtime.getLogDir?.();
    if (!logDir) {
      throw new Error("logs_unavailable");
    }
    await shell.openPath(logDir);
    return { ok: true as const };
  }));
  ipcMain.handle(ipcChannels.eventsReplaySubscribe, handleApi(async (event: IpcMainInvokeEvent, input?: { taskId?: string; sinceId?: number }) => {
    const subscriptionId = runtime.getNextSubscriptionId();
    const sender = event.sender;
    const replay = await (await runtime.getServices()).events.replayAndSubscribe({
      taskId: input?.taskId,
      sinceId: input?.sinceId,
      listener: (envelope: EventEnvelope) => {
        sendEvent(sender, envelope);
      },
    });
    const unsubscribe = () => {
      replay.unsubscribe();
      unregisterSenderSubscription(senderSubscriptions, sender, subscriptionId);
    };
    eventSubscriptions.set(subscriptionId, unsubscribe);
    registerSenderSubscription(senderSubscriptions, eventSubscriptions, sender, subscriptionId);
    return { subscriptionId, lastReplayedId: replay.lastReplayedId };
  }));
  ipcMain.handle(ipcChannels.eventsUnsubscribe, handleApi(async (_event, subscriptionId: number) => {
    cleanupSubscription(eventSubscriptions, subscriptionId);
    return { ok: true };
  }));

  return eventSubscriptions;
}

function handleApi<TArgs extends unknown[], TResult>(
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
): (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult | ReturnType<typeof toErrorEnvelope>> {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      return toErrorEnvelope(error);
    }
  };
}

function sendEvent(sender: WebContents, envelope: EventEnvelope): void {
  if (!sender.isDestroyed()) {
    sender.send(ipcChannels.eventsPush, envelope);
  }
}

function cleanupSubscription(eventSubscriptions: Map<number, () => void>, subscriptionId: number): void {
  const unsubscribe = eventSubscriptions.get(subscriptionId);
  if (unsubscribe) {
    eventSubscriptions.delete(subscriptionId);
    unsubscribe();
  }
}

function registerSenderSubscription(
  senderSubscriptions: WeakMap<WebContents, Set<number>>,
  eventSubscriptions: Map<number, () => void>,
  sender: WebContents,
  subscriptionId: number,
): void {
  let subscriptions = senderSubscriptions.get(sender);
  if (!subscriptions) {
    subscriptions = new Set<number>();
    senderSubscriptions.set(sender, subscriptions);
    sender.once("destroyed", () => {
      const current = senderSubscriptions.get(sender);
      if (!current) {
        return;
      }
      for (const id of Array.from(current)) {
        cleanupSubscription(eventSubscriptions, id);
      }
      current.clear();
      senderSubscriptions.delete(sender);
    });
  }
  subscriptions.add(subscriptionId);
}

function unregisterSenderSubscription(senderSubscriptions: WeakMap<WebContents, Set<number>>, sender: WebContents, subscriptionId: number): void {
  const subscriptions = senderSubscriptions.get(sender);
  if (!subscriptions) {
    return;
  }
  subscriptions.delete(subscriptionId);
  if (subscriptions.size === 0) {
    senderSubscriptions.delete(sender);
  }
}
