import type { CanonicalEvent } from "../core/events.js";
import type { RuntimeKind } from "../core/types.js";

export interface StartRuntimeTaskInput {
  taskId: string;
  sessionId: string;
  profileId: string;
  model: string;
  cwd: string;
  prompt?: string;
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

export interface ResumeRuntimeTaskInput {
  taskId: string;
  sessionId: string;
  profileId: string;
  model: string;
  cwd?: string;
  backendThreadId: string;
}

export interface RuntimeTaskHandle {
  taskId: string;
  sessionId: string;
  backendThreadId?: string | undefined;
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
  startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle>;
  runTurn(input: RunTurnInput): AsyncIterable<RuntimeAdapterOutput>;
  resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle>;
  forkSession?(input: ForkRuntimeSessionInput): Promise<ForkRuntimeSessionResult>;
  pauseSession(input: RuntimeSessionControlInput): Promise<void>;
  interruptSession(input: RuntimeSessionControlInput): Promise<void>;
  closeSession(input: RuntimeSessionControlInput): Promise<void>;
}
