#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import { defaultConfigPath } from "./core/config.js";
import { openAppServices } from "./service/app-services.js";
import { runStdioMcpServer } from "./mcp/stdio-server.js";
import { toErrorEnvelope } from "./api/types.js";

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
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.config.getMetadata(), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("runtime:health")
  .description("Print static runtime health metadata")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.runtime.getHealth(), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:new")
  .description("Create a queued task record")
  .requiredOption("-p, --profile <id>", "Profile ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .option("--cwd <path>", "Task working directory", process.cwd())
  .option("-n, --name <name>", "Optional task name")
  .option("--model <model>", "Model to use for this task")
  .action(async ({ config, cwd, name, profile, model }) => {
    const services = await openAppServices(config);

    try {
      const task = await services.tasks.createTask({
        profileId: profile,
        cwd,
        name,
        model,
      });

      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:list")
  .description("List persisted tasks")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.tasks.listTasks(), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:get")
  .description("Get one persisted task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.tasks.getTask(task), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:turns")
  .description("List persisted turns for a task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.tasks.listTurns(task), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:artifacts")
  .description("List artifacts for a task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.tasks.listArtifacts(task), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("workspace:changes")
  .description("List file changes for a task workspace")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.workspaces.listChanges(task), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("workspace:diff")
  .description("Get a redacted git diff for a task workspace")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.workspaces.getDiff(task), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("workspace:merge-request")
  .description("Request approval to merge a child workspace back to its parent")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-r, --reason <text>", "Merge reason")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, reason, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.workspaces.requestMerge({ taskId: task, reason });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("workspace:merge-apply")
  .description("Apply an approved child workspace merge")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-a, --approval <id>", "Approved workspace_merge approval ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ approval, config, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.workspaces.applyMerge({ taskId: task, approvalId: approval });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("workspace:discard")
  .description("Discard a child workspace")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.workspaces.discard(task);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("approval:list")
  .description("List approvals (annotated with category)")
  .option("-t, --task <id>", "Optional task ID filter")
  .option("--category <category>", "Filter by category: tool_approval | privilege_escalation | clarification | capability_request")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ category, config, task }) => {
    const services = await openAppServices(config);

    try {
      const annotated = services.approvals.listApprovals(task);
      const filtered = category ? annotated.filter((entry) => entry.category === category) : annotated;
      process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } finally {
      await services.close();
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
    const services = await openAppServices(config);

    try {
      const result = await services.approvals.resolveApproval({
        approvalId: approval,
        approved: decision === "approved",
        reason,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:result")
  .description("Get task result snapshot visible to a requester")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-r, --requester <id>", "Requester task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, requester, task }) => {
    const services = await openAppServices(config);

    try {
      process.stdout.write(`${JSON.stringify(services.tasks.getTaskResult(requester, task), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:run")
  .description("Run one queued task turn")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-m, --message <prompt>", "Prompt to send to the runtime")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.runTask({
        taskId: task,
        prompt: message,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:resume")
  .description("Resume an interrupted task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-m, --message <prompt>", "Optional prompt override")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.resumeTask({
        taskId: task,
        prompt: message,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:cancel")
  .description("Cancel a running or interrupted task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.cancelTask(task);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
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
    const services = await openAppServices(config);

    try {
      const writer = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
      let unsubscribe: () => void;

      if (replay !== false) {
        const result = await services.events.replayAndSubscribe({
          taskId: task,
          sinceId: sinceId ? Number(sinceId) : undefined,
          listener: writer,
        });
        unsubscribe = result.unsubscribe;
      } else {
        unsubscribe = services.events.subscribe((event) => {
          if (!task || event.event.taskId === task) {
            writer(event);
          }
        });
      }

      process.on("SIGINT", () => {
        unsubscribe();
        services.close().then(() => process.exit(0));
      });

      await new Promise(() => {});
    } catch (error) {
      await services.close();
      throw error;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(toErrorEnvelope(error), null, 2)}\n`);
  process.exitCode = 1;
});
