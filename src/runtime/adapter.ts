import type { CanonicalEvent } from "../core/events.js";
import type { RuntimeKind } from "../core/types.js";

export interface OpenRuntimeSessionInput {
  taskId: string;
  sessionId: string;
  profileId: string;
  model: string;
  cwd: string;
  backendThreadId?: string | undefined;
}

export interface RuntimeTaskHandle {
  taskId: string;
  sessionId: string;
  backendThreadId?: string | undefined;
}

export interface RunTurnInput {
  taskId: string;
  sessionId: string;
  turnId: string;
  profileId: string;
  model: string;
  cwd: string;
  prompt: string;
}

export interface ForkRuntimeSessionInput {
  taskId: string;
  sourceSessionId: string;
  targetSessionId: string;
  profileId: string;
  model: string;
  cwd: string;
  sourceBackendThreadId: string;
  upToMessageId?: string | undefined;
}

export interface ForkRuntimeSessionResult {
  backendThreadId: string;
  forkKind: "native" | "logical";
}

export interface RuntimeSessionControlInput {
  sessionId: string;
  backendThreadId?: string | undefined;
}

export type RuntimeAdapterOutput =
  | { raw?: unknown | undefined; event: CanonicalEvent }
  | { raw?: unknown | undefined; events: CanonicalEvent[] };

export interface RuntimeAdapter {
  readonly runtime: RuntimeKind;
  openSession(input: OpenRuntimeSessionInput): Promise<RuntimeTaskHandle>;
  runTurn(input: RunTurnInput): AsyncIterable<RuntimeAdapterOutput>;
  interruptTurn(input: RuntimeSessionControlInput): Promise<void>;
  terminateSession(input: RuntimeSessionControlInput): Promise<void>;
  hasLiveSession?(sessionId: string): boolean;
  shutdown?(): Promise<void>;
  forkSession?(input: ForkRuntimeSessionInput): Promise<ForkRuntimeSessionResult>;
}
