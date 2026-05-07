import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "../../src/orchestrator/event-hub.js";
import type { SqliteDatabase } from "../../src/storage/db.js";

describe("EventHub", () => {
  let db: SqliteDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("persists raw and canonical events before replaying them", async () => {
    db = new Database(":memory:");
    const hub = new EventHub(db, {});

    const envelope = hub.publish({
      runtime: "codex",
      taskId: "task-1",
      sessionId: "session-1",
      raw: { Authorization: "Bearer sk-1234567890abcdef1234567890abcd" },
      event: { kind: "task.queued" },
    });

    expect(envelope.seq).toBe(1);
    expect(envelope.taskSeq).toBe(1);
    expect(envelope.rawRef).toBeTruthy();

    const rawRow = db.prepare("SELECT redacted_json FROM raw_runtime_events WHERE id = ?").get(envelope.rawRef) as { redacted_json: string };
    expect(rawRow.redacted_json).toContain("[REDACTED]");
    expect(rawRow.redacted_json).not.toContain("sk-1234567890abcdef1234567890abcd");

    const replayed: unknown[] = [];
    const replay = await hub.replayAndSubscribe({
      taskId: "task-1",
      listener: (event) => replayed.push(event),
    });
    replay.unsubscribe();

    expect(replay.lastTaskSeq).toBe(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      v: 2,
      taskId: "task-1",
      taskSeq: 1,
      event: { kind: "task.queued" },
    });
  });

  it("increments taskSeq independently per task and fan-outs task-scoped events", async () => {
    db = new Database(":memory:");
    const hub = new EventHub(db, {});
    const live: Array<{ taskId: string; taskSeq: number }> = [];
    const unsubscribe = hub.subscribe({
      taskId: "task-a",
      listener: (event) => live.push({ taskId: event.taskId, taskSeq: event.taskSeq }),
    });

    const first = hub.publish({
      runtime: "claude",
      taskId: "task-a",
      sessionId: "session-a",
      event: { kind: "task.queued" },
    });
    const other = hub.publish({
      runtime: "codex",
      taskId: "task-b",
      sessionId: "session-b",
      event: { kind: "task.queued" },
    });
    const second = hub.publish({
      runtime: "claude",
      taskId: "task-a",
      sessionId: "session-a",
      event: { kind: "task.started", profileId: "profile", model: "model", cwd: "cwd" },
    });
    await nextTick();

    unsubscribe();

    expect(first.taskSeq).toBe(1);
    expect(other.taskSeq).toBe(1);
    expect(second.taskSeq).toBe(2);
    expect(live).toEqual([
      { taskId: "task-a", taskSeq: 1 },
      { taskId: "task-a", taskSeq: 2 },
    ]);
  });

  it("coalesces live command output without dropping persisted events", async () => {
    db = new Database(":memory:");
    const hub = new EventHub(db, { subscriberQueueSize: 1 });
    const live: string[] = [];
    const unsubscribe = hub.subscribe({
      taskId: "task-1",
      listener: (event) => {
        if (event.event.kind === "item.started") {
          live.push("started");
        }
        if (event.event.kind === "item.updated" && event.event.patch.op === "append_command_output") {
          live.push(event.event.patch.value.text);
        }
      },
    });
    const item = commandItem("cmd-1");
    hub.publish({ runtime: "codex", taskId: "task-1", sessionId: "session-1", event: { kind: "item.started", item } });
    await nextTick();
    hub.publish({
      runtime: "codex",
      taskId: "task-1",
      sessionId: "session-1",
      delivery: "coalescible",
      event: { kind: "item.updated", itemId: "cmd-1", patch: { op: "append_command_output", value: { stream: "stdout", text: "hello" }, baseLength: 0 } },
    });
    hub.publish({
      runtime: "codex",
      taskId: "task-1",
      sessionId: "session-1",
      delivery: "coalescible",
      event: { kind: "item.updated", itemId: "cmd-1", patch: { op: "append_command_output", value: { stream: "stdout", text: " world" }, baseLength: 5 } },
    });
    await nextTick();
    unsubscribe();

    const persisted = db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id = ?").get("task-1") as { count: number };
    expect(persisted.count).toBe(3);
    expect(live.join("")).toContain("hello world");
  });

  it("replaces unsafe coalescing with snapshot or resync notice", async () => {
    db = new Database(":memory:");
    const hub = new EventHub(db, { subscriberQueueSize: 1 });
    const live: string[] = [];
    hub.subscribe({
      taskId: "task-1",
      listener: (event) => {
        if (event.event.kind === "item.updated" && event.event.patch.op === "replace_payload") {
          live.push(event.event.patch.reason);
        }
        if (event.event.kind === "item.started" && event.event.item.kind === "system_notice") {
          const item = event.event.item as ReturnType<typeof systemNoticeItem>;
          live.push(item.payload.code);
        }
      },
    });

    hub.publish({ runtime: "codex", taskId: "task-1", sessionId: "session-1", event: { kind: "item.started", item: commandItem("cmd-1") } });
    await nextTick();
    hub.publish({
      runtime: "codex",
      taskId: "task-1",
      sessionId: "session-1",
      delivery: "coalescible",
      event: { kind: "item.updated", itemId: "cmd-1", patch: { op: "append_command_output", value: { stream: "stdout", text: "hello" }, baseLength: 0 } },
    });
    hub.publish({
      runtime: "codex",
      taskId: "task-1",
      sessionId: "session-1",
      delivery: "coalescible",
      event: { kind: "item.updated", itemId: "cmd-1", patch: { op: "append_command_output", value: { stream: "stdout", text: "bad" }, baseLength: 99 } },
    });
    await nextTick();

    expect(live).toContain("snapshot");
  });

  it("supports global replay, redacted raw lookup, and projection checks", () => {
    db = new Database(":memory:");
    const hub = new EventHub(db, {});

    const first = hub.publish({
      runtime: "claude",
      taskId: "task-1",
      sessionId: "session-1",
      raw: { Authorization: "Bearer sk-1234567890abcdef1234567890abcd" },
      event: { kind: "item.started", item: assistantItem("msg-1", "") },
    });
    hub.publish({
      runtime: "claude",
      taskId: "task-1",
      sessionId: "session-1",
      event: { kind: "item.completed", itemId: "msg-1", itemKind: "assistant_message", finalPayload: { text: "done" }, completedAt: "2026-05-07T00:00:00.000Z" },
    });
    hub.publish({
      runtime: "codex",
      taskId: "task-2",
      sessionId: "session-2",
      event: { kind: "task.queued" },
    });

    expect(hub.listEvents({ sinceGlobalSeq: 0, taskId: "task-1" }).events).toHaveLength(2);
    expect(hub.listEvents({ runtime: "codex" }).events[0]?.taskId).toBe("task-2");
    expect(hub.listEvents({ kind: "item.completed" }).events[0]?.event.kind).toBe("item.completed");
    expect(hub.getRedactedRawEvent(first.rawRef!)?.redacted).toBeDefined();
    expect(JSON.stringify(hub.getRedactedRawEvent(first.rawRef!)?.redacted)).not.toContain("sk-1234567890abcdef1234567890abcd");
    expect(hub.checkProjection("task-1")).toEqual([]);
  });

  it("projects item.started and item.completed into the items table", () => {
    db = new Database(":memory:");
    const hub = new EventHub(db, {});
    const ts = "2026-05-06T00:00:00.000Z";

    hub.publish({
      runtime: "claude",
      taskId: "task-1",
      sessionId: "session-1",
      turnId: "turn-1",
      event: {
        kind: "item.started",
        item: {
          id: "msg-1",
          taskId: "task-1",
          sessionId: "session-1",
          turnId: "turn-1",
          kind: "assistant_message",
          status: "in_progress",
          startedAt: ts,
          updatedAt: ts,
          payload: { text: "" },
        },
      },
    });
    hub.publish({
      runtime: "claude",
      taskId: "task-1",
      sessionId: "session-1",
      turnId: "turn-1",
      event: {
        kind: "item.completed",
        itemId: "msg-1",
        itemKind: "assistant_message",
        finalPayload: { text: "done" },
        completedAt: ts,
      },
    });

    const item = db.prepare("SELECT status, payload_json, first_task_seq, last_task_seq FROM items WHERE task_id = ? AND item_id = ?")
      .get("task-1", "msg-1") as { status: string; payload_json: string; first_task_seq: number; last_task_seq: number };

    expect(item.status).toBe("completed");
    expect(JSON.parse(item.payload_json)).toEqual({ text: "done" });
    expect(item.first_task_seq).toBe(1);
    expect(item.last_task_seq).toBe(2);
  });
});

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assistantItem(id: string, text: string) {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "assistant_message" as const,
    status: "in_progress" as const,
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    payload: { text },
  };
}

function commandItem(id: string) {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    kind: "command_execution" as const,
    status: "in_progress" as const,
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    payload: {
      command: "echo hello",
      cwd: "cwd",
      source: "model" as const,
      status: "in_progress" as const,
      aggregatedOutput: "",
      outputChunks: [],
    },
  };
}

function systemNoticeItem() {
  return {
    id: "notice",
    taskId: "task-1",
    sessionId: "session-1",
    kind: "system_notice" as const,
    status: "completed" as const,
    startedAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    payload: {
      level: "warning" as const,
      code: "stream_resync_required" as const,
      message: "resync",
    },
  };
}
