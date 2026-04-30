import type { Task } from "../core/types.js";

export interface SchedulerOptions {
  maxConcurrentTasksPerAccount: number;
  maxConcurrentTasksGlobal: number;
}

export interface TaskScheduler {
  canSchedule(task: Task, accountId: string): boolean;
  acquire(taskId: string, accountId: string): Promise<void>;
  recordStart(taskId: string, accountId: string): void;
  recordComplete(taskId: string): void;
  getRunningTasks(): string[];
  getRunningTasksForAccount(accountId: string): string[];
  getQueueDepth(): number;
}

interface QueuedSlotRequest {
  taskId: string;
  accountId: string;
  resolve: () => void;
}

export class DefaultTaskScheduler implements TaskScheduler {
  private readonly runningTasks = new Map<string, string>();
  private readonly accountTasks = new Map<string, Set<string>>();
  private readonly waitQueue: QueuedSlotRequest[] = [];

  constructor(private readonly options: SchedulerOptions) {}

  canSchedule(_task: Task, accountId: string): boolean {
    return this.hasCapacity(accountId);
  }

  async acquire(taskId: string, accountId: string): Promise<void> {
    if (this.hasCapacity(accountId)) {
      this.recordStart(taskId, accountId);
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitQueue.push({ taskId, accountId, resolve });
    });
    // drainWaitQueue calls recordStart before resolving so the slot is committed
    // synchronously the moment capacity becomes available.
  }

  recordStart(taskId: string, accountId: string): void {
    this.runningTasks.set(taskId, accountId);
    if (!this.accountTasks.has(accountId)) {
      this.accountTasks.set(accountId, new Set());
    }
    this.accountTasks.get(accountId)!.add(taskId);
  }

  recordComplete(taskId: string): void {
    const accountId = this.runningTasks.get(taskId);
    if (accountId) {
      this.runningTasks.delete(taskId);
      const accountTaskSet = this.accountTasks.get(accountId);
      if (accountTaskSet) {
        accountTaskSet.delete(taskId);
        if (accountTaskSet.size === 0) {
          this.accountTasks.delete(accountId);
        }
      }
    }
    this.drainWaitQueue();
  }

  getRunningTasks(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  getRunningTasksForAccount(accountId: string): string[] {
    return Array.from(this.accountTasks.get(accountId) ?? []);
  }

  getQueueDepth(): number {
    return this.waitQueue.length;
  }

  private hasCapacity(accountId: string): boolean {
    if (this.runningTasks.size >= this.options.maxConcurrentTasksGlobal) {
      return false;
    }
    const accountTaskSet = this.accountTasks.get(accountId);
    if (accountTaskSet && accountTaskSet.size >= this.options.maxConcurrentTasksPerAccount) {
      return false;
    }
    return true;
  }

  private drainWaitQueue(): void {
    for (let i = 0; i < this.waitQueue.length; i++) {
      const candidate = this.waitQueue[i]!;
      if (this.hasCapacity(candidate.accountId)) {
        this.waitQueue.splice(i, 1);
        this.recordStart(candidate.taskId, candidate.accountId);
        candidate.resolve();
        return;
      }
    }
  }
}
