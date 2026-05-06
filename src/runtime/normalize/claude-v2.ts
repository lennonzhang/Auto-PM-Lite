import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentItem, CanonicalEvent, ItemPayload } from "../../core/events.js";

export interface ClaudeV2NormalizerState {
  blockByIndex: Map<number, ClaudeBlockState>;
  toolItemByToolUseId: Map<string, string>;
  parentItemByToolUseId: Map<string, string>;
}

interface ClaudeBlockState {
  itemId: string;
  kind: "assistant_message" | "reasoning" | "tool_call";
  toolUseId?: string | undefined;
  inputJsonBuffer?: string | undefined;
  textBuffer?: string | undefined;
  redacted?: boolean | undefined;
}

export function createClaudeV2NormalizerState(): ClaudeV2NormalizerState {
  return {
    blockByIndex: new Map(),
    toolItemByToolUseId: new Map(),
    parentItemByToolUseId: new Map(),
  };
}

export function normalizeClaudeMessageV2(input: {
  taskId: string;
  turnId: string;
  cwd: string;
  message: SDKMessage;
  state: ClaudeV2NormalizerState;
  ts?: string | undefined;
}): CanonicalEvent[] {
  const ts = input.ts ?? new Date().toISOString();
  const sessionId = messageSessionId(input.message, input.taskId);

  if (input.message.type === "stream_event") {
    return normalizeStreamEvent({
      taskId: input.taskId,
      turnId: input.turnId,
      sessionId,
      message: input.message,
      state: input.state,
      ts,
    });
  }

  if (input.message.type === "assistant") {
    return normalizeAssistantFinal({
      taskId: input.taskId,
      turnId: input.turnId,
      sessionId,
      message: input.message,
      state: input.state,
      ts,
    });
  }

  if (input.message.type === "user") {
    return normalizeUserMessage({
      taskId: input.taskId,
      turnId: input.turnId,
      sessionId,
      message: input.message,
      state: input.state,
      ts,
    });
  }

  if (input.message.type === "tool_progress") {
    const itemId = input.state.toolItemByToolUseId.get(input.message.tool_use_id);
    return itemId
      ? [{
          kind: "item.updated",
          itemId,
          patch: {
            op: "merge_payload",
            value: {
              phase: "running",
              durationMs: Math.round(input.message.elapsed_time_seconds * 1000),
            },
          },
        }]
      : [];
  }

  if (input.message.type === "result") {
    const backend: CanonicalEvent = { kind: "task.backend_thread", backendThreadId: input.message.session_id };
    if (input.message.subtype === "success") {
      return [
        backend,
        {
          kind: "turn.completed",
          turnId: input.turnId,
          usage: {
            inputTokens: input.message.usage.input_tokens,
            outputTokens: input.message.usage.output_tokens,
            cachedInputTokens: input.message.usage.cache_read_input_tokens,
            cacheCreationInputTokens: input.message.usage.cache_creation_input_tokens,
            costUsd: input.message.total_cost_usd,
          },
        },
      ];
    }
    return [
      backend,
      {
        kind: "turn.failed",
        turnId: input.turnId,
        error: taskError(input.message.errors?.join("\n") || input.message.subtype),
      },
    ];
  }

  if (input.message.type === "system") {
    return normalizeSystemMessage(input.message, input.taskId, input.turnId, sessionId, ts);
  }

  if (input.message.type === "auth_status") {
    return [{
      kind: "item.started",
      item: systemNoticeItem({
        taskId: input.taskId,
        sessionId,
        turnId: input.turnId,
        itemId: `claude:${sessionId}:auth:${input.message.uuid}`,
        ts,
        level: input.message.error ? "error" : "info",
        code: "auth_renewing",
        message: input.message.error ?? (input.message.output.join("\n") || "Authentication status changed"),
        details: { isAuthenticating: input.message.isAuthenticating },
      }),
    }];
  }

  if (isRateLimitEvent(input.message)) {
    return [{
      kind: "item.started",
      item: systemNoticeItem({
        taskId: input.taskId,
        sessionId,
        turnId: input.turnId,
        itemId: `claude:${sessionId}:rate-limit:${input.message.uuid}`,
        ts,
        level: input.message.rate_limit_info.status === "rejected" ? "error" : "warning",
        code: "rate_limit_warning",
        message: `Rate limit ${input.message.rate_limit_info.status}`,
        details: input.message.rate_limit_info,
      }),
    }];
  }

  return [];
}

function normalizeStreamEvent(input: {
  taskId: string;
  turnId: string;
  sessionId: string;
  message: Extract<SDKMessage, { type: "stream_event" }>;
  state: ClaudeV2NormalizerState;
  ts: string;
}): CanonicalEvent[] {
  const raw = input.message.event as unknown;
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return [];
  }

  if (raw.type === "content_block_start" && typeof raw.index === "number" && isRecord(raw.content_block)) {
    const block = raw.content_block;
    if (block.type === "text") {
      const itemId = blockItemId(input.sessionId, input.turnId, raw.index);
      input.state.blockByIndex.set(raw.index, { itemId, kind: "assistant_message", textBuffer: "" });
      return [{
        kind: "item.started",
        item: assistantItem(input.taskId, input.sessionId, input.turnId, itemId, input.ts, stringValue(block.text)),
      }];
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const itemId = blockItemId(input.sessionId, input.turnId, raw.index);
      const redacted = block.type === "redacted_thinking";
      input.state.blockByIndex.set(raw.index, {
        itemId,
        kind: "reasoning",
        textBuffer: redacted ? "" : stringValue(block.thinking),
        redacted,
      });
      return [{
        kind: "item.started",
        item: reasoningItem(input.taskId, input.sessionId, input.turnId, itemId, input.ts, redacted ? "" : stringValue(block.thinking), redacted),
      }];
    }
    if (block.type === "tool_use") {
      const toolUseId = stringValue(block.id) || blockItemId(input.sessionId, input.turnId, raw.index);
      const itemId = `claude:${toolUseId}`;
      const parentItemId = input.message.parent_tool_use_id
        ? input.state.toolItemByToolUseId.get(input.message.parent_tool_use_id)
        : undefined;
      input.state.blockByIndex.set(raw.index, {
        itemId,
        kind: "tool_call",
        toolUseId,
        inputJsonBuffer: "",
      });
      input.state.toolItemByToolUseId.set(toolUseId, itemId);
      if (parentItemId) {
        input.state.parentItemByToolUseId.set(toolUseId, parentItemId);
      }
      return [{
        kind: "item.started",
        item: toolItem({
          taskId: input.taskId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          itemId,
          parentItemId,
          toolName: stringValue(block.name) || "unknown",
          input: isRecord(block.input) ? block.input : {},
          inputText: JSON.stringify(block.input ?? {}),
          ts: input.ts,
        }),
      }];
    }
  }

  if (raw.type === "content_block_delta" && typeof raw.index === "number" && isRecord(raw.delta)) {
    const block = input.state.blockByIndex.get(raw.index);
    if (!block) {
      return [];
    }
    const delta = raw.delta;
    if (delta.type === "text_delta" && block.kind === "assistant_message") {
      const text = stringValue(delta.text);
      const baseLength = block.textBuffer?.length ?? 0;
      block.textBuffer = `${block.textBuffer ?? ""}${text}`;
      return text ? [{
        kind: "item.updated",
        itemId: block.itemId,
        patch: { op: "append_text", path: "payload.text", value: text, baseLength },
      }] : [];
    }
    if (delta.type === "thinking_delta" && block.kind === "reasoning") {
      const thinking = stringValue(delta.thinking);
      const baseLength = block.textBuffer?.length ?? 0;
      block.textBuffer = `${block.textBuffer ?? ""}${thinking}`;
      return thinking ? [{
        kind: "item.updated",
        itemId: block.itemId,
        patch: { op: "append_array_text", path: "payload.content", index: 0, value: thinking, baseLength },
      }] : [];
    }
    if (delta.type === "input_json_delta" && block.kind === "tool_call") {
      const partialJson = stringValue(delta.partial_json);
      const baseLength = block.inputJsonBuffer?.length ?? 0;
      block.inputJsonBuffer = `${block.inputJsonBuffer ?? ""}${partialJson}`;
      const partialParsed = parsePartialJson(block.inputJsonBuffer);
      return partialJson ? [{
        kind: "item.updated",
        itemId: block.itemId,
        patch: {
          op: "append_tool_input_json",
          value: partialJson,
          baseLength,
          ...(partialParsed !== undefined ? { partialParsed } : {}),
        },
      }] : [];
    }
  }

  if (raw.type === "content_block_stop" && typeof raw.index === "number") {
    const block = input.state.blockByIndex.get(raw.index);
    if (!block) {
      return [];
    }
    if (block.kind === "tool_call") {
      return [{
        kind: "item.updated",
        itemId: block.itemId,
        patch: { op: "set_tool_phase", phase: "queued" },
      }];
    }
    return [];
  }

  return [];
}

function normalizeAssistantFinal(input: {
  taskId: string;
  turnId: string;
  sessionId: string;
  message: Extract<SDKMessage, { type: "assistant" }>;
  state: ClaudeV2NormalizerState;
  ts: string;
}): CanonicalEvent[] {
  const content = Array.isArray(input.message.message.content) ? input.message.message.content : [];
  const events: CanonicalEvent[] = [];
  content.forEach((block, index) => {
    if (!isRecord(block) || typeof block.type !== "string") {
      return;
    }
    if (block.type === "text") {
      const state = input.state.blockByIndex.get(index);
      const itemId = state?.itemId ?? blockItemId(input.sessionId, input.turnId, index);
      if (!state) {
        events.push({ kind: "item.started", item: assistantItem(input.taskId, input.sessionId, input.turnId, itemId, input.ts, "") });
      }
      events.push({
        kind: "item.completed",
        itemId,
        itemKind: "assistant_message",
        finalPayload: { text: stringValue(block.text) },
        completedAt: input.ts,
      });
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const state = input.state.blockByIndex.get(index);
      const itemId = state?.itemId ?? blockItemId(input.sessionId, input.turnId, index);
      const redacted = block.type === "redacted_thinking";
      if (!state) {
        events.push({ kind: "item.started", item: reasoningItem(input.taskId, input.sessionId, input.turnId, itemId, input.ts, "", redacted) });
      }
      events.push({
        kind: "item.completed",
        itemId,
        itemKind: "reasoning",
        finalPayload: { summary: [], content: redacted ? [] : [stringValue(block.thinking)], redacted },
        completedAt: input.ts,
      });
    }
    if (block.type === "tool_use") {
      const toolUseId = stringValue(block.id) || blockItemId(input.sessionId, input.turnId, index);
      const itemId = input.state.toolItemByToolUseId.get(toolUseId) ?? `claude:${toolUseId}`;
      input.state.toolItemByToolUseId.set(toolUseId, itemId);
      if (!input.state.blockByIndex.get(index)) {
        events.push({
          kind: "item.started",
          item: toolItem({
            taskId: input.taskId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            itemId,
            parentItemId: input.message.parent_tool_use_id ? input.state.toolItemByToolUseId.get(input.message.parent_tool_use_id) : undefined,
            toolName: stringValue(block.name) || "unknown",
            input: isRecord(block.input) ? block.input : {},
            inputText: JSON.stringify(block.input ?? {}),
            ts: input.ts,
          }),
        });
      }
      events.push({
        kind: "item.updated",
        itemId,
        patch: {
          op: "replace_payload",
          itemKind: "tool_call",
          value: {
            tool: { runtime: "claude", name: stringValue(block.name) || "unknown" },
            phase: "queued",
            input: block.input ?? {},
            inputText: JSON.stringify(block.input ?? {}),
          },
          reason: "final_reconcile",
        },
      });
    }
  });
  return events;
}

function normalizeUserMessage(input: {
  taskId: string;
  turnId: string;
  sessionId: string;
  message: Extract<SDKMessage, { type: "user" }>;
  state: ClaudeV2NormalizerState;
  ts: string;
}): CanonicalEvent[] {
  const result = input.message.tool_use_result;
  if (!result) {
    return [];
  }
  const toolUseId = toolUseResultId(result);
  const itemId = toolUseId ? input.state.toolItemByToolUseId.get(toolUseId) : undefined;
  if (!itemId) {
    return [];
  }
  const isError = isRecord(result) && (result.is_error === true || result.error === true);
  return isError
    ? [{
        kind: "item.failed",
        itemId,
        error: { code: "tool_failed", message: toolUseResultText(result) || "Tool failed", details: result },
        completedAt: input.ts,
      }]
    : [{
        kind: "item.completed",
        itemId,
        itemKind: "tool_call",
        finalPayload: {
          tool: { runtime: "claude", name: "unknown" },
          phase: "completed",
          input: {},
          output: result,
        },
        completedAt: input.ts,
      }];
}

function normalizeSystemMessage(message: Extract<SDKMessage, { type: "system" }>, taskId: string, turnId: string, sessionId: string, ts: string): CanonicalEvent[] {
  if (message.subtype === "init") {
    return [{
      kind: "session.started",
      profileId: "",
      model: message.model,
      tools: message.tools.map((name) => ({ name })),
      mcpServers: message.mcp_servers,
    }];
  }
  if (message.subtype === "compact_boundary") {
    return [{
      kind: "item.started",
      item: {
        id: `claude:${sessionId}:compact:${message.uuid}`,
        taskId,
        sessionId,
        turnId,
        kind: "context_compaction",
        status: "completed",
        startedAt: ts,
        updatedAt: ts,
        completedAt: ts,
        payload: {
          trigger: message.compact_metadata.trigger,
          preTokens: message.compact_metadata.pre_tokens,
          ...(message.compact_metadata.post_tokens === undefined ? {} : { postTokens: message.compact_metadata.post_tokens }),
          status: "completed",
        },
      },
    }];
  }
  if (message.subtype === "hook_response") {
    return [{
      kind: "item.started",
      item: systemNoticeItem({
        taskId,
        sessionId,
        turnId,
        itemId: `claude:${sessionId}:hook:${message.hook_id}`,
        ts,
        level: message.outcome === "success" ? "info" : "error",
        code: "hook_finished",
        message: `${message.hook_name} ${message.outcome}`,
        details: {
          hookEvent: message.hook_event,
          stdout: message.stdout,
          stderr: message.stderr,
          exitCode: message.exit_code,
        },
      }),
    }];
  }
  if (message.subtype === "api_retry") {
    return [{
      kind: "item.started",
      item: systemNoticeItem({
        taskId,
        sessionId,
        turnId,
        itemId: `claude:${sessionId}:api-retry:${message.uuid}`,
        ts,
        level: "warning",
        code: "api_retry",
        message: `API retry ${message.attempt}/${message.max_retries}`,
        details: message,
      }),
    }];
  }
  if (message.subtype === "status" && message.status === "compacting") {
    return [{
      kind: "item.started",
      item: systemNoticeItem({
        taskId,
        sessionId,
        turnId,
        itemId: `claude:${sessionId}:status:${message.uuid}`,
        ts,
        level: "info",
        code: "compact_started",
        message: "Compacting context",
        details: message,
      }),
    }];
  }
  return [];
}

function assistantItem(taskId: string, sessionId: string, turnId: string, itemId: string, ts: string, text: string): AgentItem<"assistant_message"> {
  return {
    id: itemId,
    taskId,
    sessionId,
    turnId,
    kind: "assistant_message",
    status: "in_progress",
    startedAt: ts,
    updatedAt: ts,
    payload: { text },
  };
}

function reasoningItem(taskId: string, sessionId: string, turnId: string, itemId: string, ts: string, text: string, redacted: boolean): AgentItem<"reasoning"> {
  return {
    id: itemId,
    taskId,
    sessionId,
    turnId,
    kind: "reasoning",
    status: "in_progress",
    startedAt: ts,
    updatedAt: ts,
    payload: { summary: [], content: text ? [text] : [], redacted },
  };
}

function toolItem(input: {
  taskId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  parentItemId?: string | undefined;
  toolName: string;
  input: unknown;
  inputText: string;
  ts: string;
}): AgentItem<"tool_call"> {
  return {
    id: input.itemId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
    kind: "tool_call",
    status: "in_progress",
    startedAt: input.ts,
    updatedAt: input.ts,
    payload: {
      tool: { runtime: "claude", name: input.toolName },
      phase: "input_streaming",
      input: input.input,
      inputText: input.inputText,
    },
  };
}

function systemNoticeItem(input: {
  taskId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  ts: string;
  level: "info" | "warning" | "error";
  code: ItemPayload["system_notice"]["code"];
  message: string;
  details?: unknown;
}): AgentItem<"system_notice"> {
  return {
    id: input.itemId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: "system_notice",
    status: "completed",
    startedAt: input.ts,
    updatedAt: input.ts,
    completedAt: input.ts,
    payload: {
      level: input.level,
      code: input.code,
      message: input.message,
      ...(input.details === undefined ? {} : { details: input.details }),
    },
  };
}

function blockItemId(sessionId: string, turnId: string, index: number): string {
  return `claude:${sessionId}:${turnId}:block:${index}`;
}

function messageSessionId(message: SDKMessage, fallback: string): string {
  return "session_id" in message && typeof message.session_id === "string" ? message.session_id : fallback;
}

function taskError(message: string) {
  return { code: "internal" as const, message, retriable: false };
}

function isRateLimitEvent(message: SDKMessage): message is Extract<SDKMessage, { type: "rate_limit_event" }> {
  return message.type === "rate_limit_event";
}

function toolUseResultId(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  return stringValue(result.tool_use_id) || stringValue(result.toolUseId);
}

function toolUseResultText(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const content = result.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => isRecord(item) ? stringValue(item.text) : "").filter(Boolean).join("\n");
  }
  return stringValue(result.message);
}

function parsePartialJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
