import type { CanonicalEvent } from "../../src/core/events.js";
import type { WorkspaceChange } from "../../src/core/types.js";
import type { RuntimeAdapterOutput, RunTurnInput } from "../../src/runtime/adapter.js";

export function turnStarted(input: RunTurnInput): RuntimeAdapterOutput {
  return { event: { kind: "turn.started", turnId: input.turnId } };
}

export function messageCompleted(input: RunTurnInput, text: string, ts = new Date().toISOString()): RuntimeAdapterOutput {
  const itemId = `test:message:${input.turnId}`;
  return {
    events: [
      {
        kind: "item.started",
        item: {
          id: itemId,
          taskId: input.taskId,
          sessionId: input.taskId,
          turnId: input.turnId,
          kind: "assistant_message",
          status: "completed",
          startedAt: ts,
          updatedAt: ts,
          completedAt: ts,
          payload: { text },
        },
      },
      {
        kind: "item.completed",
        itemId,
        itemKind: "assistant_message",
        finalPayload: { text },
        completedAt: ts,
      },
    ],
  };
}

export function fileChanged(input: RunTurnInput, change: WorkspaceChange, ts = new Date().toISOString()): RuntimeAdapterOutput {
  const event: CanonicalEvent = {
    kind: "item.completed",
    itemId: `test:file:${input.turnId}:${change.path}`,
    itemKind: "file_change",
    finalPayload: {
      changes: [change],
      status: "applied",
    },
    completedAt: ts,
  };
  return { event };
}

export function turnCompleted(input: RunTurnInput, usage: { inputTokens?: number; outputTokens?: number } = {}, _ts = new Date().toISOString()): RuntimeAdapterOutput {
  return {
    event: {
      kind: "turn.completed",
      turnId: input.turnId,
      usage,
    },
  };
}
