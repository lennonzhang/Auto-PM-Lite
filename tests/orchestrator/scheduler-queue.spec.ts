import { describe, expect, it } from "vitest";
import { DefaultTaskScheduler } from "../../src/orchestrator/scheduler.js";

describe("DefaultTaskScheduler — queueing", () => {
  it("acquires immediately when capacity is available", async () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 2,
      maxConcurrentTasksPerAccount: 2,
    });

    await scheduler.acquire("task-a", "acct-1");
    expect(scheduler.getRunningTasks()).toEqual(["task-a"]);
    expect(scheduler.getQueueDepth()).toBe(0);
  });

  it("queues acquires when global cap is reached and resumes them on completion", async () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 1,
      maxConcurrentTasksPerAccount: 5,
    });

    await scheduler.acquire("task-a", "acct-1");

    let acquired = false;
    const pending = scheduler.acquire("task-b", "acct-2").then(() => {
      acquired = true;
    });

    // Wait a microtask so the second acquire can register itself in the queue.
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(scheduler.getQueueDepth()).toBe(1);

    scheduler.recordComplete("task-a");
    await pending;

    expect(acquired).toBe(true);
    expect(scheduler.getRunningTasks()).toEqual(["task-b"]);
    expect(scheduler.getQueueDepth()).toBe(0);
  });

  it("queues per-account even when global has capacity", async () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 10,
      maxConcurrentTasksPerAccount: 1,
    });

    await scheduler.acquire("task-a", "acct-1");

    let acquired = false;
    const pending = scheduler.acquire("task-b", "acct-1").then(() => {
      acquired = true;
    });

    await Promise.resolve();
    expect(acquired).toBe(false);

    // Different account is unblocked because per-account cap only applies to acct-1.
    await scheduler.acquire("task-c", "acct-2");
    expect(scheduler.getRunningTasks().sort()).toEqual(["task-a", "task-c"]);
    expect(scheduler.getQueueDepth()).toBe(1);

    scheduler.recordComplete("task-a");
    await pending;
    expect(acquired).toBe(true);
  });
});
