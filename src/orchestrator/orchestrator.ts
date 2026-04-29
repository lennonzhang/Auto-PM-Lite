import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AppConfig, AgentEvent, ApprovalKind, BudgetSnapshot, PermissionMode, Policy, Task, Workspace } from "../core/types.js";
import type { AutoPmMcpHandlers, McpToolResult } from "../mcp/auto-pm-service.js";
import { redactText } from "../core/redaction.js";
import { AppDatabase, type StoredArtifact } from "../storage/db.js";
import { EventStore } from "../storage/event-store.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { assertReadOnlyDelegation, canAccessTaskLineage, exceedsDelegationDepth, resolveDelegationTargetProfile, type DelegateTaskInput as DelegateTaskRequest, wouldCreateDelegationCycle } from "./delegation.js";
import { buildDelegationChain, nextDelegationDepth } from "./task-tree.js";
import { WorkspaceManager } from "./workspace.js";

export interface CreateTaskInput {
  profileId: string;
  cwd: string;
  name?: string;
}

export interface RunTaskInput {
  taskId: string;
  prompt: string;
}

export interface ResumeTaskInput {
  taskId: string;
  prompt?: string | undefined;
}

export interface DelegateTaskInput extends DelegateTaskRequest {
  parentTaskId: string;
}

export interface CapabilityRequestInput {
  taskId: string;
  kind: Extract<ApprovalKind, "filesystem" | "network" | "delegation" | "workspace_merge" | "reference_access">;
  reason: string;
}

export interface TaskResultSnapshot {
  taskId: string;
  parentTaskId?: string | undefined;
  status: Task["status"];
  runtime: Task["runtime"];
  profileId: string;
  latestMessage?: string | undefined;
  artifacts: StoredArtifact[];
  pendingApprovalIds: string[];
}

export class Orchestrator {
  private readonly workspaceManager: WorkspaceManager;
  private readonly eventStore: EventStore;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly runtimes: Record<string, RuntimeAdapter> = {},
  ) {
    this.workspaceManager = new WorkspaceManager(config.workspace);
    this.eventStore = new EventStore(this.db.db, {
      flushBatchSize: config.storage.flushBatchSize,
      maxQueueSize: config.storage.maxQueueSize,
      redaction: { additionalPatterns: config.redaction.additionalPatterns },
    });
  }

  syncConfig(): void {
    this.db.syncConfig(this.config);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const profile = this.config.profiles[input.profileId];
    if (!profile) {
      throw new Error(`Unknown profile: ${input.profileId}`);
    }

    const policy = this.requirePolicy(profile.policyId);
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const workspace = this.workspaceManager.createTopLevelWorkspace({
      taskId,
      cwd: input.cwd,
    });

    const task: Task = {
      id: taskId,
      name: input.name,
      profileId: profile.id,
      runtime: profile.runtime,
      cwd: workspace.path,
      workspaceId: workspace.id,
      delegationDepth: 0,
      delegationChain: [],
      status: "queued",
      budget: toBudgetSnapshot(policy),
      triggeredBy: "user",
      createdAt: now,
      updatedAt: now,
    };

    this.db.createTaskRecord({ task, workspace });
    await this.eventStore.append({ type: "task.queued", taskId: task.id, ts: now });
    return task;
  }

  listTasks(): ReturnType<AppDatabase["listTasks"]> {
    return this.db.listTasks();
  }

  getTask(taskId: string): ReturnType<AppDatabase["getTask"]> {
    return this.db.getTask(taskId);
  }

  listTurns(taskId: string): ReturnType<AppDatabase["listTurns"]> {
    return this.db.listTurns(taskId);
  }

  listApprovals(taskId?: string): ReturnType<AppDatabase["listApprovals"]> {
    return this.db.listApprovals(taskId);
  }

  listArtifacts(taskId: string): ReturnType<AppDatabase["listArtifacts"]> {
    return this.db.listArtifacts(taskId);
  }

  createApproval(input: {
    taskId: string;
    kind: "tool" | "network" | "filesystem" | "delegation" | "workspace_merge" | "budget_increase" | "reference_access";
    payload: Record<string, unknown>;
    expiresAt?: string | undefined;
  }): string {
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    this.db.createApproval({
      id: approvalId,
      taskId: input.taskId,
      kind: input.kind,
      payload: input.payload,
      status: "pending",
      requestedAt: now,
      expiresAt: input.expiresAt,
    });
    return approvalId;
  }

  resolveApproval(input: { approvalId: string; approved: boolean; reason?: string | undefined }): void {
    this.db.resolveApproval({
      approvalId: input.approvalId,
      status: input.approved ? "approved" : "denied",
      resolvedAt: new Date().toISOString(),
      resolutionReason: input.reason,
    });
  }

  async requestCapability(input: CapabilityRequestInput): Promise<{ approvalId: string; status: "pending" }> {
    this.requireTask(input.taskId);
    const approvalId = this.createApproval({
      taskId: input.taskId,
      kind: input.kind,
      payload: { reason: input.reason },
    });
    await this.eventStore.append({
      type: "approval.requested",
      taskId: input.taskId,
      approvalId,
      kind: input.kind,
      ts: new Date().toISOString(),
    });
    return { approvalId, status: "pending" };
  }

  reportArtifact(input: { taskId: string; kind: StoredArtifact["kind"]; ref: string; description?: string | undefined }): StoredArtifact {
    this.requireTask(input.taskId);
    const artifact: StoredArtifact = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind,
      ref: input.ref,
      description: input.description,
      ts: new Date().toISOString(),
    };
    this.db.createArtifact(artifact);
    return artifact;
  }

  async delegateTask(input: DelegateTaskInput): Promise<{ childTaskId: string; result: TaskResultSnapshot }> {
    const parentTask = this.requireTask(input.parentTaskId);
    const parentProfile = this.requireProfile(parentTask.profileId);
    const parentPolicy = this.requirePolicy(parentProfile.policyId);

    if (!parentPolicy.allowCrossHarnessDelegation) {
      throw new Error("cross_harness_delegation_disabled");
    }

    assertReadOnlyDelegation(input);

    const targetProfile = resolveDelegationTargetProfile(this.config, parentTask, input);
    if (targetProfile.runtime === parentTask.runtime) {
      throw new Error("cross_harness_delegation_required");
    }

    const targetPolicy = this.requirePolicy(targetProfile.policyId);
    const nextDepth = nextDelegationDepth(parentTask.delegationDepth);
    if (exceedsDelegationDepth(parentTask.delegationDepth, parentPolicy.maxDepth) || exceedsDelegationDepth(parentTask.delegationDepth, targetPolicy.maxDepth)) {
      throw new Error("max_depth");
    }
    if (targetPolicy.permissionMode !== "read-only" || targetPolicy.sandboxMode !== "read-only" || targetPolicy.networkAllowed) {
      throw new Error("target_profile_not_readonly");
    }

    const lineage = this.getTaskLineage(parentTask);
    if (wouldCreateDelegationCycle(lineage, targetProfile)) {
      throw new Error("cycle_detected");
    }

    const now = new Date().toISOString();
    const childTaskId = randomUUID();
    const workspace = this.createSharedChildWorkspace(childTaskId, parentTask, now);
    const childTask: Task = {
      id: childTaskId,
      name: `${input.taskType}:${targetProfile.runtime}`,
      profileId: targetProfile.id,
      runtime: targetProfile.runtime,
      cwd: parentTask.cwd,
      workspaceId: workspace.id,
      parentTaskId: parentTask.id,
      delegationDepth: nextDepth,
      delegationChain: buildDelegationChain(parentTask.delegationChain, parentTask.id),
      status: "queued",
      budget: toBudgetSnapshot(targetPolicy),
      triggeredBy: `delegate:${parentTask.id}`,
      createdAt: now,
      updatedAt: now,
    };

    this.db.createTaskRecord({ task: childTask, workspace });
    await this.eventStore.append({ type: "delegation.requested", taskId: parentTask.id, request: { ...input, targetProfileId: targetProfile.id }, ts: now });
    await this.eventStore.append({ type: "task.queued", taskId: childTask.id, ts: now });
    await this.eventStore.append({ type: "delegation.started", taskId: parentTask.id, childTaskId: childTask.id, ts: now });

    await this.runTask({
      taskId: childTask.id,
      prompt: input.prompt,
    });

    const completedAt = new Date().toISOString();
    await this.eventStore.append({ type: "delegation.completed", taskId: parentTask.id, childTaskId: childTask.id, ts: completedAt });

    return {
      childTaskId: childTask.id,
      result: this.getTaskResult(parentTask.id, childTask.id),
    };
  }

  waitForTask(requesterTaskId: string, taskId: string): TaskResultSnapshot {
    return this.getTaskResult(requesterTaskId, taskId);
  }

  getTaskResult(requesterTaskId: string, taskId: string): TaskResultSnapshot {
    const task = this.requireTask(taskId);
    if (!canAccessTaskLineage(requesterTaskId, task, (candidateTaskId) => this.db.getTask(candidateTaskId))) {
      throw new Error("task_access_denied");
    }

    return this.buildTaskResult(task);
  }

  createMcpHandlers(taskId: string): AutoPmMcpHandlers {
    return {
      delegateTo: async (input) => {
        const result = await this.delegateTask({ parentTaskId: taskId, ...input });
        return this.toMcpToolResult(result);
      },
      requestCapability: async (input) => {
        const result = await this.requestCapability({ taskId, ...input });
        return this.toMcpToolResult(result);
      },
      waitForTask: async (input) => this.toMcpToolResult(this.waitForTask(taskId, input.taskId)),
      getTaskResult: async (input) => this.toMcpToolResult(this.getTaskResult(taskId, input.taskId)),
      reportArtifact: async (input) => this.toMcpToolResult(this.reportArtifact({ taskId, ...input })),
    };
  }

  async runTask(input: RunTaskInput): Promise<void> {
    const task = this.db.getTask(input.taskId);
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`);
    }

    const runtime = this.runtimes[task.runtime];
    if (!runtime) {
      throw new Error(`Runtime adapter not configured for ${task.runtime}`);
    }

    const startedAt = new Date().toISOString();
    const handle = await runtime.startTask({
      taskId: task.id,
      profileId: task.profileId,
      cwd: task.cwd,
    });

    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "running",
      backendThreadId: handle.backendThreadId,
      updatedAt: startedAt,
    });
    await this.eventStore.append({
      type: "task.started",
      taskId: task.id,
      runtime: task.runtime,
      profileId: task.profileId,
      ts: startedAt,
    });

    const turnId = await this.beginTurn(task.id, input.prompt, startedAt);

    try {
      await this.consumeTurn(task, runtime, {
        taskId: task.id,
        profileId: task.profileId,
        cwd: task.cwd,
        prompt: input.prompt,
      }, turnId, handle.backendThreadId);
    } catch (error) {
      await this.failTask(task.id, handle.backendThreadId, error, true);
      throw error;
    } finally {
      await runtime.closeTask(task.id);
    }
  }

  async resumeTask(input: ResumeTaskInput): Promise<void> {
    const task = this.db.getTask(input.taskId);
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`);
    }
    if (!task.backendThreadId) {
      throw new Error(`Task ${task.id} has no backend thread to resume`);
    }

    const runtime = this.runtimes[task.runtime];
    if (!runtime) {
      throw new Error(`Runtime adapter not configured for ${task.runtime}`);
    }

    const latestTurn = this.db.getLatestTurn(task.id);
    if (!this.canResumeTask(task, latestTurn)) {
      const now = new Date().toISOString();
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "reconcile_required",
        backendThreadId: task.backendThreadId,
        updatedAt: now,
      });
      throw new Error(`Task ${task.id} requires reconciliation before resume`);
    }

    const resumedAt = new Date().toISOString();
    const handle = await runtime.resumeTask({
      taskId: task.id,
      profileId: task.profileId,
      cwd: task.cwd,
      backendThreadId: task.backendThreadId,
    });

    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "running",
      backendThreadId: handle.backendThreadId,
      updatedAt: resumedAt,
    });
    await this.eventStore.append({
      type: "task.started",
      taskId: task.id,
      runtime: task.runtime,
      profileId: task.profileId,
      ts: resumedAt,
    });

    const turnPrompt = input.prompt ?? latestTurn?.promptRedacted;
    if (!turnPrompt) {
      throw new Error(`Task ${task.id} has no resumable prompt`);
    }

    const turnId = await this.beginTurn(task.id, turnPrompt, resumedAt);

    try {
      await this.consumeTurn(task, runtime, {
        taskId: task.id,
        profileId: task.profileId,
        cwd: task.cwd,
        prompt: turnPrompt,
      }, turnId, handle.backendThreadId);
    } catch (error) {
      await this.failTask(task.id, handle.backendThreadId, error, false);
      throw error;
    } finally {
      await runtime.closeTask(task.id);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    const runtime = this.runtimes[task.runtime];
    if (!runtime) {
      throw new Error(`Runtime adapter not configured for ${task.runtime}`);
    }

    await runtime.cancelTask(task.id);
    const now = new Date().toISOString();
    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "cancelled",
      backendThreadId: task.backendThreadId,
      updatedAt: now,
      completedAt: now,
    });
    await this.eventStore.append({ type: "task.cancelled", taskId: task.id, ts: now });
  }

  async close(): Promise<void> {
    await this.eventStore.close();
    this.db.close();
  }

  private requirePolicy(policyId: string): Policy {
    const policy = this.config.policies[policyId];
    if (!policy) {
      throw new Error(`Unknown policy: ${policyId}`);
    }

    return policy;
  }

  private requireProfile(profileId: string) {
    const profile = this.config.profiles[profileId];
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    return profile;
  }

  private requireTask(taskId: string): NonNullable<ReturnType<AppDatabase["getTask"]>> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  private getTaskLineage(task: Task): Task[] {
    const lineage: Task[] = [task];
    let current = task.parentTaskId ? this.db.getTask(task.parentTaskId) : null;
    while (current) {
      lineage.push(current);
      current = current.parentTaskId ? this.db.getTask(current.parentTaskId) : null;
    }
    return lineage;
  }

  private createSharedChildWorkspace(taskId: string, parentTask: Task, createdAt: string): Workspace {
    return {
      id: `ws_${taskId}`,
      path: parentTask.cwd,
      parentWorkspaceId: parentTask.workspaceId,
      status: "active",
      unsafeDirectCwd: false,
      createdAt,
    };
  }

  private buildTaskResult(task: Task): TaskResultSnapshot {
    return {
      taskId: task.id,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      status: task.status,
      runtime: task.runtime,
      profileId: task.profileId,
      ...(this.db.getLatestCompletedMessage(task.id) ? { latestMessage: this.db.getLatestCompletedMessage(task.id) } : {}),
      artifacts: this.db.listArtifacts(task.id),
      pendingApprovalIds: this.db.listPendingApprovals(task.id).map((approval) => approval.id),
    };
  }

  private toMcpToolResult(payload: unknown): McpToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async beginTurn(taskId: string, prompt: string, startedAt: string): Promise<string> {
    const turnId = randomUUID();
    const promptRedacted = redactText(prompt, { additionalPatterns: this.config.redaction.additionalPatterns });
    this.db.createTurn({
      id: turnId,
      taskId,
      promptRedacted,
      status: "running",
      startedAt,
    });
    return turnId;
  }

  private async consumeTurn(
    task: Task,
    runtime: RuntimeAdapter,
    input: { taskId: string; profileId: string; cwd: string; prompt: string },
    turnId: string,
    backendThreadId?: string | undefined,
  ): Promise<void> {
    for await (const event of runtime.runTurn(input)) {
      await this.recordEvent(task, event);
      if (event.type === "turn.completed") {
        this.db.updateTurn({
          turnId,
          status: "completed",
          usage: event.usage,
          completedAt: event.ts,
        });
      }
      if (event.type === "task.failed") {
        this.db.updateTurn({
          turnId,
          status: "failed",
          completedAt: event.ts,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const latestTurn = this.db.getLatestTurn(task.id);
    if (latestTurn?.id === turnId && latestTurn.status === "running") {
      this.db.updateTurn({
        turnId,
        status: "completed",
        completedAt,
      });
    }

    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "completed",
      backendThreadId,
      updatedAt: completedAt,
      completedAt,
    });
    await this.eventStore.append({
      type: "task.completed",
      taskId: task.id,
      summary: "Run completed",
      ts: completedAt,
    });
  }

  private async failTask(
    taskId: string,
    backendThreadId: string | undefined,
    error: unknown,
    markInterrupted: boolean,
  ): Promise<void> {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.db.updateTaskRuntimeState({
      taskId,
      status: markInterrupted ? "interrupted" : "failed",
      backendThreadId,
      updatedAt: failedAt,
      ...(markInterrupted ? {} : { completedAt: failedAt }),
    });
    await this.eventStore.append({
      type: "task.failed",
      taskId,
      error: message,
      ts: failedAt,
    });
  }

  private canResumeTask(task: Task, latestTurn: ReturnType<AppDatabase["getLatestTurn"]>): boolean {
    if (!task.backendThreadId) {
      return false;
    }
    if (task.status !== "interrupted" && task.status !== "reconcile_required") {
      return false;
    }
    if (!fs.existsSync(task.cwd)) {
      return false;
    }
    if (this.db.listPendingApprovals(task.id).length > 0) {
      return false;
    }
    if (task.status === "reconcile_required") {
      return latestTurn?.status === "failed" || latestTurn?.status === "completed";
    }
    return true;
  }

  private async recordEvent(task: Task, event: AgentEvent): Promise<void> {
    await this.eventStore.append(event);

    if (event.type === "file.changed") {
      this.db.insertFileChange({
        taskId: task.id,
        workspaceId: task.workspaceId,
        path: event.path,
        changeKind: event.changeKind,
        ts: event.ts,
      });
      return;
    }

    if (event.type === "task.failed") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "failed",
        updatedAt: event.ts,
        completedAt: event.ts,
      });
    }
  }
}

function toBudgetSnapshot(policy: Policy): BudgetSnapshot {
  return {
    maxTokens: policy.maxTokens,
    maxCostUsd: policy.maxCostUsd,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}
