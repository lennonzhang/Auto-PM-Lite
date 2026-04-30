import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";

const prompt = process.argv.slice(2).join(" ") || "Create a file named approval-check.txt with the text hello.";
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-codex-approval-"));

const codex = new Codex({
  env: safeEnv(),
  ...(process.env.AUTO_PM_CODEX_BASE_URL ? { baseUrl: process.env.AUTO_PM_CODEX_BASE_URL } : {}),
});

const thread = codex.startThread({
  workingDirectory: cwd,
  ...(process.env.AUTO_PM_CODEX_MODEL ? { model: process.env.AUTO_PM_CODEX_MODEL } : {}),
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  modelReasoningEffort: "low",
  skipGitRepoCheck: true,
});

const streamed = await thread.runStreamed(prompt);
for await (const event of streamed.events) {
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}
process.stdout.write(`SMOKE_CWD=${cwd}\n`);

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
