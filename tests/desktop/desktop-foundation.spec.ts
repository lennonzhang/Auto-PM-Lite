import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(config.policies.network_edit?.networkAllowed).toBe(true);
    expect(config.policies.full_access?.sandboxMode).toBe("danger-full-access");
    expect(config.accounts.anthropic_env?.secretRef).toBe("env:ANTHROPIC_API_KEY");
    expect(config.accounts.openai_env?.vendor).toBe("openai-compatible");
    expect(Object.keys(config.profiles)).toEqual([
      "claude_readonly",
      "claude_default",
      "claude_accept_edits",
      "claude_auto",
      "claude_plan",
      "claude_bypass_permissions",
      "codex_plan",
      "codex_edit",
      "codex_untrusted",
      "codex_never",
      "codex_on_failure",
      "codex_network",
      "codex_danger_full_access",
    ]);
    expect(config.profiles.claude_auto).toMatchObject({
      runtime: "claude",
      claudePermissionMode: "auto",
      allowedModels: ["claude-opus-4-7", "claude-opus-4-6"],
    });
    expect(config.profiles.claude_bypass_permissions).toMatchObject({
      runtime: "claude",
      policyId: "full_access",
      claudePermissionMode: "bypassPermissions",
    });
    expect(config.profiles.codex_plan).toMatchObject({
      runtime: "codex",
      policyId: "readonly",
      codexSandboxMode: "read-only",
      codexApprovalPolicy: "on-request",
    });
    expect(config.profiles.codex_danger_full_access).toMatchObject({
      runtime: "codex",
      policyId: "full_access",
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "never",
      codexNetworkAccessEnabled: true,
    });
  });

  it("overwrites previously generated default configs with the current preset set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-desktop-"));
    const configPath = path.join(root, "config.toml");

    await fs.writeFile(configPath, `# Auto-PM Lite default config

[storage]
db_path = "${path.join(root, "old.db").replace(/\\/g, "/")}"

[workspace]
root_dir = "${path.join(root, "old-workspaces").replace(/\\/g, "/")}"

[policy.readonly]
permission_mode = "read-only"
sandbox_mode = "read-only"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 1
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[account.anthropic_env]
vendor = "anthropic"
secret_ref = "env:ANTHROPIC_API_KEY"

[profile.claude_readonly]
runtime = "claude"
account = "anthropic_env"
policy = "readonly"
model = "old-model"
claude_permission_mode = "dontAsk"
`, "utf8");

    await ensureDefaultConfig(configPath);

    const raw = await fs.readFile(configPath, "utf8");
    const config = await loadConfig(configPath);
    expect(raw).toContain("[profile.claude_auto]");
    expect(raw).toContain("[profile.codex_danger_full_access]");
    expect(raw).not.toContain("old-model");
    expect(Object.keys(config.profiles)).toContain("claude_bypass_permissions");
    expect(Object.keys(config.profiles)).toContain("codex_network");
  });

  it("keeps IPC channels typed, supports replay subscriptions, and avoids raw secret/env channels", () => {
    expect(Object.values(ipcChannels)).toEqual(expect.arrayContaining([
      "config:get",
      "tasks:list",
      "tasks:get",
      "tasks:result",
      "tasks:run",
      "tasks:pause",
      "runtime:health",
      "runtime:probe-live",
      "workspace:diff",
      "logs:open",
      "events:replay-subscribe",
      "events:unsubscribe",
      "events:push",
    ]));
    expect(Object.values(ipcChannels).some((channel) => channel.includes("secret"))).toBe(false);
    expect(Object.values(ipcChannels).some((channel) => channel.includes("env"))).toBe(false);
  });

  it("keeps desktop dev script launching the full Electron app", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.["desktop:dev"]).toBe("tsx spikes/desktop-dev.ts");
    expect(manifest.scripts?.["desktop:renderer:dev"]).toBe("vite --config src/desktop/renderer/vite.config.ts");
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
      profileIds: ["claude_readonly"],
      profiles: [{
        id: "claude_readonly",
        runtime: "claude",
        model: "claude-opus-4-7",
        allowedModels: ["claude-opus-4-7"],
        policyId: "readonly",
        claudePermissionMode: "dontAsk",
      }],
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
        getTask: () => {
          throw new Error("not used");
        },
        getTaskResult: () => ({
          taskId: "task-1",
          status: "completed",
          runtime: "claude",
          profileId: "claude_readonly",
          model: "claude-opus-4-7",
          artifacts: [],
          pendingApprovalIds: [],
        }),
        createTask: async () => {
          throw new Error("not used");
        },
        runTask: async () => ({ ok: true, taskId: "task-1" }),
        resumeTask: async () => ({ ok: true, taskId: "task-1", resumed: true }),
        pauseTask: async () => ({ ok: true, taskId: "task-1", paused: true }),
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
        getHealth: () => [{
          runtime: "claude",
          profiles: ["claude_readonly"],
          available: true,
          staticChecks: [],
          capabilityChecks: [],
        }],
        assertCanRunTask: () => {},
        probeLive: async () => [{
          runtime: "claude",
          profiles: ["claude_readonly"],
          available: true,
          staticChecks: [],
          capabilityChecks: [],
        }],
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
    const taskResult = await handlers.get(ipcChannels.tasksResult)!(fakeEvent, { requesterTaskId: "task-1", taskId: "task-1" });
    expect(taskResult).toMatchObject({ taskId: "task-1", pendingApprovalIds: [] });
    const probeResult = await handlers.get(ipcChannels.runtimeProbeLive)!(fakeEvent);
    expect(probeResult).toHaveLength(1);

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

  it("registers a handler for every request channel", () => {
    const handlers = new Map<string, Parameters<Pick<IpcMain, "handle">["handle"]>[1]>();
    const services = {
      config: { getMetadata: () => ({}) },
      tasks: {
        listTasks: () => [],
        getTask: () => ({}),
        getTaskResult: () => ({}),
        createTask: async () => ({}),
        runTask: async () => ({}),
        resumeTask: async () => ({}),
        pauseTask: async () => ({}),
        cancelTask: async () => ({}),
      },
      approvals: {
        listApprovals: () => [],
        resolveApproval: async () => ({}),
      },
      workspaces: {
        listChanges: () => [],
        getDiff: () => ({}),
        requestMerge: async () => ({}),
        applyMerge: async () => ({}),
        discard: async () => ({}),
      },
      runtime: { getHealth: () => [], assertCanRunTask: () => {}, probeLive: async () => [] },
      events: {
        replayAndSubscribe: async () => ({ lastReplayedId: 0, unsubscribe: () => {} }),
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
      getLogDir: () => "D:/tmp/logs",
    });

    const requestChannels = Object.values(ipcChannels).filter((channel) => channel !== ipcChannels.eventsPush);
    expect(Array.from(handlers.keys()).sort()).toEqual(requestChannels.sort());
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

  it("accepts runtime jobs without waiting for completion and keeps them running after renderer destruction", async () => {
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
      runtime: {
        assertCanRunTask: () => {},
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

    const accepted = await runPromise;
    expect(accepted).toMatchObject({ ok: true, accepted: true, taskId: "task-1", action: "run" });
    expect(jobCompleted).toBe(false);
    expect(unsubscribed).toBe(true);
    await runningJob;
    expect(jobCompleted).toBe(true);
  });

  it("accepts pause actions through the desktop job runner", async () => {
    const handlers = new Map<string, Parameters<Pick<IpcMain, "handle">["handle"]>[1]>();
    let paused = false;
    const services = {
      tasks: {
        pauseTask: async () => {
          paused = true;
          return { ok: true, taskId: "task-1", paused: true };
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

    const accepted = await handlers.get(ipcChannels.tasksPause)!({} as IpcMainInvokeEvent, "task-1");
    expect(accepted).toMatchObject({ ok: true, accepted: true, taskId: "task-1", action: "pause" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paused).toBe(true);
  });

  it("keeps renderer source isolated from Node, Electron, services, and runtime imports", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const rendererRoot = path.join(repoRoot, "src", "desktop", "renderer", "src");
    const files = await fs.readdir(rendererRoot);
    const source = await Promise.all(files.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx")).map(async (file) => ({
      file,
      text: await fs.readFile(path.join(rendererRoot, file), "utf8"),
    })));

    for (const entry of source) {
      expect(entry.text, entry.file).not.toMatch(/from ["'](?:node:|electron|fs|path|child_process)/);
      expect(entry.text, entry.file).not.toMatch(/from ["'].*(?:service|runtime|storage|orchestrator)\//);
    }
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
    expect(paths.runtimeLogPath).toBe(path.join(paths.logDir, "runtime.log"));
    expect(paths.auditLogPath).toBe(path.join(paths.logDir, "audit.log"));
    expect(await fs.readFile(paths.mainLogPath, "utf8")).toContain("desktop.logging_initialized");
  });
});
