import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { app, BrowserWindow, ipcMain } from "electron";
import { defaultConfigPath } from "../../core/config.js";
import { openAppServices, type AppServices } from "../../service/app-services.js";
import { runStdioMcpServer } from "../../mcp/stdio-server.js";
import { openDesktopSmokeServices } from "./smoke-services.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { appendDesktopAuditLogSync, appendDesktopMainLogSync, appendDesktopRuntimeLogSync, initializeDesktopLogging, type DesktopLogPaths } from "./logging.js";

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let eventSubscriptions = new Map<number, () => void>();
let nextEventSubscriptionId = 1;
let logPaths: DesktopLogPaths | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sidecarIndex = process.argv.indexOf("--auto-pm-mcp-stdio");
if (sidecarIndex !== -1) {
  const configPath = readArgValue("--config") ?? process.env.AUTO_PM_CONFIG_PATH ?? defaultConfigPath();
  const taskId = readArgValue("--task") ?? "__diagnostic__";
  await runStdioMcpServer(configPath, taskId);
  app.exit(0);
}

if (process.env.AUTO_PM_DESKTOP_USER_DATA) {
  fs.mkdirSync(process.env.AUTO_PM_DESKTOP_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.AUTO_PM_DESKTOP_USER_DATA);
}

async function getServices(): Promise<AppServices> {
  if (!services) {
    const configPath = process.env.AUTO_PM_CONFIG_PATH ?? defaultConfigPath();
    if (process.env.AUTO_PM_DESKTOP_FAKE_RUNTIME === "1") {
      services = await openDesktopSmokeServices(configPath);
      return services;
    }
    services = await openAppServices(configPath, {
      runtimeLog: (message) => {
        if (logPaths) {
          appendDesktopRuntimeLogSync(logPaths, message, { additionalPatterns: services?.orchestrator.configRedactionPatterns() ?? [] });
        }
      },
    });
  }
  return services;
}

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, "../preload/index.cjs");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Auto-PM Lite",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  installDesktopSmokeHooks(mainWindow);

  if (process.env.AUTO_PM_DESKTOP_DEV_SERVER) {
    await mainWindow.loadURL(process.env.AUTO_PM_DESKTOP_DEV_SERVER);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

}

app.whenReady().then(async () => {
  logPaths = await initializeDesktopLogging(app);
  process.env.AUTO_PM_DESKTOP_LOG_DIR = logPaths.logDir;
  eventSubscriptions = registerIpcHandlers(ipcMain, {
    getServices,
    getNextSubscriptionId: () => nextEventSubscriptionId++,
    getLogDir: () => logPaths?.logDir ?? null,
    writeLog: (message) => {
      if (logPaths) {
        appendDesktopAuditLogSync(logPaths, message, { additionalPatterns: services?.orchestrator.configRedactionPatterns() ?? [] });
      }
    },
  });
  await createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (logPaths) {
    appendDesktopMainLogSync(logPaths, "desktop.before_quit");
  }
  for (const unsubscribe of eventSubscriptions.values()) {
    unsubscribe();
  }
  eventSubscriptions.clear();
});

app.on("quit", () => {
  void services?.close();
});

function installDesktopSmokeHooks(window: BrowserWindow): void {
  if (process.env.AUTO_PM_DESKTOP_SMOKE !== "1") {
    return;
  }

  const timeoutMs = Number(process.env.AUTO_PM_DESKTOP_SMOKE_TIMEOUT_MS ?? 15_000);
  const timeout = setTimeout(() => {
    process.stderr.write("AUTO_PM_DESKTOP_SMOKE_TIMEOUT\n");
    app.exit(1);
  }, timeoutMs);

  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    process.stderr.write(`AUTO_PM_DESKTOP_LOAD_FAILED ${errorCode} ${errorDescription}\n`);
    app.exit(1);
  });

  window.webContents.once("did-finish-load", () => {
    window.webContents.executeJavaScript(`
      (async () => {
        const wait = (predicate, label, timeoutMs = 8000) => new Promise((resolve, reject) => {
          const started = Date.now();
          const tick = () => {
            try {
              const value = predicate();
              if (value) {
                resolve(value);
                return;
              }
            } catch {}
            if (Date.now() - started > timeoutMs) {
              reject(new Error("Timed out waiting for " + label));
              return;
            }
            setTimeout(tick, 50);
          };
          tick();
        });
        const click = async (selector) => {
          const element = await wait(() => document.querySelector(selector), selector);
          element.click();
        };
        const setValue = async (selector, value) => {
          const element = await wait(() => document.querySelector(selector), selector);
          const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
          if (setter) {
            setter.call(element, value);
          } else {
            element.value = value;
          }
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        try {
          if (!window.autoPm) {
            return { ok: false, message: "window.autoPm is unavailable" };
          }
          const [config, tasks, health] = await Promise.all([
            window.autoPm.getConfig(),
            window.autoPm.listTasks(),
            window.autoPm.getRuntimeHealth()
          ]);
          const result = {
            ok: true,
            apiVersion: config.apiVersion,
            taskCount: tasks.length,
            runtimeCount: health.length
          };
          if (window.location.protocol === "file:" && ${JSON.stringify(process.env.AUTO_PM_DESKTOP_FAKE_RUNTIME === "1")}) {
            await wait(() => {
              const button = document.querySelector("[data-testid=create-task]");
              return button && !button.disabled;
            }, "create form ready");
            await setValue("[data-testid=new-task-profile]", "claude_edit");
            await setValue("[data-testid=new-task-name]", "desktop smoke");
            await setValue("[data-testid=new-task-cwd]", config.workspace.rootDir + "/repo");
            await wait(() => {
              const button = document.querySelector("[data-testid=create-task]");
              const cwd = document.querySelector("[data-testid=new-task-cwd]");
              const profile = document.querySelector("[data-testid=new-task-profile]");
              return button && cwd && profile && cwd.value.endsWith("/repo") && profile.value === "claude_edit" && !button.disabled;
            }, "create form populated");
            await click("[data-testid=create-task]");
            await wait(async () => (await window.autoPm.listTasks()).length > tasks.length, "created task");
            await setValue("[data-testid=run-prompt]", "run desktop smoke");
            await click("[data-testid=run-task]");
            const parentId = (await window.autoPm.listTasks())[0]?.id;
            await wait(async () => parentId && (await window.autoPm.getTask(parentId)).status === "completed", "task completed");
            const childA = await window.autoPm.createSmokeChildTask({ parentTaskId: parentId, targetProfileId: "codex_edit", name: "merge child" });
            await wait(async () => (await window.autoPm.getTask(childA.id)).status === "completed", "child merge completed");
            const mergeRequest = await window.autoPm.requestWorkspaceMerge({ taskId: childA.id, reason: "desktop smoke merge" });
            await window.autoPm.resolveApproval({ approvalId: mergeRequest.approvalId, approved: true });
            await window.autoPm.applyWorkspaceMerge({ taskId: childA.id, approvalId: mergeRequest.approvalId });
            const childB = await window.autoPm.createSmokeChildTask({ parentTaskId: parentId, targetProfileId: "codex_edit", name: "discard child" });
            await wait(async () => (await window.autoPm.getTask(childB.id)).status === "completed", "child discard completed");
            await window.autoPm.discardWorkspace(childB.id);
            const replayed = [];
            const subscription = await window.autoPm.replayAndSubscribeToEvents({}, (event) => replayed.push(event));
            subscription.unsubscribe();
            result.taskCount = (await window.autoPm.listTasks()).length;
            result.eventReplayCount = replayed.length;
            result.fakeFlow = true;
          }
          return result;
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            name: error instanceof Error ? error.name : undefined
          };
        }
      })()
    `).then((result) => {
      if (!result?.ok) {
        throw new Error(`${result?.name ? `${result.name}: ` : ""}${result?.message ?? "unknown IPC failure"}`);
      }
      clearTimeout(timeout);
      process.stdout.write(`AUTO_PM_DESKTOP_READY ${JSON.stringify(result)}\n`);
      setTimeout(() => app.quit(), 50);
    }).catch((error) => {
      clearTimeout(timeout);
      process.stderr.write(`AUTO_PM_DESKTOP_IPC_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(1);
    });
  });
}

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}
