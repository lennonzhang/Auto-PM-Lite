import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeV2NormalizerState, normalizeClaudeMessageV2 } from "../../src/runtime/normalize/claude-v2.js";

describe("Claude v2 normalizer", () => {
  it("maps text stream events to assistant message lifecycle and deltas", () => {
    const state = createClaudeV2NormalizerState();
    const started = normalize(streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }), state);
    const delta = normalize(streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    }), state);

    expect(started[0]).toMatchObject({
      kind: "item.started",
      item: { kind: "assistant_message", id: "claude:session-1:turn-1:block:0" },
    });
    expect(delta).toEqual([{
      kind: "item.updated",
      itemId: "claude:session-1:turn-1:block:0",
      patch: { op: "append_text", path: "payload.text", value: "hello", baseLength: 0 },
    }]);
  });

  it("maps thinking deltas to reasoning content and redacted thinking to redacted reasoning", () => {
    const state = createClaudeV2NormalizerState();
    normalize(streamEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "" },
    }), state);
    const delta = normalize(streamEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "think" },
    }), state);
    const redacted = normalize(streamEvent({
      type: "content_block_start",
      index: 2,
      content_block: { type: "redacted_thinking", data: "secret" },
    }), state);

    expect(delta[0]).toMatchObject({
      kind: "item.updated",
      patch: { op: "append_array_text", path: "payload.content", value: "think" },
    });
    expect(redacted[0]).toMatchObject({
      kind: "item.started",
      item: { kind: "reasoning", payload: { redacted: true, content: [] } },
    });
  });

  it("maps tool input streaming, progress, and tool_result", () => {
    const state = createClaudeV2NormalizerState();
    const start = normalize(streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
    }), state);
    const input = normalize(streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
    }), state);
    const progress = normalize(sdk({
      type: "tool_progress",
      tool_use_id: "toolu_1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1.5,
      uuid: "progress-1",
      session_id: "session-1",
    }), state);
    const result = normalize(sdk({
      type: "user",
      message: { role: "user", content: [] },
      parent_tool_use_id: null,
      tool_use_result: { tool_use_id: "toolu_1", content: "ok" },
      uuid: "user-1",
      session_id: "session-1",
    }), state);

    expect(start[0]).toMatchObject({
      kind: "item.started",
      item: { id: "claude:toolu_1", kind: "tool_call", payload: { tool: { name: "Bash" } } },
    });
    expect(input[0]).toMatchObject({
      kind: "item.updated",
      itemId: "claude:toolu_1",
      patch: { op: "append_tool_input_json", baseLength: 0 },
    });
    expect(progress[0]).toMatchObject({
      kind: "item.updated",
      itemId: "claude:toolu_1",
      patch: { op: "merge_payload", value: { phase: "running", durationMs: 1500 } },
    });
    expect(result[0]).toMatchObject({
      kind: "item.completed",
      itemId: "claude:toolu_1",
      itemKind: "tool_call",
      finalPayload: {
        tool: { runtime: "claude", name: "Bash" },
        phase: "completed",
        input: { command: "pwd" },
        inputText: "{\"command\":\"pwd\"}",
        output: { tool_use_id: "toolu_1", content: "ok" },
      },
    });
  });

  it("uses assistant final tool metadata as authoritative tool_result context", () => {
    const state = createClaudeV2NormalizerState();
    normalize(streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_2", name: "unknown", input: {} },
    }), state);
    normalize(sdk({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "src/index.ts" } }],
      },
      parent_tool_use_id: null,
      uuid: "assistant-final",
      session_id: "session-1",
    }), state);
    const result = normalize(sdk({
      type: "user",
      message: { role: "user", content: [] },
      parent_tool_use_id: null,
      tool_use_result: { tool_use_id: "toolu_2", content: "file contents" },
      uuid: "user-2",
      session_id: "session-1",
    }), state);

    expect(result[0]).toMatchObject({
      kind: "item.completed",
      itemId: "claude:toolu_2",
      itemKind: "tool_call",
      finalPayload: {
        tool: { runtime: "claude", name: "Read" },
        input: { file_path: "src/index.ts" },
        inputText: "{\"file_path\":\"src/index.ts\"}",
        output: { tool_use_id: "toolu_2", content: "file contents" },
      },
    });
  });

  it("does not treat content_block_stop as turn completion and marks orphan tool results", () => {
    const state = createClaudeV2NormalizerState();
    normalize(streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }), state);

    const stop = normalize(streamEvent({
      type: "content_block_stop",
      index: 0,
    }), state);
    const orphan = normalize(sdk({
      type: "user",
      message: { role: "user", content: [] },
      parent_tool_use_id: null,
      tool_use_result: { tool_use_id: "missing-tool", content: "late" },
      uuid: "orphan-result",
      session_id: "session-1",
    }), state);

    expect(stop).toEqual([]);
    expect(orphan[0]).toMatchObject({
      kind: "item.started",
      item: {
        kind: "system_notice",
        payload: { code: "runtime_notice", level: "warning" },
      },
    });
  });

  it("maps system init, compaction, hook response, and result usage", () => {
    const state = createClaudeV2NormalizerState();
    expect(normalize(sdk({
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      claude_code_version: "1",
      cwd: "cwd",
      tools: ["Read"],
      mcp_servers: [{ name: "auto_pm", status: "connected" }],
      model: "claude",
      permissionMode: "default",
      slash_commands: [],
      output_style: "normal",
      skills: [],
      plugins: [],
      uuid: "init-1",
      session_id: "session-1",
    }), state)[0]).toMatchObject({
      kind: "session.started",
      model: "claude",
      tools: [{ name: "Read" }],
    });

    expect(normalize(sdk({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 20 },
      uuid: "compact-1",
      session_id: "session-1",
    }), state)[0]).toMatchObject({
      kind: "item.started",
      item: { kind: "context_compaction", payload: { trigger: "auto", preTokens: 100, postTokens: 20 } },
    });

    expect(normalize(sdk({
      type: "system",
      subtype: "hook_response",
      hook_id: "hook-1",
      hook_name: "PostToolUse",
      hook_event: "post",
      output: "ok",
      stdout: "out",
      stderr: "",
      outcome: "success",
      uuid: "hook-1",
      session_id: "session-1",
    }), state)[0]).toMatchObject({
      kind: "item.started",
      item: { kind: "system_notice", payload: { code: "hook_finished" } },
    });

    const result = normalize(sdk({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: null,
      total_cost_usd: 0.1,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "result-1",
      session_id: "session-1",
    }), state);

    expect(result).toEqual(expect.arrayContaining([
      { kind: "session.backend_thread", sessionId: "session-1", backendThreadId: "session-1" },
      {
        kind: "turn.completed",
        turnId: "turn-1",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 4,
          cacheCreationInputTokens: 3,
          costUsd: 0.1,
        },
      },
    ]));
  });
});

function normalize(message: SDKMessage, state = createClaudeV2NormalizerState()) {
  return normalizeClaudeMessageV2({
    taskId: "task-1",
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "cwd",
    message,
    state,
    ts: "2026-05-06T00:00:00.000Z",
  });
}

function streamEvent(event: Record<string, unknown>): SDKMessage {
  return sdk({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: "stream-1",
    session_id: "session-1",
  });
}

function sdk(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}
