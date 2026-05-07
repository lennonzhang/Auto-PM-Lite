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
  .description("Alias for task:send-turn")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-m, --message <prompt>", "Prompt to send to the runtime")
  .option("--request-id <id>", "Idempotency key")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, requestId, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.runTask({
        taskId: task,
        prompt: message,
        requestId,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:send-turn")
  .description("Send a normal follow-up turn to a queued or idle task")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-m, --message <prompt>", "Prompt to send to the runtime")
  .option("--request-id <id>", "Idempotency key")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, requestId, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.sendTurn({
        taskId: task,
        prompt: message,
        requestId,
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
  .option("--request-id <id>", "Idempotency key")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, requestId, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.resumeTask({
        taskId: task,
        prompt: message,
        requestId,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:close")
  .description("Explicitly close an idle or recoverable task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-s, --summary <text>", "Optional close summary")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, summary, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.closeTask({
        taskId: task,
        summary,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:handoff")
  .description("Handoff an idle task to another profile")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-p, --profile <id>", "Target profile ID")
  .requiredOption("-r, --reason <text>", "Handoff reason")
  .option("-m, --message <prompt>", "Optional prompt for the target runtime")
  .option("--request-id <id>", "Idempotency key")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, profile, reason, requestId, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.handoffTask({
        taskId: task,
        targetProfileId: profile,
        prompt: message,
        reason,
        requestId,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:fork")
  .description("Fork a task session")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("--from-turn <id>", "Completed turn to fork from")
  .option("--mode <task|session>", "Fork mode", "task")
  .option("-n, --name <text>", "Child task name")
  .option("-m, --message <prompt>", "Optional prompt for logical fork")
  .option("--request-id <id>", "Idempotency key")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, fromTurn, message, mode, name, requestId, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.forkTask({
        taskId: task,
        fromTurnId: fromTurn,
        mode,
        name,
        prompt: message,
        requestId,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("task:rollover")
  .description("Rollover an idle task to a fresh runtime session")
  .requiredOption("-t, --task <id>", "Task ID")
  .requiredOption("-r, --reason <context_limit|model_change|profile_change|session_corrupt|manual>", "Rollover reason")
  .option("-p, --profile <id>", "Optional target profile ID")
  .option("-m, --message <prompt>", "Optional carry-over prompt")
  .option("--request-id <id>", "Idempotency key")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .action(async ({ config, message, profile, reason, requestId, task }) => {
    const services = await openAppServices(config);

    try {
      const result = await services.tasks.rolloverSession({
        taskId: task,
        reason,
        targetProfileId: profile,
        carryOverPrompt: message,
        requestId,
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
  .requiredOption("-t, --task <id>", "Task ID")
  .option("--since-task-seq <number>", "Resume after a given task-local sequence (defaults to 0 = full history)")
  .action(async ({ config, task, sinceTaskSeq }) => {
    const services = await openAppServices(config);

    try {
      const writer = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
      const result = await services.events.replayAndSubscribe({
        taskId: task,
        sinceTaskSeq: sinceTaskSeq ? Number(sinceTaskSeq) : undefined,
        listener: writer,
      });

      process.on("SIGINT", () => {
        result.unsubscribe();
        services.close().then(() => process.exit(0));
      });

      await new Promise(() => {});
    } catch (error) {
      await services.close();
      throw error;
    }
  });

program
  .command("events:debug")
  .description("Replay canonical v2 events by global sequence for debugging")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .option("--since-global-seq <number>", "Resume after a global event sequence")
  .option("--limit <number>", "Maximum events to print", "500")
  .option("-t, --task <id>", "Filter by task ID")
  .option("--runtime <runtime>", "Filter by runtime: claude or codex")
  .option("--kind <kind>", "Filter by event kind")
  .action(async ({ config, sinceGlobalSeq, limit, task, runtime, kind }) => {
    const services = await openAppServices(config);
    try {
      const result = services.events.listEvents({
        sinceGlobalSeq: sinceGlobalSeq ? Number(sinceGlobalSeq) : undefined,
        limit: limit ? Number(limit) : undefined,
        taskId: task,
        runtime,
        kind,
      });
      for (const event of result.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    } finally {
      await services.close();
    }
  });

program
  .command("events:raw")
  .description("Print a redacted raw runtime event by rawRef")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .requiredOption("--raw-ref <id>", "Raw event reference")
  .action(async ({ config, rawRef }) => {
    const services = await openAppServices(config);
    try {
      process.stdout.write(`${JSON.stringify(services.events.getRaw({ rawRef }), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program
  .command("events:check-projection")
  .description("Replay task events and compare them with the stored item projection")
  .option("-c, --config <path>", "Path to config TOML", defaultConfigPath())
  .requiredOption("-t, --task <id>", "Task ID")
  .action(async ({ config, task }) => {
    const services = await openAppServices(config);
    try {
      process.stdout.write(`${JSON.stringify(services.events.checkProjection({ taskId: task }), null, 2)}\n`);
    } finally {
      await services.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(toErrorEnvelope(error), null, 2)}\n`);
  process.exitCode = 1;
});
