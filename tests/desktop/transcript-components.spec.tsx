import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentItem } from "../../src/core/events.js";
import { TranscriptItemRow, TranscriptView } from "../../src/desktop/renderer/src/transcript-components.js";
import { createTaskViewModel, reduceTaskEvents } from "../../src/desktop/renderer/src/transcript-reducer.js";

describe("v2 transcript components", () => {
  it("renders item rows from TaskViewModel instead of raw event summaries", () => {
    const view = reduceTaskEvents("task-1", [
      envelope(1, { kind: "item.started", item: assistantItem("msg-1", "hello") }),
      envelope(2, { kind: "item.started", item: commandItem("cmd-1") }),
      envelope(3, {
        kind: "item.updated",
        itemId: "cmd-1",
        patch: { op: "append_command_output", value: { stream: "stdout", text: "out" }, baseLength: 0 },
      }),
    ]);

    const html = renderToStaticMarkup(<TranscriptView view={view} />);

    expect(html).toContain("data-testid=\"v2-transcript\"");
    expect(html).toContain("hello");
    expect(html).toContain("echo hello");
    expect(html).toContain("stdout");
    expect(html).not.toContain("item.updated");
  });

  it("uses specialized tool renderer and generic fallback for tool calls", () => {
    const shell = renderToStaticMarkup(<TranscriptItemRow item={toolItem("Bash")} />);
    const unknown = renderToStaticMarkup(<TranscriptItemRow item={toolItem("MysteryTool")} />);

    expect(shell).toContain("data-tool-renderer=\"shell\"");
    expect(shell).toContain("running");
    expect(unknown).toContain("data-tool-renderer=\"generic_json_tool\"");
  });

  it("renders resync state from reducer", () => {
    const view = createTaskViewModel("task-1");
    const html = renderToStaticMarkup(<TranscriptView view={{ ...view, resyncRequired: true }} />);

    expect(html).toContain("transcript-resync");
  });
});

function envelope(taskSeq: number, event: Parameters<typeof reduceTaskEvents>[1][number]["event"]) {
  return {
    v: 2 as const,
    eventId: `event-${taskSeq}`,
    seq: taskSeq,
    taskSeq,
    runtime: "claude" as const,
    taskId: "task-1",
    sessionId: "session-1",
    ts: `2026-05-07T00:00:0${taskSeq}.000Z`,
    delivery: "lossless" as const,
    event,
  };
}

function assistantItem(id: string, text: string): AgentItem<"assistant_message"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "assistant_message",
    status: "in_progress",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    payload: { text },
  };
}

function commandItem(id: string): AgentItem<"command_execution"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "command_execution",
    status: "in_progress",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    payload: {
      command: "echo hello",
      cwd: "cwd",
      source: "model",
      status: "in_progress",
      aggregatedOutput: "",
      outputChunks: [],
    },
  };
}

function toolItem(name: string): AgentItem<"tool_call"> {
  return {
    id: `tool-${name}`,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "tool_call",
    status: "in_progress",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    payload: {
      tool: { runtime: "claude", name },
      phase: "running",
      input: { command: "pwd" },
      inputText: "{\"command\":\"pwd\"}",
    },
  };
}
