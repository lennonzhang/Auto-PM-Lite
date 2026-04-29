import { redactJson, type RedactionOptions } from "../core/redaction.js";
import type { AgentEvent } from "../core/types.js";
import type { SqliteDatabase } from "./db.js";

export interface EventStoreOptions {
  flushBatchSize: number;
  maxQueueSize: number;
  redaction?: RedactionOptions;
}

type PersistedEvent = {
  taskId: string;
  turnId: string | null;
  type: AgentEvent["type"];
  payloadJson: string;
  ts: string;
};

export class EventStore {
  private readonly queue: PersistedEvent[] = [];
  private readonly insertEvent;
  private readonly insertMany;
  private currentFlush: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: EventStoreOptions,
  ) {
    this.insertEvent = this.db.prepare(`
      INSERT INTO events (task_id, turn_id, type, payload_json, ts)
      VALUES (@taskId, @turnId, @type, @payloadJson, @ts)
    `);
    this.insertMany = this.db.transaction((items: PersistedEvent[]) => {
      for (const item of items) {
        this.insertEvent.run(item);
      }
    });
  }

  async append(event: AgentEvent): Promise<void> {
    if (this.closed) {
      throw new Error("EventStore is closed");
    }

    if (this.queue.length >= this.options.maxQueueSize) {
      throw new Error("EventStore queue exceeded maxQueueSize");
    }

    this.queue.push(this.toPersistedEvent(event));
    this.scheduleFlush();
    await this.currentFlush;
  }

  async flush(): Promise<void> {
    this.scheduleFlush();
    await this.currentFlush;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.currentFlush) {
      return;
    }

    this.currentFlush = Promise.resolve()
      .then(() => this.flushLoop())
      .finally(() => {
        this.currentFlush = null;
        if (this.queue.length > 0 && !this.closed) {
          this.scheduleFlush();
        }
      });
  }

  private flushLoop(): void {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.flushBatchSize);
      this.insertMany(batch);
    }
  }

  private toPersistedEvent(event: AgentEvent): PersistedEvent {
    const turnId = "turnId" in event && typeof event.turnId === "string" ? event.turnId : null;

    return {
      taskId: event.taskId,
      turnId,
      type: event.type,
      payloadJson: JSON.stringify(redactJson(event, this.options.redaction)),
      ts: event.ts,
    };
  }
}
