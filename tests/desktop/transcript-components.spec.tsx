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
    expect(shell).toContain("$ pwd");
    expect(shell).toContain("# cwd: repo");
    expect(shell).toContain("running");
    expect(unknown).toContain("data-tool-renderer=\"generic_json_tool\"");
  });

  it("renders resync state from reducer", () => {
    const view = createTaskViewModel("task-1");
    const html = renderToStaticMarkup(<TranscriptView view={{ ...view, resyncRequired: true }} />);

    expect(html).toContain("transcript-resync");
  });

  it("renders every major v2 item kind through transcript rows", () => {
    const items: AgentItem[] = [
      userItem("user-1", "prompt"),
      assistantItem("assistant-1", "answer"),
      reasoningItem("reasoning-1"),
      commandItem("cmd-1"),
      toolItem("Read"),
      fileChangeItem("file-1"),
      todoItem("todo-1"),
      webSearchItem("web-1"),
      delegationItem("delegation-1"),
      compactionItem("compact-1"),
      noticeItem("notice-1"),
    ];

    const html = items.map((item) => renderToStaticMarkup(<TranscriptItemRow item={item} />)).join("\n");

    for (const kind of [
      "user_message",
      "assistant_message",
      "reasoning",
      "command_execution",
      "tool_call",
      "file_change",
      "todo_list",
      "web_search",
      "delegation",
      "context_compaction",
      "system_notice",
    ]) {
      expect(html).toContain(`data-testid="transcript-item-${kind}"`);
    }
    expect(html).toContain("File Change");
    expect(html).toContain("compact_started");
    expect(html).toContain("child-task");
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
  const input = name === "Read" ? { file_path: "src/index.ts" } : { command: "pwd", cwd: "repo" };
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
      input,
      inputText: JSON.stringify(input),
    },
  };
}

function userItem(id: string, text: string): AgentItem<"user_message"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "user_message",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { text },
  };
}

function reasoningItem(id: string): AgentItem<"reasoning"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "reasoning",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { summary: ["summary"], content: ["detail"], redacted: false },
  };
}

function fileChangeItem(id: string): AgentItem<"file_change"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "file_change",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { changes: [{ path: "a.txt", changeKind: "modify", binary: false }], status: "applied" },
  };
}

function todoItem(id: string): AgentItem<"todo_list"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "todo_list",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { items: [{ text: "done", completed: true }] },
  };
}

function webSearchItem(id: string): AgentItem<"web_search"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "web_search",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { query: "Auto-PM", results: [{ title: "result", url: "https://example.test" }] },
  };
}

function delegationItem(id: string): AgentItem<"delegation"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "delegation",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { childTaskId: "child-task", status: "completed", prompt: "delegate", finalResponse: "done" },
  };
}

function compactionItem(id: string): AgentItem<"context_compaction"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "context_compaction",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { trigger: "auto", preTokens: 100, postTokens: 50, status: "completed" },
  };
}

function noticeItem(id: string): AgentItem<"system_notice"> {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "system_notice",
    status: "completed",
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    completedAt: "2026-05-07T00:00:00.000Z",
    payload: { level: "info", code: "compact_started", message: "Compacting" },
  };
}
