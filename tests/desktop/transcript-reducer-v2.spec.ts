import { describe, expect, it } from "vitest";
import { createTaskViewModel, reduceTaskEvents, reduceTaskView } from "../../src/desktop/renderer/src/transcript-reducer.js";
import type { AgentItem, EventEnvelope } from "../../src/core/events.js";

describe("v2 transcript reducer", () => {
  it("ignores duplicate taskSeq events", () => {
    const first = envelope(1, { kind: "task.queued" });
    const duplicate = { ...first, event: { kind: "task.started", profileId: "p", model: "m", cwd: "cwd" } } satisfies EventEnvelope;

    let vm = createTaskViewModel("task-1");
    vm = reduceTaskView(vm, first);
    vm = reduceTaskView(vm, duplicate);

    expect(vm.status).toBe("queued");
    expect(vm.lastTaskSeq).toBe(1);
  });

  it("marks resyncRequired on append baseLength mismatch", () => {
    const item = assistantItem("msg-1", "hello");
    const vm = reduceTaskEvents("task-1", [
      envelope(1, { kind: "item.started", item }),
      envelope(2, {
        kind: "item.updated",
        itemId: "msg-1",
        patch: { op: "append_text", path: "payload.text", value: " world", baseLength: 0 },
      }),
    ]);

    expect(vm.resyncRequired).toBe(true);
    expect(vm.items.get("msg-1")?.payload).toEqual({ text: "hello" });
  });

  it("uses item.completed finalPayload as authoritative state", () => {
    const vm = reduceTaskEvents("task-1", [
      envelope(1, { kind: "item.started", item: assistantItem("msg-1", "") }),
      envelope(2, {
        kind: "item.updated",
        itemId: "msg-1",
        patch: { op: "append_text", path: "payload.text", value: "partial", baseLength: 0 },
      }),
      envelope(3, {
        kind: "item.completed",
        itemId: "msg-1",
        itemKind: "assistant_message",
        finalPayload: { text: "final" },
        completedAt: "2026-05-06T00:00:03.000Z",
      }),
    ]);

    expect(vm.items.get("msg-1")?.status).toBe("completed");
    expect(vm.items.get("msg-1")?.payload).toEqual({ text: "final" });
  });

  it("builds parent-child item trees without timestamp sorting", () => {
    const parent = assistantItem("parent", "");
    const child = {
      ...assistantItem("child", ""),
      parentItemId: "parent",
    } satisfies AgentItem<"assistant_message">;

    const vm = reduceTaskEvents("task-1", [
      envelope(1, { kind: "item.started", item: parent }),
      envelope(2, { kind: "item.started", item: child }),
    ]);

    expect(vm.rootItemOrder).toEqual(["parent"]);
    expect(vm.childrenByParentId.get("parent")).toEqual(["child"]);
  });

  it("produces the same command output for coalesced and uncoalesced patches", () => {
    const uncoalesced = reduceTaskEvents("task-1", [
      envelope(1, { kind: "item.started", item: commandItem("cmd-1") }),
      envelope(2, {
        kind: "item.updated",
        itemId: "cmd-1",
        patch: { op: "append_command_output", value: { stream: "stdout", text: "hello" }, baseLength: 0 },
      }),
      envelope(3, {
        kind: "item.updated",
        itemId: "cmd-1",
        patch: { op: "append_command_output", value: { stream: "stdout", text: " world" }, baseLength: 5 },
      }),
    ]);
    const coalesced = reduceTaskEvents("task-1", [
      envelope(1, { kind: "item.started", item: commandItem("cmd-1") }),
      envelope(2, {
        kind: "item.updated",
        itemId: "cmd-1",
        patch: { op: "append_command_output", value: { stream: "stdout", text: "hello world" }, baseLength: 0 },
      }),
    ]);

    expect(uncoalesced.items.get("cmd-1")?.payload).toMatchObject({ aggregatedOutput: "hello world" });
    expect(coalesced.items.get("cmd-1")?.payload).toMatchObject({ aggregatedOutput: "hello world" });
  });

  it("reduces every major v2 item kind into the task view model", () => {
    const items = majorItems();
    const vm = reduceTaskEvents("task-1", items.map((item, index) => envelope(index + 1, { kind: "item.started", item })));

    expect([...vm.items.values()].map((item) => item.kind)).toEqual([
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
    ]);
    expect(vm.rootItemOrder).toEqual(items.map((item) => item.id));
    expect(vm.resyncRequired).toBe(false);
  });
});

function envelope(taskSeq: number, event: EventEnvelope["event"]): EventEnvelope {
  return {
    v: 2,
    eventId: `event-${taskSeq}`,
    seq: taskSeq,
    taskSeq,
    runtime: "claude",
    taskId: "task-1",
    sessionId: "session-1",
    ts: `2026-05-06T00:00:0${taskSeq}.000Z`,
    delivery: "lossless",
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
    startedAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
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
    startedAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
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

function majorItems(): AgentItem[] {
  return [
    {
      id: "user-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "user_message",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { text: "prompt" },
    },
    assistantItem("assistant-1", "answer"),
    {
      id: "reasoning-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "reasoning",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { summary: ["summary"], content: ["detail"], redacted: false },
    },
    commandItem("cmd-1"),
    {
      id: "tool-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "tool_call",
      status: "in_progress",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      payload: {
        tool: { runtime: "claude", name: "Bash" },
        phase: "running",
        input: { command: "pwd" },
        inputText: "{\"command\":\"pwd\"}",
      },
    },
    {
      id: "file-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "file_change",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { changes: [{ path: "a.txt", changeKind: "modify", binary: false }], status: "applied" },
    },
    {
      id: "todo-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "todo_list",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { items: [{ text: "done", completed: true }] },
    },
    {
      id: "web-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "web_search",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { query: "openai", results: [{ title: "OpenAI", url: "https://openai.com" }] },
    },
    {
      id: "delegation-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "delegation",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { childTaskId: "child-task", status: "completed", prompt: "delegate", finalResponse: "done" },
    },
    {
      id: "compact-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "context_compaction",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { trigger: "auto", preTokens: 100, postTokens: 40, status: "completed" },
    },
    {
      id: "notice-1",
      taskId: "task-1",
      sessionId: "session-1",
      kind: "system_notice",
      status: "completed",
      startedAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
      payload: { level: "info", code: "runtime_notice", message: "notice" },
    },
  ];
}
