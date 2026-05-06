import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createCodexV2NormalizerState, normalizeCodexEventV2 } from "../../src/runtime/normalize/codex-v2.js";

describe("Codex v2 normalizer", () => {
  it("maps command output updates to command_execution patches", () => {
    const state = createCodexV2NormalizerState();
    normalize(started(command("cmd-1", "")), state);
    const events = normalize(updated(command("cmd-1", "hello")), state);

    expect(events).toEqual([{
      kind: "item.updated",
      itemId: "codex:cmd-1",
      patch: {
        op: "append_command_output",
        value: { stream: "pty", text: "hello" },
        baseLength: 0,
      },
    }]);
    expect(events[0]?.kind).not.toBe("message.delta");
  });

  it("replaces command payload when snapshots are not prefix-compatible", () => {
    const state = createCodexV2NormalizerState();
    normalize(started(command("cmd-1", "abc")), state);
    const events = normalize(updated(command("cmd-1", "xyz")), state);

    expect(events[0]).toMatchObject({
      kind: "item.updated",
      itemId: "codex:cmd-1",
      patch: {
        op: "replace_payload",
        itemKind: "command_execution",
        reason: "mismatch",
      },
    });
  });

  it("maps reasoning updates to reasoning content append patches", () => {
    const state = createCodexV2NormalizerState();
    normalize(started({ id: "r1", type: "reasoning", text: "" }), state);
    const events = normalize(updated({ id: "r1", type: "reasoning", text: "thinking" }), state);

    expect(events).toEqual([{
      kind: "item.updated",
      itemId: "codex:r1",
      patch: {
        op: "append_array_text",
        path: "payload.content",
        index: 0,
        value: "thinking",
        baseLength: 0,
      },
    }]);
  });

  it("maps mcp, file, todo, and web items to canonical item lifecycles", () => {
    const state = createCodexV2NormalizerState();
    expect(normalize(started({
      id: "tool-1",
      type: "mcp_tool_call",
      server: "auto_pm",
      tool: "delegate_to",
      arguments: { prompt: "x" },
      status: "in_progress",
    }), state)[0]).toMatchObject({
      kind: "item.started",
      item: {
        id: "codex:tool-1",
        kind: "tool_call",
        payload: { tool: { runtime: "codex", namespace: "auto_pm", name: "delegate_to" } },
      },
    });

    expect(normalize(completed({
      id: "file-1",
      type: "file_change",
      changes: [{ path: "a.txt", kind: "add" }],
      status: "completed",
    }), state)[0]).toMatchObject({
      kind: "item.completed",
      itemKind: "file_change",
      finalPayload: { changes: [{ path: "a.txt", changeKind: "create", binary: false }], status: "applied" },
    });

    expect(normalize(updated({
      id: "todo-1",
      type: "todo_list",
      items: [{ text: "step", completed: false }],
    }), state)[0]).toMatchObject({
      kind: "item.updated",
      itemId: "codex:todo-1",
      patch: { op: "replace_payload", itemKind: "todo_list" },
    });

    expect(normalize(started({ id: "web-1", type: "web_search", query: "openai" }), state)[0]).toMatchObject({
      kind: "item.started",
      item: { kind: "web_search", payload: { query: "openai" } },
    });
  });
});

function normalize(event: ThreadEvent, state = createCodexV2NormalizerState()) {
  return normalizeCodexEventV2({
    taskId: "task-1",
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "cwd",
    event,
    state,
    ts: "2026-05-06T00:00:00.000Z",
  });
}

function started(item: Extract<ThreadEvent, { type: "item.started" }>["item"]): ThreadEvent {
  return { type: "item.started", item };
}

function updated(item: Extract<ThreadEvent, { type: "item.updated" }>["item"]): ThreadEvent {
  return { type: "item.updated", item };
}

function completed(item: Extract<ThreadEvent, { type: "item.completed" }>["item"]): ThreadEvent {
  return { type: "item.completed", item };
}

function command(id: string, aggregatedOutput: string): Extract<ThreadEvent, { type: "item.started" }>["item"] {
  return {
    id,
    type: "command_execution",
    command: "echo hello",
    aggregated_output: aggregatedOutput,
    status: "in_progress",
  };
}
