#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import { defaultConfigPath, loadConfig } from "./core/config.js";
import { openOrchestrator } from "./app.js";
import { runStdioMcpServer } from "./mcp/stdio-server.js";
import { categorizeApproval } from "./core/types.js";

const program = new Command();

program
  .name("auto-pm-lite")
  .description("TypeScript control plane for Claude and Codex runtimes")
  .version("0.1.0");

program
  .command("config:show")
  .description("Load and print config metadata")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config }) => {
    const loaded = await loadConfig(config);
    const summary = {
      accounts: Object.keys(loaded.accounts),
      policies: Object.keys(loaded.policies),
      profiles: Object.keys(loaded.profiles),
      storage: loaded.storage,
      workspace: loaded.workspace,
      transcript: loaded.transcript,
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  });

program
  .command("task:new")
  .description("Create a queued task record")
  .requiredOption("-p, --profile <id>", "Profile ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .option("--cwd <path>", "Task working directory", process.cwd())
  .option("-n, --name <name>", "Optional task name")
  .action(async ({ config, cwd, name, profile }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      const task = await orchestrator.createTask({
        profileId: profile,
        cwd,
        name,
      });

      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:list")
  .description("List persisted tasks")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      process.stdout.write(`${JSON.stringify(orchestrator.listTasks(), null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:get")
  .description("Get one persisted task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      process.stdout.write(`${JSON.stringify(orchestrator.getTask(task), null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:turns")
  .description("List persisted turns for a task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      process.stdout.write(`${JSON.stringify(orchestrator.listTurns(task), null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:artifacts")
  .description("List artifacts for a task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      process.stdout.write(`${JSON.stringify(orchestrator.listArtifacts(task), null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("approval:list")
  .description("List approvals (annotated with category)")
  .option("-t, --task <id>", "Optional task ID filter")
  .option("--category <category>", "Filter by category: tool_approval | privilege_escalation | clarification | capability_request")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ category, config, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      const annotated = orchestrator.listApprovals(task).map((approval) => ({
        ...approval,
        category: categorizeApproval(approval.kind),
      }));
      const filtered = category ? annotated.filter((entry) => entry.category === category) : annotated;
      process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("approval:resolve")
  .description("Resolve an approval")
  .requiredOption("-a, --approval <id>", "Approval ID")
  .requiredOption("-d, --decision <approved|denied>", "Approval decision")
  .option("-r, --reason <text>", "Optional resolution reason")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ approval, config, decision, reason }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      await orchestrator.resolveApproval({
        approvalId: approval,
        approved: decision === "approved",
        reason,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, approvalId: approval, decision }, null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:result")
  .description("Get task result snapshot visible to a requester")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-r, --requester <id>", "Requester task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, requester, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      process.stdout.write(`${JSON.stringify(orchestrator.getTaskResult(requester, task), null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:run")
  .description("Run one queued task turn")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-m, --message <prompt>", "Prompt to send to the runtime")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      await orchestrator.runTask({
        taskId: task,
        prompt: message,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, taskId: task }, null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:resume")
  .description("Resume an interrupted task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-m, --message <prompt>", "Optional prompt override")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      await orchestrator.resumeTask({
        taskId: task,
        prompt: message,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, taskId: task, resumed: true }, null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("task:cancel")
  .description("Cancel a running or interrupted task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      await orchestrator.cancelTask(task);
      process.stdout.write(`${JSON.stringify({ ok: true, taskId: task, cancelled: true }, null, 2)}\n`);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command("mcp:serve-stdio")
  .description("Serve the Auto-PM MCP surface over stdio for Codex")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    await runStdioMcpServer(config, task);
  });

program
  .command("events:stream")
  .description("Replay persisted events then stream live events from the orchestrator")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .option("-t, --task <id>", "Optional task ID filter")
  .option("--since-id <number>", "Resume after a given event id (defaults to 0 = full history)")
  .option("--no-replay", "Skip historical replay and only stream live events")
  .action(async ({ config, task, sinceId, replay }) => {
    const orchestrator = await openOrchestrator(config);

    try {
      const writer = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
      let unsubscribe: () => void;

      if (replay !== false) {
        const result = await orchestrator.replayAndSubscribe({
          taskId: task,
          sinceId: sinceId ? Number(sinceId) : undefined,
          listener: writer,
        });
        unsubscribe = result.unsubscribe;
      } else {
        unsubscribe = orchestrator.subscribeToEvents((event) => {
          if (!task || event.taskId === task) {
            writer(event);
          }
        });
      }

      process.on("SIGINT", () => {
        unsubscribe();
        orchestrator.close().then(() => process.exit(0));
      });

      await new Promise(() => {});
    } catch (error) {
      await orchestrator.close();
      throw error;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
