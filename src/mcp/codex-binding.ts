import path from "node:path";
import process from "node:process";
import type { AppConfig } from "../core/types.js";
import { buildMcpSidecarEnv } from "../runtime/env.js";

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
  sourceEnv?: NodeJS.ProcessEnv | undefined;
}): CodexMcpServerConfig {
  const entrypoint = resolveCliEntrypoint(input.entrypointPath);
  const electronSidecar = Boolean(process.versions.electron);
  return {
    command: process.execPath,
    args: electronSidecar
      ? [
          ...process.execArgv,
          entrypoint,
          "--auto-pm-mcp-stdio",
          "--config",
          path.resolve(input.configPath),
          "--task",
          input.taskId,
        ]
      : [
          ...process.execArgv,
          entrypoint,
          "mcp:serve-stdio",
          "--config",
          path.resolve(input.configPath),
          "--task",
          input.taskId,
        ],
    cwd: input.cwd ?? process.cwd(),
    env: buildCodexMcpServerEnv(input.config, input.sourceEnv),
  };
}

export function buildCodexMcpServerEnv(config: AppConfig, sourceEnv?: NodeJS.ProcessEnv | undefined): Record<string, string> {
  return buildMcpSidecarEnv(config, sourceEnv);
}

function resolveCliEntrypoint(entrypointPath?: string | undefined): string {
  const entrypoint = entrypointPath ?? process.argv[1];
  if (!entrypoint) {
    throw new Error("Unable to resolve CLI entrypoint for Codex MCP server");
  }

  return path.resolve(entrypoint);
}
