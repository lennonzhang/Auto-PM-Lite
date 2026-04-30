import { loadConfig } from "./core/config.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { AppDatabase } from "./storage/db.js";
import { ClaudeRuntimeAdapter } from "./runtime/claude.js";
import { CodexRuntimeAdapter } from "./runtime/codex.js";

export async function openOrchestrator(configPath: string): Promise<Orchestrator> {
  const config = await loadConfig(configPath);
  const db = new AppDatabase({
    dbPath: config.storage.dbPath,
    busyTimeoutMs: config.storage.busyTimeoutMs,
  });
  let orchestrator: Orchestrator;
  const claude = new ClaudeRuntimeAdapter({
    config,
    createMcpHandlers: (taskId) => orchestrator.createMcpHandlers(taskId),
    requestApproval: (input) => orchestrator.requestCapability(input),
  });
  const codex = new CodexRuntimeAdapter({
    config,
    configPath,
  });
  orchestrator = new Orchestrator(config, db, {
    claude,
    codex,
  });
  orchestrator.syncConfig();
  return orchestrator;
}
