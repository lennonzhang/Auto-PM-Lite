import { randomUUID } from "node:crypto";
import { redactJson, type RedactionOptions } from "../core/redaction.js";
import type {
  AgentItem,
  CanonicalEvent,
  DeliveryTier,
  EventEnvelope,
  ItemKind,
  ItemEvent,
  ItemPatch,
  ItemPayload,
  RedactedRawRuntimeEvent,
} from "../core/events.js";
import { validateCanonicalEvent } from "../core/events.js";
import type { RuntimeKind } from "../core/types.js";
import type { SqliteDatabase } from "../storage/db.js";

export interface EventHubOptions {
  redaction?: RedactionOptions | undefined;
  subscriberQueueSize?: number | undefined;
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

export interface ListEventsInput {
  sinceGlobalSeq?: number | undefined;
  limit?: number | undefined;
  taskId?: string | undefined;
  runtime?: RuntimeKind | undefined;
  kind?: string | undefined;
}

export interface RedactedRawEventView {
  rawRef: string;
  runtime: RuntimeKind;
  taskId: string;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  ts: string;
  redacted: unknown;
}

export interface ProjectionMismatch {
  taskId: string;
  itemId: string;
  field: string;
  expected: unknown;
  actual: unknown;
  lastTaskSeq?: number | undefined;
}

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
  item_id?: string;
  kind: string;
  status: string;
  payload_json: string;
  last_task_seq?: number;
};

interface Subscriber {
  id: string;
  taskId: string;
  listener: EventHubListener;
  queue: EventEnvelope[];
  flushing: boolean;
  closed: boolean;
  maxQueueSize: number;
}

export class EventHub {
  private readonly subscribersByTask = new Map<string, Set<Subscriber>>();
  private readonly insertRaw;
  private readonly insertEvent;
  private readonly upsertCounter;
  private readonly selectCounter;
  private readonly updateCounter;
  private readonly upsertItem;
  private readonly selectItem;
  private readonly updateItemFromEvent;
  private readonly selectEvents;
  private readonly selectGlobalEvents;
  private readonly selectRaw;
  private readonly selectProjectedItems;
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
    this.selectGlobalEvents = this.db.prepare(`
      SELECT seq, task_seq, event_id, runtime, task_id, session_id, turn_id, item_id, parent_item_id,
             ts, raw_ref, delivery, event_json
      FROM events
      WHERE seq > @sinceGlobalSeq
        AND (@taskId IS NULL OR task_id = @taskId)
        AND (@runtime IS NULL OR runtime = @runtime)
        AND (@kind IS NULL OR json_extract(event_json, '$.kind') = @kind)
      ORDER BY seq ASC
      LIMIT @limit
    `);
    this.selectRaw = this.db.prepare(`
      SELECT id, task_id, runtime, session_id, turn_id, ts, redacted_json
      FROM raw_runtime_events
      WHERE id = ?
    `);
    this.selectProjectedItems = this.db.prepare(`
      SELECT item_id, kind, status, payload_json, last_task_seq
      FROM items
      WHERE task_id = ?
      ORDER BY first_task_seq ASC
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
    const subscriber: Subscriber = {
      id: randomUUID(),
      taskId: input.taskId,
      listener: input.listener,
      queue: [],
      flushing: false,
      closed: false,
      maxQueueSize: this.options.subscriberQueueSize ?? 500,
    };
    let subscribers = this.subscribersByTask.get(input.taskId);
    if (!subscribers) {
      subscribers = new Set<Subscriber>();
      this.subscribersByTask.set(input.taskId, subscribers);
    }
    subscribers.add(subscriber);
    return () => {
      subscriber.closed = true;
      subscriber.queue = [];
      subscribers?.delete(subscriber);
      if (subscribers?.size === 0) {
        this.subscribersByTask.delete(input.taskId);
      }
    };
  }

  listEvents(input: ListEventsInput = {}): { events: EventEnvelope[]; lastGlobalSeq: number } {
    const rows = this.selectGlobalEvents.all({
      sinceGlobalSeq: input.sinceGlobalSeq ?? 0,
      limit: input.limit && input.limit > 0 ? Math.min(input.limit, 5000) : 500,
      taskId: input.taskId ?? null,
      runtime: input.runtime ?? null,
      kind: input.kind ?? null,
    }) as EventRow[];
    const events = rows.map(rowToEnvelope);
    return {
      events,
      lastGlobalSeq: events.at(-1)?.seq ?? input.sinceGlobalSeq ?? 0,
    };
  }

  getRedactedRawEvent(rawRef: string): RedactedRawEventView | null {
    const row = this.selectRaw.get(rawRef) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      rawRef: String(row.id),
      runtime: String(row.runtime) as RuntimeKind,
      taskId: String(row.task_id),
      ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
      ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
      ts: String(row.ts),
      redacted: JSON.parse(String(row.redacted_json)),
    };
  }

  checkProjection(taskId: string): ProjectionMismatch[] {
    const replay = new Map<string, { kind: string; status: string; payload: unknown; lastTaskSeq: number }>();
    for (const row of this.selectEvents.all({ taskId, sinceTaskSeq: 0, limit: 100000 }) as EventRow[]) {
      const envelope = rowToEnvelope(row);
      const event = envelope.event;
      if (event.kind === "item.started") {
        replay.set(event.item.id, {
          kind: event.item.kind,
          status: event.item.status,
          payload: event.item.payload,
          lastTaskSeq: envelope.taskSeq,
        });
      } else if (event.kind === "item.updated") {
        const current = replay.get(event.itemId);
        if (current) {
          const applied = applyItemPatch(current.kind, current.status, cloneRecord(current.payload), event.patch);
          replay.set(event.itemId, {
            kind: current.kind,
            status: applied.status,
            payload: applied.payload,
            lastTaskSeq: envelope.taskSeq,
          });
        }
      } else if (event.kind === "item.completed") {
        const current = replay.get(event.itemId);
        replay.set(event.itemId, {
          kind: event.itemKind,
          status: "completed",
          payload: event.finalPayload,
          lastTaskSeq: envelope.taskSeq,
          ...(current ? {} : {}),
        });
      } else if (event.kind === "item.failed" || event.kind === "item.cancelled") {
        const current = replay.get(event.itemId);
        if (current) {
          replay.set(event.itemId, {
            ...current,
            status: event.kind === "item.failed" ? "failed" : "cancelled",
            lastTaskSeq: envelope.taskSeq,
          });
        }
      }
    }

    const projectedRows = this.selectProjectedItems.all(taskId) as ItemRow[];
    const mismatches: ProjectionMismatch[] = [];
    for (const row of projectedRows) {
      const itemId = String(row.item_id);
      const expected = replay.get(itemId);
      if (!expected) {
        mismatches.push({ taskId, itemId, field: "item", expected: undefined, actual: "projected", lastTaskSeq: row.last_task_seq });
        continue;
      }
      const actualPayload = JSON.parse(row.payload_json);
      if (row.kind !== expected.kind) {
        mismatches.push({ taskId, itemId, field: "kind", expected: expected.kind, actual: row.kind, lastTaskSeq: row.last_task_seq });
      }
      if (row.status !== expected.status) {
        mismatches.push({ taskId, itemId, field: "status", expected: expected.status, actual: row.status, lastTaskSeq: row.last_task_seq });
      }
      if (JSON.stringify(actualPayload) !== JSON.stringify(expected.payload)) {
        mismatches.push({ taskId, itemId, field: "payload", expected: expected.payload, actual: actualPayload, lastTaskSeq: row.last_task_seq });
      }
    }
    for (const [itemId, expected] of replay.entries()) {
      if (!projectedRows.some((row) => row.item_id === itemId)) {
        mismatches.push({ taskId, itemId, field: "item", expected: expected.kind, actual: undefined, lastTaskSeq: expected.lastTaskSeq });
      }
    }
    return mismatches;
  }

  close(): void {
    this.closed = true;
    for (const subscribers of this.subscribersByTask.values()) {
      for (const subscriber of subscribers) {
        subscriber.closed = true;
        subscriber.queue = [];
      }
    }
    this.subscribersByTask.clear();
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
    const subscribers = this.subscribersByTask.get(envelope.taskId);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      this.enqueue(subscriber, envelope);
    }
  }

  private enqueue(subscriber: Subscriber, envelope: EventEnvelope): void {
    if (subscriber.closed) {
      return;
    }
    if (subscriber.queue.length >= subscriber.maxQueueSize) {
      const accepted = this.tryCoalesce(subscriber, envelope);
      if (!accepted && envelope.delivery === "lossless") {
        subscriber.queue.push(this.resyncNotice(envelope));
        subscriber.closed = true;
      } else if (!accepted && envelope.delivery !== "lossless") {
        subscriber.queue.push(this.resyncNotice(envelope));
      }
    } else if (!this.tryCoalesce(subscriber, envelope)) {
      subscriber.queue.push(envelope);
    }
    this.scheduleFlush(subscriber);
  }

  private tryCoalesce(subscriber: Subscriber, envelope: EventEnvelope): boolean {
    if (envelope.delivery === "lossless" || envelope.event.kind !== "item.updated") {
      return false;
    }
    const incoming = envelope.event.patch;
    const existingIndex = findCoalescibleIndex(subscriber.queue, envelope);
    if (existingIndex < 0) {
      return false;
    }
    const existing = subscriber.queue[existingIndex]!;
    if (existing.event.kind !== "item.updated") {
      return false;
    }
    const merged = mergePatches(existing.event.patch, incoming);
    if (!merged) {
      subscriber.queue[existingIndex] = this.snapshotOrResync(envelope);
      return true;
    }
    subscriber.queue[existingIndex] = {
      ...envelope,
      event: {
        kind: "item.updated",
        itemId: envelope.event.itemId,
        patch: merged,
      },
    };
    return true;
  }

  private snapshotOrResync(envelope: EventEnvelope): EventEnvelope {
    if (envelope.event.kind === "item.updated") {
      const row = this.selectItem.get({ taskId: envelope.taskId, itemId: envelope.event.itemId }) as ItemRow | undefined;
      if (row) {
        const patch = {
          op: "replace_payload",
          itemKind: row.kind as ItemKind,
          value: JSON.parse(row.payload_json) as ItemPayload[ItemKind],
          reason: "snapshot",
        } as ItemPatch;
        return {
          ...envelope,
          delivery: "lossless",
          event: {
            kind: "item.updated",
            itemId: envelope.event.itemId,
            patch,
          },
        };
      }
    }
    return this.resyncNotice(envelope);
  }

  private resyncNotice(envelope: EventEnvelope): EventEnvelope {
    const itemId = `system:resync:${envelope.eventId}`;
    return {
      ...envelope,
      eventId: randomUUID(),
      itemId,
      parentItemId: undefined,
      delivery: "lossless",
      event: {
        kind: "item.started",
        item: {
          id: itemId,
          taskId: envelope.taskId,
          sessionId: envelope.sessionId,
          ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
          kind: "system_notice",
          status: "completed",
          startedAt: envelope.ts,
          updatedAt: envelope.ts,
          completedAt: envelope.ts,
          payload: {
            level: "warning",
            code: "stream_resync_required",
            message: "Live event delivery fell behind; replay this task stream.",
            details: { lastSeq: envelope.seq, lastTaskSeq: envelope.taskSeq },
          },
        },
      },
    };
  }

  private scheduleFlush(subscriber: Subscriber): void {
    if (subscriber.flushing) {
      return;
    }
    subscriber.flushing = true;
    queueMicrotask(() => this.flushSubscriber(subscriber));
  }

  private flushSubscriber(subscriber: Subscriber): void {
    subscriber.flushing = false;
    while (subscriber.queue.length > 0) {
      const envelope = subscriber.queue.shift()!;
      try {
        subscriber.listener(envelope);
      } catch (error) {
        console.error("EventHub listener error:", error);
      }
      if (subscriber.closed) {
        subscriber.queue = [];
        break;
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

function findCoalescibleIndex(queue: EventEnvelope[], envelope: EventEnvelope): number {
  if (envelope.event.kind !== "item.updated") {
    return -1;
  }
  const incomingKey = coalesceKey(envelope);
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index]!;
    if (candidate.delivery === "lossless") {
      return -1;
    }
    if (coalesceKey(candidate) === incomingKey) {
      return index;
    }
  }
  return -1;
}

function coalesceKey(envelope: EventEnvelope): string | null {
  if (envelope.event.kind !== "item.updated") {
    return null;
  }
  const patch = envelope.event.patch;
  const path = "path" in patch ? patch.path : patch.op;
  return `${envelope.taskId}:${envelope.event.itemId}:${patch.op}:${path}`;
}

function mergePatches(previous: ItemPatch, next: ItemPatch): ItemPatch | null {
  if (previous.op !== next.op) {
    return null;
  }
  switch (previous.op) {
    case "append_text":
      return next.op === "append_text" && previous.baseLength + previous.value.length === next.baseLength
        ? { ...previous, value: previous.value + next.value }
        : null;
    case "append_array_text":
      return next.op === "append_array_text"
        && previous.path === next.path
        && previous.index === next.index
        && previous.baseLength + previous.value.length === next.baseLength
        ? { ...previous, value: previous.value + next.value }
        : null;
    case "append_command_output":
      return next.op === "append_command_output" && previous.baseLength + previous.value.text.length === next.baseLength
        ? {
            ...previous,
            value: {
              stream: previous.value.stream === next.value.stream ? previous.value.stream : "system",
              text: previous.value.text + next.value.text,
              truncated: Boolean(previous.value.truncated || next.value.truncated) || undefined,
            },
          }
        : null;
    case "append_tool_input_json":
      return next.op === "append_tool_input_json" && previous.baseLength + previous.value.length === next.baseLength
        ? {
            ...previous,
            value: previous.value + next.value,
            ...(next.partialParsed === undefined ? {} : { partialParsed: next.partialParsed }),
          }
        : null;
    case "merge_payload":
      return next.op === "merge_payload"
        ? { op: "merge_payload", value: { ...previous.value, ...next.value } }
        : null;
    case "replace_payload":
    case "set_status":
    case "set_tool_phase":
      return next;
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
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
