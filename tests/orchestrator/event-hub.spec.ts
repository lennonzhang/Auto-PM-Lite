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

    unsubscribe();

    expect(first.taskSeq).toBe(1);
    expect(other.taskSeq).toBe(1);
    expect(second.taskSeq).toBe(2);
    expect(live).toEqual([
      { taskId: "task-a", taskSeq: 1 },
      { taskId: "task-a", taskSeq: 2 },
    ]);
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
