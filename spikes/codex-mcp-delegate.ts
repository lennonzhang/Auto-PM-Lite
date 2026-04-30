import process from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";

const prompt = process.argv.slice(2).join(" ") || "Call the MCP tool named delegate_to from server auto_pm_lite exactly once with targetRuntime='claude' and prompt='review README.md'. Then report the tool result.";
const smokeServerPath = fileURLToPath(new URL("./mcp-stdio-smoke-server.mjs", import.meta.url));
const smokeLogPath = path.join(os.tmpdir(), `auto-pm-lite-mcp-smoke-${process.pid}.log`);

const codex = new Codex({
  env: safeEnv(),
  ...(process.env.AUTO_PM_CODEX_BASE_URL ? { baseUrl: process.env.AUTO_PM_CODEX_BASE_URL } : {}),
  config: {
    ...(process.env.AUTO_PM_CODEX_BASE_URL
      ? {
          model_provider: "auto_pm_smoke",
          model_providers: {
            auto_pm_smoke: {
              base_url: process.env.AUTO_PM_CODEX_BASE_URL,
              env_key: "OPENAI_API_KEY",
            },
          },
        }
      : {}),
    mcp_servers: {
      auto_pm_lite: {
        enabled: true,
        startup_timeout_sec: 30,
        command: process.execPath,
        args: [smokeServerPath],
        cwd: process.cwd(),
        env: { ...safeEnv(), AUTO_PM_MCP_SMOKE_LOG: smokeLogPath },
      },
    },
  },
});

const thread = codex.startThread({
  workingDirectory: process.cwd(),
  ...(process.env.AUTO_PM_CODEX_MODEL ? { model: process.env.AUTO_PM_CODEX_MODEL } : {}),
  approvalPolicy: "on-request",
  sandboxMode: "read-only",
  modelReasoningEffort: "low",
  skipGitRepoCheck: true,
});

const streamed = await thread.runStreamed(prompt);
for await (const event of streamed.events) {
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}
process.stdout.write(`MCP_SMOKE_LOG=${smokeLogPath}\n`);

function safeEnv(): Record<string, string> {
  const allowedKeys = ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "OPENAI_API_KEY", "CODEX_API_KEY"];
  const env: Record<string, string> = {};

  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return env;
}
