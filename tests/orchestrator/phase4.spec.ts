import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppDatabase } from "../../src/storage/db.js";
import { checkBudget, updateBudget } from "../../src/orchestrator/budget.js";
import { DefaultTaskScheduler } from "../../src/orchestrator/scheduler.js";
import { TokenBucketRateLimiter } from "../../src/orchestrator/rate-limit.js";
import { InMemoryEventStream } from "../../src/orchestrator/event-stream.js";
import type { BudgetSnapshot, Policy, Task, TurnUsage } from "../../src/core/types.js";

describe("Phase 4: Budget Tracking", () => {
  it("should allow usage within budget", () => {
    const policy: Policy = {
      id: "test",
      permissionMode: "read-only",
      sandboxMode: "read-only",
      networkAllowed: false,
      approvalPolicy: "orchestrator",
      requireApprovalFor: [],
      maxDepth: 1,
      maxTokens: 10000,
      maxCostUsd: 1.0,
      allowCrossHarnessDelegation: false,
      allowChildEdit: false,
      allowChildNetwork: false,
    };

    const budget: BudgetSnapshot = {
      maxTokens: 10000,
      maxCostUsd: 1.0,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.05,
    };

    const result = checkBudget(budget, policy);
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("should warn when approaching budget limit", () => {
    const policy: Policy = {
      id: "test",
      permissionMode: "read-only",
      sandboxMode: "read-only",
      networkAllowed: false,
      approvalPolicy: "orchestrator",
      requireApprovalFor: [],
      maxDepth: 1,
      maxTokens: 10000,
      maxCostUsd: 1.0,
      allowCrossHarnessDelegation: false,
      allowChildEdit: false,
      allowChildNetwork: false,
    };

    const budget: BudgetSnapshot = {
      maxTokens: 10000,
      maxCostUsd: 1.0,
      inputTokens: 7000,
      outputTokens: 2500,
      estimatedCostUsd: 0.92,
    };

    const result = checkBudget(budget, policy);
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeDefined();
  });

  it("should deny when budget exceeded", () => {
    const policy: Policy = {
      id: "test",
      permissionMode: "read-only",
      sandboxMode: "read-only",
      networkAllowed: false,
      approvalPolicy: "orchestrator",
      requireApprovalFor: [],
      maxDepth: 1,
      maxTokens: 10000,
      maxCostUsd: 1.0,
      allowCrossHarnessDelegation: false,
      allowChildEdit: false,
      allowChildNetwork: false,
    };

    const budget: BudgetSnapshot = {
      maxTokens: 10000,
      maxCostUsd: 1.0,
      inputTokens: 8000,
      outputTokens: 3000,
      estimatedCostUsd: 1.05,
    };

    const result = checkBudget(budget, policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("should update budget with usage", () => {
    const budget: BudgetSnapshot = {
      maxTokens: 10000,
      maxCostUsd: 1.0,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.05,
    };

    const usage: TurnUsage = {
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.01,
    };

    const updated = updateBudget(budget, usage);
    expect(updated.inputTokens).toBe(1200);
    expect(updated.outputTokens).toBe(600);
    expect(updated.estimatedCostUsd).toBeCloseTo(0.06, 10);
  });
});

describe("Phase 4: Task Scheduler", () => {
  it("should allow scheduling when under limits", () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 5,
      maxConcurrentTasksPerAccount: 2,
    });

    const task = { id: "task1" } as Task;
    expect(scheduler.canSchedule(task, "account1")).toBe(true);
  });

  it("should deny scheduling when global limit reached", () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 2,
      maxConcurrentTasksPerAccount: 5,
    });

    scheduler.recordStart("task1", "account1");
    scheduler.recordStart("task2", "account2");

    const task = { id: "task3" } as Task;
    expect(scheduler.canSchedule(task, "account3")).toBe(false);
  });

  it("should deny scheduling when account limit reached", () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 10,
      maxConcurrentTasksPerAccount: 2,
    });

    scheduler.recordStart("task1", "account1");
    scheduler.recordStart("task2", "account1");

    const task = { id: "task3" } as Task;
    expect(scheduler.canSchedule(task, "account1")).toBe(false);
  });

  it("should track running tasks correctly", () => {
    const scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: 5,
      maxConcurrentTasksPerAccount: 2,
    });

    scheduler.recordStart("task1", "account1");
    scheduler.recordStart("task2", "account1");
    scheduler.recordStart("task3", "account2");

    expect(scheduler.getRunningTasks()).toHaveLength(3);
    expect(scheduler.getRunningTasksForAccount("account1")).toHaveLength(2);
    expect(scheduler.getRunningTasksForAccount("account2")).toHaveLength(1);

    scheduler.recordComplete("task1");
    expect(scheduler.getRunningTasks()).toHaveLength(2);
    expect(scheduler.getRunningTasksForAccount("account1")).toHaveLength(1);
  });
});

describe("Phase 4: Rate Limiter", () => {
  it("should allow requests within rate limits", async () => {
    const limiter = new TokenBucketRateLimiter({
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
    });

    const result = await limiter.checkLimit("account1", 100);
    expect(result.allowed).toBe(true);
  });

  it("should deny requests exceeding rate limits", async () => {
    const limiter = new TokenBucketRateLimiter({
      requestsPerMinute: 2,
    });

    limiter.recordRequest("account1");
    limiter.recordRequest("account1");

    const result = await limiter.checkLimit("account1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Rate limit");
  });

  it("should track token consumption", async () => {
    const limiter = new TokenBucketRateLimiter({
      tokensPerMinute: 1000,
    });

    limiter.recordRequest("account1");
    limiter.recordUsage("account1", 600);
    limiter.recordRequest("account1");
    limiter.recordUsage("account1", 300);

    const result = await limiter.checkLimit("account1", 200);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Token rate limit");
  });
});

describe("Phase 4: Event Stream", () => {
  it("should publish events to subscribers", () => {
    const stream = new InMemoryEventStream();
    const events: any[] = [];

    stream.subscribe((event) => {
      events.push(event);
    });

    stream.publish({
      type: "task.started",
      taskId: "task1",
      runtime: "claude",
      profileId: "profile1",
      ts: new Date().toISOString(),
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.started");
  });

  it("should support multiple subscribers", () => {
    const stream = new InMemoryEventStream();
    const events1: any[] = [];
    const events2: any[] = [];

    stream.subscribe((event) => events1.push(event));
    stream.subscribe((event) => events2.push(event));

    stream.publish({
      type: "task.completed",
      taskId: "task1",
      summary: "Done",
      ts: new Date().toISOString(),
    });

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it("should allow unsubscribing", () => {
    const stream = new InMemoryEventStream();
    const events: any[] = [];

    const unsubscribe = stream.subscribe((event) => {
      events.push(event);
    });

    stream.publish({
      type: "task.started",
      taskId: "task1",
      runtime: "claude",
      profileId: "profile1",
      ts: new Date().toISOString(),
    });

    unsubscribe();

    stream.publish({
      type: "task.completed",
      taskId: "task1",
      summary: "Done",
      ts: new Date().toISOString(),
    });

    expect(events).toHaveLength(1);
  });
});
