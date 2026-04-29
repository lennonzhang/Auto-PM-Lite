import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface McpToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}

const delegateInputSchema = z.object({
  targetProfileId: z.string().optional(),
  targetRuntime: z.enum(["claude", "codex"]).optional(),
  taskType: z.enum(["ask", "review", "edit", "fix", "test"]),
  prompt: z.string().min(1),
  reason: z.string().min(1),
  requestedPermissionMode: z.enum(["read-only", "edit", "full"]).optional(),
  workspaceMode: z.enum(["share", "new-worktree"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const capabilityInputSchema = z.object({
  kind: z.enum(["filesystem", "network", "delegation", "workspace_merge", "reference_access"]),
  reason: z.string().min(1),
});

const taskResultInputSchema = z.object({
  taskId: z.string().min(1),
});

const artifactInputSchema = z.object({
  kind: z.enum(["file", "blob", "url"]),
  ref: z.string().min(1),
  description: z.string().optional(),
});

export interface AutoPmMcpHandlers {
  delegateTo(input: z.infer<typeof delegateInputSchema>): Promise<McpToolResult>;
  requestCapability(input: z.infer<typeof capabilityInputSchema>): Promise<McpToolResult>;
  waitForTask(input: z.infer<typeof taskResultInputSchema>): Promise<McpToolResult>;
  getTaskResult(input: z.infer<typeof taskResultInputSchema>): Promise<McpToolResult>;
  reportArtifact(input: z.infer<typeof artifactInputSchema>): Promise<McpToolResult>;
}

export class AutoPmMcpService {
  constructor(private readonly handlers: AutoPmMcpHandlers) {}

  toClaudeTools() {
    return [
      tool("delegate_to", "Delegate work to another runtime or profile.", delegateInputSchema.shape, (args) => this.handlers.delegateTo(args)),
      tool("request_capability", "Ask the orchestrator for elevated capability.", capabilityInputSchema.shape, (args) => this.handlers.requestCapability(args)),
      tool("wait_for_task", "Wait for an existing task to finish.", taskResultInputSchema.shape, (args) => this.handlers.waitForTask(args)),
      tool("get_task_result", "Read the current or final result for a task.", taskResultInputSchema.shape, (args) => this.handlers.getTaskResult(args)),
      tool("report_artifact", "Report a generated artifact back to the orchestrator.", artifactInputSchema.shape, (args) => this.handlers.reportArtifact(args)),
    ];
  }

  listMcpTools() {
    return [
      {
        name: "delegate_to",
        description: "Delegate work to another runtime or profile.",
        inputSchema: z.toJSONSchema(delegateInputSchema),
      },
      {
        name: "request_capability",
        description: "Ask the orchestrator for elevated capability.",
        inputSchema: z.toJSONSchema(capabilityInputSchema),
      },
      {
        name: "wait_for_task",
        description: "Wait for an existing task to finish.",
        inputSchema: z.toJSONSchema(taskResultInputSchema),
      },
      {
        name: "get_task_result",
        description: "Read the current or final result for a task.",
        inputSchema: z.toJSONSchema(taskResultInputSchema),
      },
      {
        name: "report_artifact",
        description: "Report a generated artifact back to the orchestrator.",
        inputSchema: z.toJSONSchema(artifactInputSchema),
      },
    ];
  }

  async invokeTool(name: string, args: unknown): Promise<McpToolResult> {
    switch (name) {
      case "delegate_to":
        return this.handlers.delegateTo(delegateInputSchema.parse(args ?? {}));
      case "request_capability":
        return this.handlers.requestCapability(capabilityInputSchema.parse(args ?? {}));
      case "wait_for_task":
        return this.handlers.waitForTask(taskResultInputSchema.parse(args ?? {}));
      case "get_task_result":
        return this.handlers.getTaskResult(taskResultInputSchema.parse(args ?? {}));
      case "report_artifact":
        return this.handlers.reportArtifact(artifactInputSchema.parse(args ?? {}));
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }
}
