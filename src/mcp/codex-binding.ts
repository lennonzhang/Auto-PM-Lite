import path from "node:path";
import process from "node:process";
import type { AppConfig } from "../core/types.js";

export interface CodexMcpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export function createCodexMcpServerConfig(input: {
  config: AppConfig;
  configPath: string;
  taskId: string;
  cwd?: string | undefined;
  entrypointPath?: string | undefined;
}): CodexMcpServerConfig {
  return {
    command: process.execPath,
    args: [
      ...process.execArgv,
      resolveCliEntrypoint(input.entrypointPath),
      "mcp:serve-stdio",
      "--config",
      path.resolve(input.configPath),
      "--task",
      input.taskId,
    ],
    cwd: input.cwd ?? process.cwd(),
    env: buildCodexMcpServerEnv(input.config),
  };
}

export function buildCodexMcpServerEnv(config: AppConfig): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  for (const account of Object.values(config.accounts)) {
    if (!account.secretRef.startsWith("env:")) {
      continue;
    }

    const envName = account.secretRef.slice(4);
    const value = process.env[envName];
    if (value) {
      env[envName] = value;
    }
  }

  return env;
}

function resolveCliEntrypoint(entrypointPath?: string | undefined): string {
  const entrypoint = entrypointPath ?? process.argv[1];
  if (!entrypoint) {
    throw new Error("Unable to resolve CLI entrypoint for Codex MCP server");
  }

  return path.resolve(entrypoint);
}
