import process from "node:process";
import { Codex } from "@openai/codex-sdk";

const prompt = process.argv.slice(2).join(" ") || "List the markdown files in the current directory.";

const codex = new Codex({
  env: safeEnv(),
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

if (thread.id) {
  process.stdout.write(`THREAD_ID=${thread.id}\n`);
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
