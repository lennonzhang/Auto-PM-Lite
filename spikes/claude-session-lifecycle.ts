import process from "node:process";
import { ClaudeRuntimeAdapter } from "../src/runtime/claude.js";
import type { AppConfig } from "../src/core/types.js";
import type { RuntimeAdapterOutput } from "../src/runtime/adapter.js";

const config = buildConfig();
const adapter = new ClaudeRuntimeAdapter({
  config,
  configPath: "D:/tmp/auto-pm-lite/config.toml",
  sourceEnv: process.env,
});

const taskId = "live-claude-session-lifecycle";
const sessionId = `live-claude-session-${process.pid}`;
const cwd = process.cwd();

try {
  const opened = await adapter.openSession({
    taskId,
    sessionId,
    profileId: "claude_live",
    model: process.env.AUTO_PM_CLAUDE_MODEL ?? "claude-sonnet-4-6",
    cwd,
  });

  const first = await runTurn("turn-1", "Reply with exactly FIRST.");
  const firstThread = first.backendThreadId ?? opened.backendThreadId;
  if (!firstThread) {
    throw new Error("missing_backend_thread_after_first_turn");
  }

  const reopened = await adapter.openSession({
    taskId,
    sessionId,
    profileId: "claude_live",
    model: process.env.AUTO_PM_CLAUDE_MODEL ?? "claude-sonnet-4-6",
    cwd,
    backendThreadId: firstThread,
  });
  if (reopened.backendThreadId !== firstThread) {
    throw new Error(`backend_thread_changed_on_live_reopen:${firstThread}->${reopened.backendThreadId ?? ""}`);
  }

  const second = await runTurn("turn-2", "Reply with exactly SECOND.");
  if (second.backendThreadId !== firstThread) {
    throw new Error(`backend_thread_changed_on_second_turn:${firstThread}->${second.backendThreadId ?? ""}`);
  }

  const interrupted = runTurn("turn-3", "Count slowly from 1 to 20, one number per line.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await adapter.interruptTurn({ sessionId, backendThreadId: firstThread });
  await interrupted.catch(() => undefined);
  if (!adapter.hasLiveSession(sessionId)) {
    throw new Error("live_session_missing_after_interrupt");
  }

  const afterInterrupt = await runTurn("turn-4", "Reply with exactly AFTER.");
  if (afterInterrupt.backendThreadId !== firstThread) {
    throw new Error(`backend_thread_changed_after_interrupt:${firstThread}->${afterInterrupt.backendThreadId ?? ""}`);
  }

  await adapter.terminateSession({ sessionId, backendThreadId: firstThread });
  if (adapter.hasLiveSession(sessionId)) {
    throw new Error("live_session_still_present_after_terminate");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    backendThreadId: firstThread,
    first: first.text,
    second: second.text,
    afterInterrupt: afterInterrupt.text,
  }, null, 2)}\n`);
} finally {
  await adapter.shutdown();
}

async function runTurn(turnId: string, prompt: string): Promise<{ backendThreadId?: string | undefined; text: string }> {
  let backendThreadId: string | undefined;
  const texts: string[] = [];
  for await (const output of adapter.runTurn({
    taskId,
    sessionId,
    turnId,
    profileId: "claude_live",
    model: process.env.AUTO_PM_CLAUDE_MODEL ?? "claude-sonnet-4-6",
    cwd,
    prompt,
  })) {
    for (const event of outputEvents(output)) {
      if (event.kind === "session.backend_thread") {
        backendThreadId = event.backendThreadId;
      }
      if (event.kind === "item.updated" && event.patch.op === "append_text") {
        texts.push(event.patch.value);
      }
      if (event.kind === "item.completed" && event.itemKind === "assistant_message") {
        texts.push(event.finalPayload.text);
      }
      if (event.kind === "turn.failed") {
        throw new Error(event.error.message);
      }
      if (event.kind === "task.failed" || event.kind === "task.interrupted") {
        throw new Error(event.error.message);
      }
    }
  }
  return { backendThreadId, text: texts.join("") };
}

function outputEvents(output: RuntimeAdapterOutput) {
  return "events" in output ? output.events : [output.event];
}

function buildConfig(): AppConfig {
  return {
    accounts: {
      anthropic: {
        id: "anthropic",
        vendor: "anthropic",
        secretRef: process.env.ANTHROPIC_AUTH_TOKEN ? "env:ANTHROPIC_AUTH_TOKEN" : "env:ANTHROPIC_API_KEY",
      },
    },
    policies: {
      readonly: {
        id: "readonly",
        permissionMode: "read-only",
        sandboxMode: "read-only",
        networkAllowed: false,
        approvalPolicy: "never",
        requireApprovalFor: [],
        maxDepth: 3,
        allowCrossHarnessDelegation: false,
        allowChildEdit: false,
        allowChildNetwork: false,
      },
    },
    profiles: {
      claude_live: {
        id: "claude_live",
        runtime: "claude",
        accountId: "anthropic",
        policyId: "readonly",
        model: process.env.AUTO_PM_CLAUDE_MODEL ?? "claude-sonnet-4-6",
        claudePermissionMode: "default",
      },
    },
    redaction: { additionalPatterns: [] },
    transcript: { storeRawEncrypted: false },
    storage: {
      dbPath: "D:/tmp/auto-pm-lite-live.db",
      busyTimeoutMs: 1000,
      maxQueueSize: 100,
      flushBatchSize: 10,
    },
    workspace: {
      rootDir: "D:/tmp/auto-pm-lite-workspaces",
      topLevelUseWorktree: false,
    },
    scheduler: {
      maxConcurrentTasksGlobal: 5,
      maxConcurrentTasksPerAccount: 2,
    },
    rateLimit: {
      enabled: false,
    },
  };
}
