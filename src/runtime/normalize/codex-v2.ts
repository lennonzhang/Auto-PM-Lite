import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentItem, CanonicalEvent, ItemKind, ItemPayload, ItemStatus } from "../../core/events.js";

interface CodexThreadItemBase {
  id: string;
  type: string;
}

type CodexThreadItem = Extract<ThreadEvent, { item: unknown }>["item"];
type CodexCommandExecutionItem = Extract<CodexThreadItem, { type: "command_execution" }>;
type CodexTodoListItem = Extract<CodexThreadItem, { type: "todo_list" }>;

export interface CodexV2NormalizerState {
  previousItems: Map<string, unknown>;
}

export function createCodexV2NormalizerState(): CodexV2NormalizerState {
  return { previousItems: new Map() };
}

export function normalizeCodexEventV2(input: {
  taskId: string;
  sessionId: string;
  turnId: string;
  cwd: string;
  event: ThreadEvent;
  state: CodexV2NormalizerState;
  ts?: string | undefined;
}): CanonicalEvent[] {
  const ts = input.ts ?? new Date().toISOString();
  switch (input.event.type) {
    case "thread.started":
      return [{ kind: "task.backend_thread", backendThreadId: input.event.thread_id }];
    case "turn.started":
      return [{ kind: "turn.started", turnId: input.turnId }];
    case "turn.completed":
      return [{
        kind: "turn.completed",
        turnId: input.turnId,
        usage: {
          inputTokens: input.event.usage.input_tokens,
          outputTokens: input.event.usage.output_tokens,
          cachedInputTokens: input.event.usage.cached_input_tokens,
          reasoningOutputTokens: input.event.usage.reasoning_output_tokens,
        },
      }];
    case "turn.failed":
      return [{ kind: "turn.failed", turnId: input.turnId, error: taskError(input.event.error.message) }];
    case "error":
      return [{ kind: "task.failed", error: taskError(input.event.message) }];
    case "item.started": {
      input.state.previousItems.set(input.event.item.id, input.event.item);
      return [{ kind: "item.started", item: toAgentItem(input, input.event.item, ts) }];
    }
    case "item.updated": {
      const previous = input.state.previousItems.get(input.event.item.id);
      input.state.previousItems.set(input.event.item.id, input.event.item);
      return toItemUpdatedEvents(input.event.item, previous);
    }
    case "item.completed": {
      input.state.previousItems.set(input.event.item.id, input.event.item);
      const finalPayload = toPayload(input, input.event.item);
      if (input.event.item.type === "error") {
        return [{
          kind: "item.failed",
          itemId: itemId(input.event.item),
          error: itemError(input.event.item.message),
          completedAt: ts,
        }];
      }
      return [{
        kind: "item.completed",
        itemId: itemId(input.event.item),
        itemKind: toItemKind(input.event.item),
        finalPayload,
        completedAt: ts,
      } as CanonicalEvent];
    }
  }
}

function toAgentItem(input: {
  taskId: string;
  sessionId: string;
  turnId: string;
  cwd: string;
}, item: CodexThreadItem, ts: string): AgentItem {
  const kind = toItemKind(item);
  return {
    id: itemId(item),
    taskId: input.taskId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind,
    status: itemStatus(item),
    startedAt: ts,
    updatedAt: ts,
    payload: toPayload(input, item),
    ...(item.type === "error" ? { error: itemError(item.message) } : {}),
  } as AgentItem;
}

function toItemUpdatedEvents(item: CodexThreadItem, previous: unknown): CanonicalEvent[] {
  const id = itemId(item);
  if (item.type === "agent_message") {
    const previousText = previousItemText(previous);
    return appendStringPatch(id, "payload.text", item.text, previousText);
  }
  if (item.type === "reasoning") {
    const previousText = previousItemText(previous);
    return appendStringPatch(id, "payload.content", item.text, previousText);
  }
  if (item.type === "command_execution") {
    const previousOutput = isRecord(previous) && typeof previous.aggregated_output === "string" ? previous.aggregated_output : "";
    if (item.aggregated_output.startsWith(previousOutput)) {
      const delta = item.aggregated_output.slice(previousOutput.length);
      return delta
        ? [{
            kind: "item.updated",
            itemId: id,
            patch: {
              op: "append_command_output",
              value: { stream: "pty", text: delta },
              baseLength: previousOutput.length,
            },
          }]
        : [];
    }
    return [{
      kind: "item.updated",
      itemId: id,
      patch: {
        op: "replace_payload",
        itemKind: "command_execution",
        value: toCommandPayload(item),
        reason: "mismatch",
      },
    }];
  }
  if (item.type === "todo_list") {
    return [{
      kind: "item.updated",
      itemId: id,
      patch: {
        op: "replace_payload",
        itemKind: "todo_list",
        value: toTodoPayload(item),
        reason: "snapshot",
      },
    }];
  }
  if (item.type === "mcp_tool_call") {
    return [{
      kind: "item.updated",
      itemId: id,
      patch: {
        op: "merge_payload",
        value: { phase: item.status === "in_progress" ? "running" : item.status },
      },
    }];
  }
  return [];
}

function appendStringPatch(itemIdValue: string, path: "payload.text" | "payload.content", current: string, previous: string): CanonicalEvent[] {
  if (!current.startsWith(previous)) {
    const itemKind = path === "payload.text" ? "assistant_message" : "reasoning";
    return [{
      kind: "item.updated",
      itemId: itemIdValue,
      patch: {
        op: "replace_payload",
        itemKind,
        value: itemKind === "assistant_message" ? { text: current } : { summary: [], content: [current] },
        reason: "mismatch",
      },
    } as CanonicalEvent];
  }
  const delta = current.slice(previous.length);
  if (!delta) {
    return [];
  }
  if (path === "payload.text") {
    return [{
      kind: "item.updated",
      itemId: itemIdValue,
      patch: { op: "append_text", path, value: delta, baseLength: previous.length },
    }];
  }
  return [{
    kind: "item.updated",
    itemId: itemIdValue,
    patch: { op: "append_array_text", path, index: 0, value: delta, baseLength: previous.length },
  }];
}

function toPayload(input: { cwd: string }, item: CodexThreadItem): ItemPayload[keyof ItemPayload] {
  if (item.type === "command_execution") {
    return {
      ...toCommandPayload(item),
      cwd: input.cwd,
    };
  }
  return toPayloadFromCodexItem(item);
}

function toPayloadFromCodexItem(item: CodexThreadItem): ItemPayload[keyof ItemPayload] {
  switch (item.type) {
    case "agent_message":
      return { text: item.text };
    case "reasoning":
      return { summary: [], content: [item.text] };
    case "command_execution":
      return toCommandPayload(item);
    case "mcp_tool_call":
      return {
        tool: { runtime: "codex", namespace: item.server, name: item.tool },
        phase: item.status === "in_progress" ? "running" : item.status,
        input: item.arguments,
        ...(item.result !== undefined ? { output: item.result } : {}),
        ...(item.error !== undefined ? { error: itemError(item.error.message) } : {}),
      };
    case "file_change":
      return {
        changes: item.changes.map((change) => ({
          path: change.path,
          changeKind: change.kind === "add" ? "create" : change.kind === "delete" ? "delete" : "modify",
          binary: false,
        })),
        status: item.status === "completed" ? "applied" : "failed",
      };
    case "todo_list":
      return toTodoPayload(item);
    case "web_search":
      return { query: item.query };
    case "error":
      return {
        level: "error",
        code: "runtime_notice",
        message: item.message,
      };
  }
}

function toCommandPayload(item: CodexCommandExecutionItem): ItemPayload["command_execution"] {
  return {
    command: item.command,
    cwd: "",
    source: "model",
    status: item.status,
    aggregatedOutput: item.aggregated_output,
    outputChunks: item.aggregated_output ? [{ stream: "pty", text: item.aggregated_output }] : [],
    ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
  };
}

function toTodoPayload(item: CodexTodoListItem): ItemPayload["todo_list"] {
  return { items: item.items };
}

function toItemKind(item: CodexThreadItem): ItemKind {
  switch (item.type) {
    case "agent_message":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "command_execution":
      return "command_execution";
    case "mcp_tool_call":
      return "tool_call";
    case "file_change":
      return "file_change";
    case "todo_list":
      return "todo_list";
    case "web_search":
      return "web_search";
    case "error":
      return "system_notice";
  }
}

function itemStatus(item: CodexThreadItem): ItemStatus {
  if ("status" in item && typeof item.status === "string") {
    if (item.status === "in_progress" || item.status === "completed" || item.status === "failed") {
      return item.status;
    }
  }
  if (item.type === "error") {
    return "failed";
  }
  return "in_progress";
}

function itemId(item: CodexThreadItemBase): string {
  return `codex:${item.id}`;
}

function previousItemText(value: unknown): string {
  return isRecord(value) && typeof value.text === "string" ? value.text : "";
}

function taskError(message: string) {
  return { code: "internal" as const, message, retriable: false };
}

function itemError(message: string) {
  return { code: "unknown" as const, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
