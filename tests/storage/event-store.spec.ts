import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/storage/event-store.js";

type PersistedRow = {
  taskId: string;
  turnId: string | null;
  type: string;
  payloadJson: string;
  ts: string;
};

function createFakeDb() {
  const rows: PersistedRow[] = [];

  return {
    rows,
    prepare() {
      return {
        run(item: PersistedRow) {
          rows.push(item);
        },
      };
    },
    transaction<T>(fn: (items: PersistedRow[]) => T) {
      return (items: PersistedRow[]) => fn(items);
    },
  };
}

describe("EventStore", () => {
  it("redacts event payloads before persistence", async () => {
    const fakeDb = createFakeDb();
    const store = new EventStore(fakeDb as never, {
      flushBatchSize: 10,
      maxQueueSize: 10,
    });

    await store.append({
      type: "message.completed",
      taskId: "task-1",
      text: "Authorization: Bearer sk-1234567890abcdef1234567890abcd",
      ts: new Date().toISOString(),
    });

    await store.close();

    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.rows[0]?.payloadJson).toContain("[REDACTED]");
    expect(fakeDb.rows[0]?.payloadJson).not.toContain("sk-1234567890abcdef1234567890abcd");
  });

  it("rejects writes after close", async () => {
    const fakeDb = createFakeDb();
    const store = new EventStore(fakeDb as never, {
      flushBatchSize: 10,
      maxQueueSize: 10,
    });

    await store.close();

    await expect(store.append({
      type: "task.queued",
      taskId: "task-2",
      ts: new Date().toISOString(),
    })).rejects.toThrow("EventStore is closed");
  });
});
