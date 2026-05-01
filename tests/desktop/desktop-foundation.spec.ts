import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDefaultConfig } from "../../src/service/app-services.js";
import { ipcChannels } from "../../src/desktop/shared/ipc.js";
import { loadConfig } from "../../src/core/config.js";
import { registerIpcHandlers } from "../../src/desktop/main/ipc-handlers.js";
import { initializeDesktopLogging, resolveDesktopLogPaths } from "../../src/desktop/main/logging.js";
import type { AppServices } from "../../src/service/app-services.js";
import type { ConfigMetadata, ErrorEnvelope, EventEnvelope } from "../../src/api/types.js";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

describe("desktop foundation", () => {
  it("bootstraps a safe default config without plaintext secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-desktop-"));
    const configPath = path.join(root, "config.toml");

    await ensureDefaultConfig(configPath);

    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).toContain("[policy.readonly]");
    expect(raw).toContain("[policy.edit]");
    expect(raw).toContain('secret_ref = "env:ANTHROPIC_API_KEY"');
    expect(raw).toContain('secret_ref = "env:OPENAI_API_KEY"');
    expect(raw).toContain("allow_child_edit = false");
    expect(raw).not.toContain("OPENAI_API_KEY =");
    expect(raw).not.toContain("ANTHROPIC_API_KEY =");
    const config = await loadConfig(configPath);
    expect(config.policies.edit?.sandboxMode).toBe("workspace-write");
    expect(config.accounts.anthropic_env?.secretRef).toBe("env:ANTHROPIC_API_KEY");
  });

  it("keeps IPC channels typed, supports replay subscriptions, and avoids raw secret/env channels", () => {
    expect(Object.values(ipcChannels)).toEqual(expect.arrayContaining([
      "config:get",
      "tasks:list",
      "tasks:run",
      "runtime:health",
      "workspace:diff",
      "events:replay-subscribe",
      "events:unsubscribe",
      "events:push",
    ]));
    expect(Object.values(ipcChannels).some((channel) => channel.includes("secret"))).toBe(false);
    expect(Object.values(ipcChannels).some((channel) => channel.includes("env"))).toBe(false);
  });

  it("routes replay event IPC through service without exposing env or secrets", async () => {
    type IpcHandler = Parameters<Pick<IpcMain, "handle">["handle"]>[1];
    const handlers = new Map<string, IpcHandler>();
    const sent: unknown[] = [];
    let unsubscribed = false;
    const configMetadata: ConfigMetadata = {
      apiVersion: 1,
      accounts: ["anthropic_env"],
      policies: ["readonly"],
      profiles: ["claude_readonly"],
      storage: {
        dbPath: "D:/tmp/auto-pm-lite.db",
        busyTimeoutMs: 5000,
      },
      workspace: {
        rootDir: "D:/tmp/workspaces",
        topLevelUseWorktree: true,
      },
    };
    const services = {
      config: {
        getMetadata: () => configMetadata,
      },
      tasks: {
        listTasks: () => [],
        createTask: async () => {
          throw new Error("not used");
        },
        runTask: async () => ({ ok: true, taskId: "task-1" }),
        resumeTask: async () => ({ ok: true, taskId: "task-1", resumed: true }),
        cancelTask: async () => ({ ok: true, taskId: "task-1", cancelled: true }),
      },
      approvals: {
        listApprovals: () => [],
        resolveApproval: async () => ({ ok: true }),
      },
      workspaces: {
        listChanges: () => [],
        getDiff: () => {
          throw new Error("not used");
        },
        requestMerge: async () => ({ approvalId: "a", workspaceId: "w" }),
        applyMerge: async () => {
          throw new Error("not used");
        },
        discard: async () => ({ ok: true }),
      },
      runtime: {
        getHealth: () => [{ runtime: "claude", profiles: ["claude_readonly"], available: true }],
      },
      events: {
        replayAndSubscribe: async (input: { listener: (event: EventEnvelope) => void }) => {
          input.listener({
            eventEnvelopeVersion: 1,
            id: 1,
            durable: true,
            event: { type: "task.queued", taskId: "task-1", ts: new Date().toISOString() },
          });
          return {
            lastReplayedId: 1,
            unsubscribe: () => {
              unsubscribed = true;
            },
          };
        },
      },
      close: async () => {},
    } as unknown as AppServices;

    registerIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    }, {
      getServices: async () => services,
      getNextSubscriptionId: () => 7,
    });

    const destroyedListeners: Array<() => void> = [];
    const fakeEvent = {
      sender: {
        isDestroyed: () => false,
        send: (_channel: string, payload: unknown) => {
          sent.push(payload);
        },
        once: (eventName: string, listener: () => void) => {
          if (eventName === "destroyed") {
            destroyedListeners.push(listener);
          }
          return fakeEvent.sender;
        },
      },
    } as unknown as IpcMainInvokeEvent;
    const replayResult = await handlers.get(ipcChannels.eventsReplaySubscribe)!(fakeEvent, { sinceId: 0 });
    expect(replayResult).toEqual({ subscriptionId: 7, lastReplayedId: 1 });
    expect(sent).toHaveLength(1);
    expect((sent[0] as EventEnvelope).id).toBe(1);

    const configResult = await handlers.get(ipcChannels.configGet)!(fakeEvent, undefined);
    expect(JSON.stringify(configResult)).not.toContain("API_KEY=");

    await handlers.get(ipcChannels.eventsUnsubscribe)!(fakeEvent, 7);
    expect(unsubscribed).toBe(true);
  });

  it("returns ErrorEnvelope values from failing IPC handlers", async () => {
    const handlers = new Map<string, Parameters<Pick<IpcMain, "handle">["handle"]>[1]>();
    const services = {
      config: {
        getMetadata: () => {
          throw new Error("Unknown task: missing");
        },
      },
      close: async () => {},
    } as unknown as AppServices;

    registerIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    }, {
      getServices: async () => services,
      getNextSubscriptionId: () => 1,
    });

    const result = await handlers.get(ipcChannels.configGet)!({} as IpcMainInvokeEvent);
    expect((result as ErrorEnvelope).apiVersion).toBe(1);
    expect((result as ErrorEnvelope).error.code).toBe("task_not_found");
  });

  it("cleans up replay subscriptions when renderer webContents is destroyed", async () => {
    const handlers = new Map<string, Parameters<Pick<IpcMain, "handle">["handle"]>[1]>();
    const destroyedListeners: Array<() => void> = [];
    let unsubscribeCount = 0;
    const services = {
      config: { getMetadata: () => ({}) },
      tasks: {},
      approvals: {},
      workspaces: {},
      runtime: { getHealth: () => [] },
      events: {
        replayAndSubscribe: async () => ({
          lastReplayedId: 0,
          unsubscribe: () => {
            unsubscribeCount += 1;
          },
        }),
      },
      close: async () => {},
    } as unknown as AppServices;

    registerIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    }, {
      getServices: async () => services,
      getNextSubscriptionId: (() => {
        let id = 0;
        return () => {
          id += 1;
          return id;
        };
      })(),
    });

    const fakeEvent = {
      sender: {
        isDestroyed: () => false,
        send: () => {},
        once: (eventName: string, listener: () => void) => {
          if (eventName === "destroyed") {
            destroyedListeners.push(listener);
          }
          return fakeEvent.sender;
        },
      },
    } as unknown as IpcMainInvokeEvent;

    await handlers.get(ipcChannels.eventsReplaySubscribe)!(fakeEvent, {});
    await handlers.get(ipcChannels.eventsReplaySubscribe)!(fakeEvent, {});
    expect(unsubscribeCount).toBe(0);
    destroyedListeners[0]!();
    expect(unsubscribeCount).toBe(2);
  });

  it("keeps active runtime jobs running when renderer subscriptions are destroyed", async () => {
    const handlers = new Map<string, Parameters<Pick<IpcMain, "handle">["handle"]>[1]>();
    const destroyedListeners: Array<() => void> = [];
    let jobCompleted = false;
    let unsubscribed = false;
    const runningJob = new Promise<{ ok: true; taskId: string }>((resolve) => {
      setTimeout(() => {
        jobCompleted = true;
        resolve({ ok: true, taskId: "task-1" });
      }, 10);
    });
    const services = {
      tasks: {
        runTask: async () => runningJob,
      },
      events: {
        replayAndSubscribe: async () => ({
          lastReplayedId: 0,
          unsubscribe: () => {
            unsubscribed = true;
          },
        }),
      },
      close: async () => {},
    } as unknown as AppServices;

    registerIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    }, {
      getServices: async () => services,
      getNextSubscriptionId: () => 1,
    });

    const fakeEvent = {
      sender: {
        isDestroyed: () => false,
        send: () => {},
        once: (eventName: string, listener: () => void) => {
          if (eventName === "destroyed") {
            destroyedListeners.push(listener);
          }
          return fakeEvent.sender;
        },
      },
    } as unknown as IpcMainInvokeEvent;

    const runPromise = handlers.get(ipcChannels.tasksRun)!(fakeEvent, { taskId: "task-1", prompt: "go" });
    await handlers.get(ipcChannels.eventsReplaySubscribe)!(fakeEvent, {});
    destroyedListeners[0]!();

    await expect(runPromise).resolves.toEqual({ ok: true, taskId: "task-1" });
    expect(unsubscribed).toBe(true);
    expect(jobCompleted).toBe(true);
  });

  it("initializes desktop log paths under userData", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-logs-"));
    let configuredLogPath: string | undefined;
    const paths = await initializeDesktopLogging({
      getPath: () => root,
      setAppLogsPath: (logDir) => {
        configuredLogPath = logDir;
      },
    });

    expect(paths).toEqual(resolveDesktopLogPaths(root));
    expect(configuredLogPath).toBe(paths.logDir);
    expect(await fs.readFile(paths.mainLogPath, "utf8")).toContain("desktop.logging_initialized");
  });
});
