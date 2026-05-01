import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { app, BrowserWindow, ipcMain } from "electron";
import { defaultConfigPath } from "../../core/config.js";
import { openAppServices, type AppServices } from "../../service/app-services.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { appendDesktopMainLogSync, initializeDesktopLogging, type DesktopLogPaths } from "./logging.js";

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let eventSubscriptions = new Map<number, () => void>();
let nextEventSubscriptionId = 1;
let logPaths: DesktopLogPaths | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.AUTO_PM_DESKTOP_USER_DATA) {
  fs.mkdirSync(process.env.AUTO_PM_DESKTOP_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.AUTO_PM_DESKTOP_USER_DATA);
}

async function getServices(): Promise<AppServices> {
  if (!services) {
    services = await openAppServices(process.env.AUTO_PM_CONFIG_PATH ?? defaultConfigPath());
  }
  return services;
}

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, "../preload/index.js");
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
    clearTimeout(timeout);
    process.stdout.write("AUTO_PM_DESKTOP_READY\n");
    setTimeout(() => app.quit(), 50);
  });
}
