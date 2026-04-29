import process from "node:process";
import { Codex } from "@openai/codex-sdk";

const prompt = process.argv.slice(2).join(" ") || "If the MCP server is available, call delegate_to once to ask claude to review README.md.";

const codex = new Codex({
  env: safeEnv(),
  config: {
    model_provider: "openai",
    mcp_servers: {
      auto_pm_lite: {
        type: "stdio",
        command: "pnpm",
        args: ["tsx", "spikes/mcp-stdio-placeholder.ts"],
      },
    },
  },
});

const thread = codex.startThread({
  workingDirectory: process.cwd(),
  approvalPolicy: "never",
  sandboxMode: "read-only",
  skipGitRepoCheck: true,
});

const streamed = await thread.runStreamed(prompt);
for await (const event of streamed.events) {
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}

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
