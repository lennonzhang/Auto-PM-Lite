import type { AgentEvent } from "../core/types.js";

export type EventStreamListener = (event: AgentEvent) => void;

export interface EventStream {
  subscribe(listener: EventStreamListener): () => void;
  publish(event: AgentEvent): void;
  close(): void;
}

export class InMemoryEventStream implements EventStream {
  private readonly listeners = new Set<EventStreamListener>();
  private closed = false;

  subscribe(listener: EventStreamListener): () => void {
    if (this.closed) {
      throw new Error("EventStream is closed");
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: AgentEvent): void {
    if (this.closed) {
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("EventStream listener error:", error);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
