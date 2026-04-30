import process from "node:process";
import { Codex } from "@openai/codex-sdk";

const prompt = process.argv.slice(2).join(" ") || "Reply with exactly OK.";

const codex = new Codex({
  env: safeEnv(),
  ...(process.env.AUTO_PM_CODEX_BASE_URL ? { baseUrl: process.env.AUTO_PM_CODEX_BASE_URL } : {}),
  ...(process.env.AUTO_PM_CODEX_BASE_URL
    ? {
      config: {
        model_provider: "auto_pm_smoke",
        model_providers: {
          auto_pm_smoke: {
            base_url: process.env.AUTO_PM_CODEX_BASE_URL,
            env_key: "OPENAI_API_KEY",
          },
        },
      },
    }
    : {}),
});

const thread = codex.startThread({
  workingDirectory: process.cwd(),
  ...(process.env.AUTO_PM_CODEX_MODEL ? { model: process.env.AUTO_PM_CODEX_MODEL } : {}),
  approvalPolicy: "never",
  sandboxMode: "read-only",
  modelReasoningEffort: "low",
  skipGitRepoCheck: true,
});

const streamed = await thread.runStreamed(prompt);

for await (const event of streamed.events) {
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}

if (thread.id) {
  process.stdout.write(`THREAD_ID=${thread.id}\n`);
  const resumed = codex.resumeThread(thread.id, {
    workingDirectory: process.cwd(),
    ...(process.env.AUTO_PM_CODEX_MODEL ? { model: process.env.AUTO_PM_CODEX_MODEL } : {}),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    modelReasoningEffort: "low",
    skipGitRepoCheck: true,
  });
  const resumedTurn = await resumed.run("Reply with exactly RESUMED.");
  process.stdout.write(`RESUME_FINAL=${resumedTurn.finalResponse.trim()}\n`);
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
