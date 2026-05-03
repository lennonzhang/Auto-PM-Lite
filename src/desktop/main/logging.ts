import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactText, type RedactionOptions } from "../../core/redaction.js";

export interface DesktopLogPaths {
  logDir: string;
  mainLogPath: string;
  rendererLogPath: string;
  runtimeLogPath: string;
  auditLogPath: string;
  crashLogPath: string;
}

export interface DesktopLogApp {
  getPath(name: "userData"): string;
  setAppLogsPath?(logDir?: string): void;
}

export function resolveDesktopLogPaths(userDataPath: string): DesktopLogPaths {
  const logDir = path.join(userDataPath, "logs");
  return {
    logDir,
    mainLogPath: path.join(logDir, "main.log"),
    rendererLogPath: path.join(logDir, "renderer.log"),
    runtimeLogPath: path.join(logDir, "runtime.log"),
    auditLogPath: path.join(logDir, "audit.log"),
    crashLogPath: path.join(logDir, "crash.log"),
  };
}

export async function initializeDesktopLogging(app: DesktopLogApp): Promise<DesktopLogPaths> {
  const paths = resolveDesktopLogPaths(app.getPath("userData"));
  await fsp.mkdir(paths.logDir, { recursive: true });
  app.setAppLogsPath?.(paths.logDir);
  await appendDesktopMainLog(paths, "desktop.logging_initialized");
  return paths;
}

export async function appendDesktopMainLog(paths: DesktopLogPaths, message: string): Promise<void> {
  await fsp.appendFile(paths.mainLogPath, `${formatLogLine(message)}`, "utf8");
}

export function appendDesktopMainLogSync(paths: DesktopLogPaths, message: string): void {
  fs.appendFileSync(paths.mainLogPath, formatLogLine(message), "utf8");
}

export function appendDesktopRuntimeLogSync(paths: DesktopLogPaths, message: string, redaction?: RedactionOptions): void {
  fs.appendFileSync(paths.runtimeLogPath, formatLogLine(redactText(message, redaction)), "utf8");
}

export function appendDesktopAuditLogSync(paths: DesktopLogPaths, message: string, redaction?: RedactionOptions): void {
  fs.appendFileSync(paths.auditLogPath, formatLogLine(redactText(message, redaction)), "utf8");
}

function formatLogLine(message: string): string {
  return `${new Date().toISOString()} ${message}\n`;
}
