import { randomUUID } from "node:crypto";
import { redactJson, type RedactionOptions } from "../core/redaction.js";
import type {
  AgentItem,
  CanonicalEvent,
  DeliveryTier,
  EventEnvelope,
  ItemEvent,
  ItemPatch,
  RedactedRawRuntimeEvent,
} from "../core/events.js";
import { validateCanonicalEvent } from "../core/events.js";
import type { RuntimeKind } from "../core/types.js";
import type { SqliteDatabase } from "../storage/db.js";

export interface EventHubOptions {
  redaction?: RedactionOptions | undefined;
}

export interface PublishInput {
  runtime: RuntimeKind;
  taskId: string;
  sessionId: string;
  turnId?: string | undefined;
  itemId?: string | undefined;
  parentItemId?: string | undefined;
  ts?: string | undefined;
  delivery?: DeliveryTier | undefined;
  raw?: unknown;
  event: CanonicalEvent;
}

export interface ReplayAndSubscribeInput {
  taskId: string;
  sinceTaskSeq?: number | undefined;
  listener: (event: EventEnvelope) => void;
}

export type EventHubListener = (event: EventEnvelope) => void;

type EventRow = {
  seq: number;
  task_seq: number;
  event_id: string;
  runtime: string;
  task_id: string;
  session_id: string;
  turn_id: string | null;
  item_id: string | null;
  parent_item_id: string | null;
  ts: string;
  raw_ref: string | null;
  delivery: DeliveryTier;
  event_json: string;
};

type ItemRow = {
  kind: string;
  status: string;
  payload_json: string;
};

export class EventHub {
  private readonly taskListeners = new Map<string, Set<EventHubListener>>();
  private readonly insertRaw;
  private readonly insertEvent;
  private readonly upsertCounter;
  private readonly selectCounter;
  private readonly updateCounter;
  private readonly upsertItem;
  private readonly selectItem;
  private readonly updateItemFromEvent;
  private readonly selectEvents;
  private readonly publishTx;
  private closed = false;

  constructor(private readonly db: SqliteDatabase, private readonly options: EventHubOptions = {}) {
    this.ensureSchema();
    this.insertRaw = this.db.prepare(`
      INSERT INTO raw_runtime_events (id, task_id, runtime, session_id, turn_id, ts, redacted_json, encrypted_raw_blob, ttl_at)
      VALUES (@id, @taskId, @runtime, @sessionId, @turnId, @ts, @redactedJson, @encryptedRawBlob, @ttlAt)
    `);
    this.insertEvent = this.db.prepare(`
      INSERT INTO events (
        event_id, task_id, task_seq, runtime, session_id, turn_id, item_id, parent_item_id,
        ts, raw_ref, delivery, event_json
      )
      VALUES (
        @eventId, @taskId, @taskSeq, @runtime, @sessionId, @turnId, @itemId, @parentItemId,
        @ts, @rawRef, @delivery, @eventJson
      )
    `);
    this.upsertCounter = this.db.prepare(`
      INSERT OR IGNORE INTO task_event_counters (task_id, next_task_seq)
      VALUES (?, 1)
    `);
    this.selectCounter = this.db.prepare(`
      SELECT next_task_seq AS nextTaskSeq
      FROM task_event_counters
      WHERE task_id = ?
    `);
    this.updateCounter = this.db.prepare(`
      UPDATE task_event_counters
      SET next_task_seq = ?
      WHERE task_id = ?
    `);
    this.upsertItem = this.db.prepare(`
      INSERT INTO items (
        task_id, item_id, session_id, turn_id, parent_item_id, kind, status,
        started_at, updated_at, completed_at, payload_json, error_json,
        first_task_seq, last_task_seq
      )
      VALUES (
        @taskId, @itemId, @sessionId, @turnId, @parentItemId, @kind, @status,
        @startedAt, @updatedAt, @completedAt, @payloadJson, @errorJson,
        @firstTaskSeq, @lastTaskSeq
      )
      ON CONFLICT(task_id, item_id) DO UPDATE SET
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        parent_item_id = excluded.parent_item_id,
        kind = excluded.kind,
        status = excluded.status,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        payload_json = excluded.payload_json,
        error_json = excluded.error_json,
        last_task_seq = excluded.last_task_seq
    `);
    this.selectItem = this.db.prepare(`
      SELECT kind, status, payload_json
      FROM items
      WHERE task_id = @taskId AND item_id = @itemId
    `);
    this.updateItemFromEvent = this.db.prepare(`
      UPDATE items
      SET status = @status,
          updated_at = @updatedAt,
          completed_at = @completedAt,
          payload_json = COALESCE(@payloadJson, payload_json),
          error_json = CASE WHEN @errorJsonSet THEN @errorJson ELSE error_json END,
          last_task_seq = @lastTaskSeq
      WHERE task_id = @taskId AND item_id = @itemId
    `);
    this.selectEvents = this.db.prepare(`
      SELECT seq, task_seq, event_id, runtime, task_id, session_id, turn_id, item_id, parent_item_id,
             ts, raw_ref, delivery, event_json
      FROM events
      WHERE task_id = @taskId AND task_seq > @sinceTaskSeq
      ORDER BY task_seq ASC
      LIMIT @limit
    `);
    this.publishTx = this.db.transaction((input: RequiredPublishInput) => {
      const rawRef = input.raw ? this.writeRaw(input) : null;
      this.upsertCounter.run(input.taskId);
      const counter = this.selectCounter.get(input.taskId) as { nextTaskSeq: number } | undefined;
      const taskSeq = counter?.nextTaskSeq ?? 1;
      this.updateCounter.run(taskSeq + 1, input.taskId);
      const eventId = randomUUID();
      this.insertEvent.run({
        eventId,
        taskId: input.taskId,
        taskSeq,
        runtime: input.runtime,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        itemId: input.itemId ?? null,
        parentItemId: input.parentItemId ?? null,
        ts: input.ts,
        rawRef,
        delivery: input.delivery,
        eventJson: JSON.stringify(input.event),
      });
      const seqRow = this.db.prepare("SELECT last_insert_rowid() AS seq").get() as { seq: number };
      const seq = Number(seqRow.seq);
      const envelope: EventEnvelope = {
        v: 2,
        eventId,
        seq,
        taskSeq,
        runtime: input.runtime,
        taskId: input.taskId,
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
        ts: input.ts,
        ...(rawRef ? { rawRef } : {}),
        delivery: input.delivery,
        event: input.event,
      };
      this.projectItem(envelope);
      return envelope;
    });
  }

  publish(input: PublishInput): EventEnvelope {
    if (this.closed) {
      throw new Error("EventHub is closed");
    }
    const event = validateCanonicalEvent(input.event);
    const itemIds = inferItemIds(event);
    const txInput: RequiredPublishInput = {
      runtime: input.runtime,
      taskId: input.taskId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      itemId: input.itemId ?? itemIds.itemId,
      parentItemId: input.parentItemId ?? itemIds.parentItemId,
      ts: input.ts ?? new Date().toISOString(),
      delivery: input.delivery ?? defaultDelivery(event),
      raw: input.raw,
      event,
    };
    const envelope = this.publishTx(txInput);
    this.fanOut(envelope);
    return envelope;
  }

  async replayAndSubscribe(input: ReplayAndSubscribeInput): Promise<{ unsubscribe: () => void; lastTaskSeq: number }> {
    if (this.closed) {
      throw new Error("EventHub is closed");
    }
    let cursor = input.sinceTaskSeq ?? 0;
    while (true) {
      const rows = this.selectEvents.all({ taskId: input.taskId, sinceTaskSeq: cursor, limit: 500 }) as EventRow[];
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const envelope = rowToEnvelope(row);
        input.listener(envelope);
        cursor = envelope.taskSeq;
      }
    }
    const unsubscribe = this.subscribe({ taskId: input.taskId, listener: input.listener });
    return { unsubscribe, lastTaskSeq: cursor };
  }

  subscribe(input: { taskId: string; listener: EventHubListener }): () => void {
    if (this.closed) {
      throw new Error("EventHub is closed");
    }
    let listeners = this.taskListeners.get(input.taskId);
    if (!listeners) {
      listeners = new Set<EventHubListener>();
      this.taskListeners.set(input.taskId, listeners);
    }
    listeners.add(input.listener);
    return () => {
      listeners?.delete(input.listener);
      if (listeners?.size === 0) {
        this.taskListeners.delete(input.taskId);
      }
    };
  }

  close(): void {
    this.closed = true;
    this.taskListeners.clear();
  }

  private writeRaw(input: RequiredPublishInput): string {
    const rawRef = randomUUID();
    const raw: RedactedRawRuntimeEvent = {
      runtime: input.runtime,
      taskId: input.taskId,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ts: input.ts,
      redacted: redactJson(input.raw, this.options.redaction),
    };
    this.insertRaw.run({
      id: rawRef,
      taskId: raw.taskId,
      runtime: raw.runtime,
      sessionId: raw.sessionId ?? null,
      turnId: raw.turnId ?? null,
      ts: raw.ts,
      redactedJson: JSON.stringify(raw.redacted),
      encryptedRawBlob: raw.encryptedRawBlob ?? null,
      ttlAt: raw.ttlAt ?? null,
    });
    return rawRef;
  }

  private projectItem(envelope: EventEnvelope): void {
    const event = envelope.event;
    if (event.kind === "item.started") {
      this.writeItem(event.item, envelope.taskSeq);
      return;
    }
    if (event.kind === "item.completed") {
      this.updateItem({
        taskId: envelope.taskId,
        itemId: event.itemId,
        status: "completed",
        updatedAt: event.completedAt,
        completedAt: event.completedAt,
        payloadJson: JSON.stringify(event.finalPayload),
        errorJson: null,
        errorJsonSet: true,
        lastTaskSeq: envelope.taskSeq,
      });
      return;
    }
    if (event.kind === "item.updated") {
      const row = this.selectItem.get({ taskId: envelope.taskId, itemId: event.itemId }) as ItemRow | undefined;
      if (!row) {
        return;
      }
      const applied = applyItemPatch(row.kind, row.status, JSON.parse(row.payload_json) as Record<string, unknown>, event.patch);
      this.updateItem({
        taskId: envelope.taskId,
        itemId: event.itemId,
        status: applied.status,
        updatedAt: envelope.ts,
        completedAt: null,
        payloadJson: JSON.stringify(applied.payload),
        lastTaskSeq: envelope.taskSeq,
      });
      return;
    }
    if (event.kind === "item.failed") {
      this.updateItem({
        taskId: envelope.taskId,
        itemId: event.itemId,
        status: "failed",
        updatedAt: event.completedAt,
        completedAt: event.completedAt,
        payloadJson: undefined,
        errorJson: JSON.stringify(event.error),
        errorJsonSet: true,
        lastTaskSeq: envelope.taskSeq,
      });
      return;
    }
    if (event.kind === "item.cancelled") {
      this.updateItem({
        taskId: envelope.taskId,
        itemId: event.itemId,
        status: "cancelled",
        updatedAt: event.completedAt,
        completedAt: event.completedAt,
        payloadJson: undefined,
        errorJson: null,
        errorJsonSet: false,
        lastTaskSeq: envelope.taskSeq,
      });
    }
  }

  private writeItem(item: AgentItem, taskSeq: number): void {
    this.upsertItem.run({
      taskId: item.taskId,
      itemId: item.id,
      sessionId: item.sessionId,
      turnId: item.turnId ?? null,
      parentItemId: item.parentItemId ?? null,
      kind: item.kind,
      status: item.status,
      startedAt: item.startedAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt ?? null,
      payloadJson: JSON.stringify(item.payload),
      errorJson: item.error ? JSON.stringify(item.error) : null,
      firstTaskSeq: taskSeq,
      lastTaskSeq: taskSeq,
    });
  }

  private updateItem(input: {
    taskId: string;
    itemId: string;
    status: string;
    updatedAt: string;
    completedAt: string | null;
    payloadJson?: string | undefined;
    errorJson?: string | null | undefined;
    errorJsonSet?: boolean | undefined;
    lastTaskSeq: number;
  }): void {
    this.updateItemFromEvent.run({
      ...input,
      payloadJson: input.payloadJson ?? null,
      errorJson: input.errorJson ?? null,
      errorJsonSet: input.errorJsonSet ? 1 : 0,
    });
  }

  private fanOut(envelope: EventEnvelope): void {
    const listeners = this.taskListeners.get(envelope.taskId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch (error) {
        console.error("EventHub listener error:", error);
      }
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_runtime_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        ts TEXT NOT NULL,
        redacted_json TEXT NOT NULL,
        encrypted_raw_blob BLOB,
        ttl_at TEXT
      );
      CREATE INDEX IF NOT EXISTS raw_runtime_events_task_idx ON raw_runtime_events(task_id, ts);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        task_seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT,
        parent_item_id TEXT,
        ts TEXT NOT NULL,
        raw_ref TEXT,
        delivery TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_seq_idx ON events(task_id, task_seq);
      CREATE INDEX IF NOT EXISTS events_task_item_idx ON events(task_id, item_id);

      CREATE TABLE IF NOT EXISTS items (
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        parent_item_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        payload_json TEXT NOT NULL,
        error_json TEXT,
        first_task_seq INTEGER NOT NULL,
        last_task_seq INTEGER NOT NULL,
        PRIMARY KEY (task_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS items_task_order_idx ON items(task_id, first_task_seq);

      CREATE TABLE IF NOT EXISTS task_event_counters (
        task_id TEXT PRIMARY KEY,
        next_task_seq INTEGER NOT NULL
      );
    `);
  }
}

interface RequiredPublishInput extends Omit<PublishInput, "event"> {
  ts: string;
  delivery: DeliveryTier;
  event: CanonicalEvent;
}

function inferItemIds(event: CanonicalEvent): { itemId?: string; parentItemId?: string } {
  if (event.kind === "item.started") {
    return {
      itemId: event.item.id,
      ...(event.item.parentItemId ? { parentItemId: event.item.parentItemId } : {}),
    };
  }
  if (isItemTerminalOrUpdate(event)) {
    return { itemId: event.itemId };
  }
  return {};
}

function isItemTerminalOrUpdate(event: CanonicalEvent): event is Exclude<ItemEvent, { kind: "item.started" }> {
  return event.kind === "item.updated"
    || event.kind === "item.completed"
    || event.kind === "item.failed"
    || event.kind === "item.cancelled";
}

function defaultDelivery(event: CanonicalEvent): DeliveryTier {
  if (event.kind === "item.updated") {
    const patch = event.patch;
    if (patch.op === "append_command_output" || patch.op === "append_tool_input_json" || patch.op === "merge_payload") {
      return "coalescible";
    }
  }
  return "lossless";
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    v: 2,
    eventId: row.event_id,
    seq: row.seq,
    taskSeq: row.task_seq,
    runtime: row.runtime as RuntimeKind,
    taskId: row.task_id,
    sessionId: row.session_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.item_id ? { itemId: row.item_id } : {}),
    ...(row.parent_item_id ? { parentItemId: row.parent_item_id } : {}),
    ts: row.ts,
    ...(row.raw_ref ? { rawRef: row.raw_ref } : {}),
    delivery: row.delivery,
    event: validateCanonicalEvent(JSON.parse(row.event_json)),
  };
}

function applyItemPatch(kind: string, status: string, payload: Record<string, unknown>, patch: ItemPatch): { status: string; payload: Record<string, unknown> } {
  switch (patch.op) {
    case "append_text": {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text.length !== patch.baseLength) {
        return { status, payload };
      }
      return { status, payload: { ...payload, text: text + patch.value } };
    }
    case "append_array_text": {
      const key = patch.path === "payload.summary" ? "summary" : "content";
      const values = Array.isArray(payload[key]) ? [...payload[key]] : [];
      const current = typeof values[patch.index] === "string" ? values[patch.index] : "";
      if (current.length !== patch.baseLength) {
        return { status, payload };
      }
      values[patch.index] = current + patch.value;
      return { status, payload: { ...payload, [key]: values } };
    }
    case "append_command_output": {
      const aggregatedOutput = typeof payload.aggregatedOutput === "string" ? payload.aggregatedOutput : "";
      if (aggregatedOutput.length !== patch.baseLength) {
        return { status, payload };
      }
      const outputChunks = Array.isArray(payload.outputChunks) ? [...payload.outputChunks] : [];
      return {
        status,
        payload: {
          ...payload,
          aggregatedOutput: aggregatedOutput + patch.value.text,
          outputChunks: [...outputChunks, patch.value],
        },
      };
    }
    case "append_tool_input_json": {
      const inputText = typeof payload.inputText === "string" ? payload.inputText : "";
      if (inputText.length !== patch.baseLength) {
        return { status, payload };
      }
      return {
        status,
        payload: {
          ...payload,
          inputText: inputText + patch.value,
          ...(patch.partialParsed === undefined ? {} : { input: patch.partialParsed }),
        },
      };
    }
    case "merge_payload":
      return { status, payload: { ...payload, ...patch.value } };
    case "replace_payload":
      return patch.itemKind === kind
        ? { status, payload: patch.value as Record<string, unknown> }
        : { status, payload };
    case "set_status":
      return { status: patch.status, payload };
    case "set_tool_phase":
      return {
        status,
        payload: {
          ...payload,
          phase: patch.phase,
        },
      };
  }
}
