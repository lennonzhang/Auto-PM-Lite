import { randomUUID } from "node:crypto";
import { AppError, type TaskActionAccepted } from "../../api/types.js";
import { resumeTaskRequestSchema, runTaskRequestSchema } from "../../api/schemas.js";
import type { AppServices } from "../../service/app-services.js";

export interface DesktopJobRunnerOptions {
  log?: ((message: string) => void | Promise<void>) | undefined;
}

export class DesktopJobRunner {
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly log?: DesktopJobRunnerOptions["log"];

  constructor(options: DesktopJobRunnerOptions = {}) {
    this.log = options.log;
  }

  acceptRun(services: AppServices, input: unknown): TaskActionAccepted {
    const parsed = runTaskRequestSchema.parse(input);
    services.runtime.assertCanRunTask(parsed.taskId);
    return this.accept("run", parsed.taskId, () => services.tasks.runTask(parsed));
  }

  acceptResume(services: AppServices, input: unknown): TaskActionAccepted & { resumed: true } {
    const parsed = resumeTaskRequestSchema.parse(input);
    services.runtime.assertCanRunTask(parsed.taskId);
    return {
      ...this.accept("resume", parsed.taskId, () => services.tasks.resumeTask(parsed)),
      resumed: true,
    };
  }

  acceptPause(services: AppServices, taskId: string): TaskActionAccepted {
    return this.accept("pause", taskId, () => services.tasks.pauseTask(taskId));
  }

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  private accept(action: TaskActionAccepted["action"], taskId: string, run: () => Promise<unknown>): TaskActionAccepted {
    const actionId = randomUUID();
    const job = Promise.resolve()
      .then(() => run())
      .then(() => {
        this.writeLog(`desktop.action.completed action=${action} actionId=${actionId} taskId=${taskId}`);
      })
      .catch((error: unknown) => {
        this.writeLog(`desktop.action.failed action=${action} actionId=${actionId} taskId=${taskId} code=${errorCode(error)}`);
      })
      .finally(() => {
        this.activeJobs.delete(actionId);
      });

    this.activeJobs.set(actionId, job);
    this.writeLog(`desktop.action.accepted action=${action} actionId=${actionId} taskId=${taskId}`);
    return { ok: true, accepted: true, taskId, actionId, action };
  }

  private writeLog(message: string): void {
    if (!this.log) {
      return;
    }
    void Promise.resolve(this.log(message)).catch(() => {});
  }
}

function errorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name;
  }
  return "unknown_error";
}
