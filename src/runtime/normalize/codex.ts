import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentEvent } from "../../core/types.js";

export function normalizeCodexEvent(taskId: string, event: ThreadEvent, turnId: string): AgentEvent[] {
  const ts = new Date().toISOString();

  switch (event.type) {
    case "turn.started":
      return [{ type: "turn.started", taskId, turnId, ts }];
    case "item.completed": {
      const item = event.item;
      switch (item.type) {
        case "agent_message":
          return [{ type: "message.completed", taskId, turnId, text: item.text, ts }];
        case "mcp_tool_call":
          return [
            { type: "tool.call", taskId, tool: `${item.server}.${item.tool}`, input: item.arguments, ts },
            { type: "tool.result", taskId, tool: `${item.server}.${item.tool}`, result: item.result ?? item.error, ts },
          ];
        case "file_change":
          return item.changes.map((change) => ({
            type: "file.changed" as const,
            taskId,
            path: change.path,
            changeKind: mapFileChangeKind(change.kind),
            ts,
          }));
        case "command_execution":
          return item.aggregated_output
            ? [{ type: "message.delta", taskId, turnId, text: item.aggregated_output, ts }]
            : [];
        case "error":
          return [{ type: "task.failed", taskId, error: item.message, ts }];
        default:
          return [];
      }
    }
    case "turn.completed":
      return [{
        type: "turn.completed",
        taskId,
        turnId,
        usage: {
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
          reasoningOutputTokens: event.usage.reasoning_output_tokens,
        },
        ts,
      }];
    case "turn.failed":
      return [{ type: "task.failed", taskId, error: event.error.message, ts }];
    case "error":
      return [{ type: "task.failed", taskId, error: event.message, ts }];
    default:
      return [];
  }
}

function mapFileChangeKind(kind: string): "create" | "modify" | "delete" {
  if (kind === "add") {
    return "create";
  }
  if (kind === "delete") {
    return "delete";
  }
  return "modify";
}
