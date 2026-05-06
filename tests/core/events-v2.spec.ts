import { describe, expect, it } from "vitest";
import { eventEnvelopeSchemaV2, itemEventSchema, validateCanonicalEvent } from "../../src/core/events.js";
import type { ItemEvent } from "../../src/core/events.js";

describe("v2 canonical event protocol", () => {
  it("validates matching completed item payloads", () => {
    const event: ItemEvent = {
      kind: "item.completed",
      itemId: "item-1",
      itemKind: "assistant_message",
      finalPayload: { text: "done" },
      completedAt: "2026-05-06T00:00:00.000Z",
    };

    expect(itemEventSchema.parse(event)).toEqual(event);
  });

  it("rejects completed item payloads that do not match itemKind", () => {
    expect(() => itemEventSchema.parse({
      kind: "item.completed",
      itemId: "item-1",
      itemKind: "assistant_message",
      finalPayload: { items: [] },
      completedAt: "2026-05-06T00:00:00.000Z",
    })).toThrow();
  });

  it("rejects replace_payload patches that do not match itemKind", () => {
    expect(() => itemEventSchema.parse({
      kind: "item.updated",
      itemId: "item-1",
      patch: {
        op: "replace_payload",
        itemKind: "command_execution",
        value: { text: "not a command" },
        reason: "snapshot",
      },
    })).toThrow();
  });

  it("requires command output chunks for append_command_output", () => {
    expect(() => itemEventSchema.parse({
      kind: "item.updated",
      itemId: "cmd-1",
      patch: {
        op: "append_command_output",
        value: { stream: "stdout", text: "hello" },
        baseLength: 0,
      },
    })).not.toThrow();
  });

  it("validates a full v2 envelope", () => {
    const event = validateCanonicalEvent({ kind: "task.queued" });
    expect(eventEnvelopeSchemaV2.parse({
      v: 2,
      eventId: "event-1",
      seq: 1,
      taskSeq: 1,
      runtime: "claude",
      taskId: "task-1",
      sessionId: "session-1",
      ts: "2026-05-06T00:00:00.000Z",
      delivery: "lossless",
      event,
    }).event).toEqual(event);
  });
});
