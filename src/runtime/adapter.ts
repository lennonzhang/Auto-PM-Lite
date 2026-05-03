import type { AgentEvent, RuntimeKind } from "../core/types.js";

export interface StartRuntimeTaskInput {
  taskId: string;
  profileId: string;
  model: string;
  cwd: string;
  prompt?: string;
}

export interface RunTurnInput {
  taskId: string;
  profileId: string;
  model: string;
  cwd: string;
  prompt: string;
}

export interface ResumeRuntimeTaskInput {
  taskId: string;
  profileId: string;
  model: string;
  cwd?: string;
  backendThreadId: string;
}

export interface RuntimeTaskHandle {
  taskId: string;
  backendThreadId?: string | undefined;
}

export interface RuntimeAdapter {
  readonly runtime: RuntimeKind;
  startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle>;
  runTurn(input: RunTurnInput): AsyncIterable<AgentEvent>;
  resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle>;
  pauseTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  closeTask(taskId: string): Promise<void>;
}
