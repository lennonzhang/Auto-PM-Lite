import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, TurnUsage } from "../../core/types.js";

export function normalizeClaudeMessage(taskId: string, message: SDKMessage, turnId: string): AgentEvent[] {
  const ts = new Date().toISOString();

  if (message.type === "assistant") {
    const text = extractClaudeText(message.message.content);
    return text ? [{ type: "message.delta", taskId, turnId, text, ts }] : [];
  }

  if (message.type === "result") {
    const backendEvent: AgentEvent = { type: "task.backend_thread", taskId, backendThreadId: message.session_id, ts };
    if (message.subtype === "success") {
      return [
        backendEvent,
        { type: "message.completed", taskId, turnId, text: message.result, ts },
        { type: "turn.completed", taskId, turnId, usage: toClaudeUsage(message), ts },
      ];
    }

    return [
      backendEvent,
      { type: "task.failed", taskId, error: message.errors?.join("\n") || message.subtype, ts },
    ];
  }

  if (message.type === "system") {
    return [];
  }

  return [];
}

function toClaudeUsage(message: Extract<SDKMessage, { type: "result" }>): TurnUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cachedInputTokens: message.usage.cache_read_input_tokens,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
    costUsd: message.total_cost_usd,
  };
}

function extractClaudeText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const typed = item as { type?: string; text?: string };
      return typed.type === "text" && typed.text ? [typed.text] : [];
    })
    .join("\n")
    .trim();
}
