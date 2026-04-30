import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AppConfig, AgentEvent, ApprovalKind, ArtifactRef, BudgetSnapshot, DelegateToResult, PermissionMode, Policy, Task, TaskReference, TurnUsage, Workspace } from "../core/types.js";
import type { AutoPmMcpHandlers, McpToolResult } from "../mcp/auto-pm-service.js";
import { redactText } from "../core/redaction.js";
import { canAccessReference, policyTrustLevel } from "../core/reference.js";
import { buildRawTranscriptCipher } from "../core/transcript.js";
import { AppDatabase, type StoredArtifact } from "../storage/db.js";
import { EventStore } from "../storage/event-store.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { shouldRequireApproval } from "./policy.js";
import { assertReadOnlyDelegation, canAccessTaskLineage, exceedsDelegationDepth, resolveDelegationTargetProfile, type DelegateTaskInput as DelegateTaskRequest, wouldCreateDelegationCycle } from "./delegation.js";
import { buildDelegationChain, nextDelegationDepth } from "./task-tree.js";
import { WorkspaceManager } from "./workspace.js";
import { checkBudget, updateBudget } from "./budget.js";
import { DefaultTaskScheduler } from "./scheduler.js";
import { NoOpRateLimiter, TokenBucketRateLimiter, type RateLimiter } from "./rate-limit.js";
import { InMemoryEventStream } from "./event-stream.js";
import { expirePendingApprovals } from "./approval.js";

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
  kind: ApprovalKind;
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

type ApprovalContinuation =
  | { kind: "resolve_only" }
  | { kind: "requeue" }
  | { kind: "auto_resume"; prompt?: string | undefined };

export class Orchestrator {
  private readonly workspaceManager: WorkspaceManager;
  private readonly eventStore: EventStore;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly scheduler: DefaultTaskScheduler;
  private readonly rateLimiter: RateLimiter;
  private readonly eventStream: InMemoryEventStream;
  private readonly pendingContinuations = new Set<Promise<void>>();
  private closed = false;

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
    this.scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: config.scheduler.maxConcurrentTasksGlobal,
      maxConcurrentTasksPerAccount: config.scheduler.maxConcurrentTasksPerAccount,
    });
    this.rateLimiter = config.rateLimit.enabled
      ? new TokenBucketRateLimiter(config.rateLimit)
      : new NoOpRateLimiter();
    this.eventStream = new InMemoryEventStream();
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
    const workspacePlan = this.workspaceManager.resolveWorkspacePlan({
      taskKind: "top-level",
      cwd: input.cwd,
      policyUnsafeDirectCwd: policy.unsafeDirectCwd,
    });
    const workspace = this.workspaceManager.createTopLevelWorkspace({
      taskId,
      cwd: input.cwd,
      plan: workspacePlan,
      createdAt: now,
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
    await this.emitEvent({ type: "task.queued", taskId: task.id, ts: now });
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
    const approvals = this.db.listApprovals(taskId);
    const now = new Date().toISOString();
    const expiredIds = expirePendingApprovals(approvals, now);

    if (expiredIds.length > 0) {
      this.db.expireApprovals(expiredIds, now);
      return this.db.listApprovals(taskId);
    }

    return approvals;
  }

  listArtifacts(taskId: string): ReturnType<AppDatabase["listArtifacts"]> {
    return this.db.listArtifacts(taskId);
  }

  createApproval(input: {
    taskId: string;
    kind: ApprovalKind;
    payload: Record<string, unknown>;
    expiresAt?: string | undefined;
  }): string {
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    this.db.createApproval({
      id: approvalId,
      taskId: input.taskId,
      kind: input.kind,
      payload: JSON.parse(redactText(JSON.stringify(input.payload), { additionalPatterns: this.config.redaction.additionalPatterns })) as Record<string, unknown>,
      status: "pending",
      requestedAt: now,
      expiresAt: input.expiresAt,
    });
    return approvalId;
  }

  async resolveApproval(input: { approvalId: string; approved: boolean; reason?: string | undefined }): Promise<void> {
    const approvalRecords = this.db.listApprovals();
    const approval = approvalRecords.find((entry) => entry.id === input.approvalId);
    const resolvedAt = new Date().toISOString();
    this.db.resolveApproval({
      approvalId: input.approvalId,
      status: input.approved ? "approved" : "denied",
      resolvedAt,
      resolutionReason: input.reason,
    });

    if (!approval) {
      return;
    }

    const task = this.db.getTask(approval.taskId);
    const resolvedEvent: AgentEvent = {
      type: "approval.resolved",
      taskId: approval.taskId,
      approvalId: input.approvalId,
      approved: input.approved,
      ts: resolvedAt,
    };

    await this.emitEvent(resolvedEvent);

    if (!input.approved || !task) {
      return;
    }

    const latestTurn = this.db.getLatestTurn(task.id);
    const remainingPendingApprovals = this.db.listPendingApprovals(task.id).length;
    const continuation = this.decideApprovalContinuation({
      approval,
      task,
      latestTurn,
      remainingPendingApprovals,
    });

    if (approval.kind === "budget_increase") {
      this.db.updateTaskBudget(task.id, {
        ...task.budget,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
    }

    if (continuation.kind === "resolve_only") {
      return;
    }

    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "queued",
      backendThreadId: task.backendThreadId,
      updatedAt: resolvedAt,
    });

    if (continuation.kind === "auto_resume") {
      const pending = this.continueTaskAfterApproval(task.id, continuation.prompt)
        .catch(() => {})
        .finally(() => {
          this.pendingContinuations.delete(pending);
        });
      this.pendingContinuations.add(pending);
    }
  }

  async requestCapability(input: CapabilityRequestInput): Promise<{ approvalId: string; status: "pending" }> {
    const task = this.requireTask(input.taskId);
    const approvalId = this.createApproval({
      taskId: input.taskId,
      kind: input.kind,
      payload: { reason: input.reason },
    });
    await this.emitAndProjectEvent(task, {
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

  async delegateTask(input: DelegateTaskInput): Promise<DelegateToResult> {
    const parentTask = this.requireTask(input.parentTaskId);
    const parentProfile = this.requireProfile(parentTask.profileId);
    const parentPolicy = this.requirePolicy(parentProfile.policyId);

    if (!parentPolicy.allowCrossHarnessDelegation) {
      return { status: "denied", message: "cross_harness_delegation_disabled" };
    }

    try {
      assertReadOnlyDelegation(input);
    } catch (error) {
      return { status: "denied", message: error instanceof Error ? error.message : String(error) };
    }

    let targetProfile;
    try {
      targetProfile = resolveDelegationTargetProfile(this.config, parentTask, input);
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    if (targetProfile.runtime === parentTask.runtime) {
      return { status: "denied", message: "cross_harness_delegation_required" };
    }

    const targetPolicy = this.requirePolicy(targetProfile.policyId);
    const nextDepth = nextDelegationDepth(parentTask.delegationDepth);
    if (exceedsDelegationDepth(parentTask.delegationDepth, parentPolicy.maxDepth) || exceedsDelegationDepth(parentTask.delegationDepth, targetPolicy.maxDepth)) {
      return { status: "max_depth", message: "max_depth" };
    }
    if (targetPolicy.permissionMode !== "read-only" || targetPolicy.sandboxMode !== "read-only" || targetPolicy.networkAllowed) {
      return { status: "denied", message: "target_profile_not_readonly" };
    }

    const lineage = this.getTaskLineage(parentTask);
    if (wouldCreateDelegationCycle(lineage, targetProfile)) {
      return { status: "cycle_detected", message: "cycle_detected" };
    }

    if (input.references && input.references.length > 0) {
      const denied = this.evaluateReferenceAccess({
        requesterTask: parentTask,
        requesterPolicy: parentPolicy,
        targetPolicy,
        references: input.references,
      });
      if (denied) {
        return { status: "denied", message: denied };
      }
    }

    if (shouldRequireApproval(parentPolicy, "cross_harness_delegation")) {
      const approvalId = this.createApproval({
        taskId: parentTask.id,
        kind: "cross_harness_delegation",
        payload: {
          targetProfileId: targetProfile.id,
          targetRuntime: targetProfile.runtime,
          taskType: input.taskType,
          reason: input.reason,
        },
      });
      const now = new Date().toISOString();
      await this.emitAndProjectEvent(parentTask, {
        type: "approval.requested",
        taskId: parentTask.id,
        approvalId,
        kind: "cross_harness_delegation",
        ts: now,
      });
      return {
        status: "awaiting_approval",
        approvalId,
        message: "cross_harness_delegation_awaiting_approval",
      };
    }

    const now = new Date().toISOString();
    const childTaskId = randomUUID();
    const childWorkspacePlan = this.workspaceManager.resolveWorkspacePlan({
      taskKind: "child",
      cwd: parentTask.cwd,
      parentWorkspace: this.requireWorkspace(parentTask.workspaceId),
      requestedWorkspaceMode: input.workspaceMode,
    });
    const workspace = this.workspaceManager.createChildWorkspace({
      taskId: childTaskId,
      cwd: parentTask.cwd,
      parentWorkspace: this.requireWorkspace(parentTask.workspaceId),
      plan: childWorkspacePlan,
      createdAt: now,
    });
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
    await this.emitEvent({ type: "delegation.requested", taskId: parentTask.id, request: { ...input, targetProfileId: targetProfile.id }, ts: now });
    await this.emitEvent({ type: "task.queued", taskId: childTask.id, ts: now });
    await this.emitEvent({ type: "delegation.started", taskId: parentTask.id, childTaskId: childTask.id, ts: now });

    const run = this.runDelegatedChild(parentTask.id, childTask.id, input.prompt);
    this.activeRuns.set(childTask.id, run);

    const timeoutMs = input.timeoutMs ?? 45_000;
    const completed = await waitForCompletion(run, timeoutMs);
    if (!completed) {
      return {
        status: "started",
        childTaskId: childTask.id,
        message: "delegation_started",
      };
    }

    const childResult = this.getTaskResult(parentTask.id, childTask.id);
    if (childResult.status === "failed" || childResult.status === "interrupted") {
      return {
        status: "failed",
        childTaskId: childTask.id,
        message: childResult.status,
        finalResponse: childResult.latestMessage,
        artifactRefs: toArtifactRefs(childResult.artifacts),
      };
    }

    return {
      status: childResult.status === "awaiting_approval" ? "awaiting_approval" : "completed",
      childTaskId: childTask.id,
      finalResponse: childResult.latestMessage,
      artifactRefs: toArtifactRefs(childResult.artifacts),
      message: childResult.status,
    };
  }

  async waitForTask(requesterTaskId: string, taskId: string, timeoutMs = 45_000): Promise<TaskResultSnapshot> {
    const activeRun = this.activeRuns.get(taskId);
    if (activeRun) {
      await waitForCompletion(activeRun, timeoutMs);
    }
    return this.getTaskResult(requesterTaskId, taskId);
  }

  private async runDelegatedChild(parentTaskId: string, childTaskId: string, prompt: string): Promise<void> {
    try {
      await this.runTask({
        taskId: childTaskId,
        prompt,
      });
    } catch {
      // runTask already records failure state and event details.
    } finally {
      this.activeRuns.delete(childTaskId);
      await this.emitEvent({ type: "delegation.completed", taskId: parentTaskId, childTaskId, ts: new Date().toISOString() });
    }
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
      waitForTask: async (input) => this.toMcpToolResult(await this.waitForTask(taskId, input.taskId, input.timeoutMs)),
      getTaskResult: async (input) => this.toMcpToolResult(this.getTaskResult(taskId, input.taskId)),
      reportArtifact: async (input) => this.toMcpToolResult(this.reportArtifact({ taskId, ...input })),
    };
  }

  async runTask(input: RunTaskInput): Promise<void> {
    const task = this.db.getTask(input.taskId);
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`);
    }

    const profile = this.config.profiles[task.profileId];
    if (!profile) {
      throw new Error(`Unknown profile: ${task.profileId}`);
    }

    const runtime = this.runtimes[task.runtime];
    if (!runtime) {
      throw new Error(`Runtime adapter not configured for ${task.runtime}`);
    }

    // Check rate limits before starting
    const rateLimitCheck = await this.rateLimiter.checkLimit(profile.accountId);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    // Block here until a slot frees (per-account + global concurrency limits).
    // For long waits, callers can observe queue depth via getSchedulerSnapshot().
    await this.scheduler.acquire(task.id, profile.accountId);
    this.rateLimiter.recordRequest(profile.accountId);

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
    await this.emitEvent({
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
      this.scheduler.recordComplete(task.id);
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
    await this.emitEvent({
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
    await this.emitEvent({ type: "task.cancelled", taskId: task.id, ts: now });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(Array.from(this.pendingContinuations));
    await this.eventStore.close();
    this.eventStream.close();
    this.db.close();
  }

  subscribeToEvents(listener: (event: AgentEvent) => void): () => void {
    return this.eventStream.subscribe(listener);
  }

  /**
   * Replays persisted events from SQLite, then attaches a live subscription. The cursor is
   * advanced as we drain history so a parallel writer cannot duplicate or skip events between
   * the historical pull and the live attach.
   */
  async replayAndSubscribe(input: {
    taskId?: string | undefined;
    sinceId?: number | undefined;
    listener: (event: AgentEvent) => void;
  }): Promise<{ unsubscribe: () => void; lastReplayedId: number }> {
    await this.eventStore.flush();
    let cursor = input.sinceId ?? 0;

    while (true) {
      const batch = this.db.listEvents({ taskId: input.taskId, afterId: cursor, limit: 500 });
      if (batch.length === 0) {
        break;
      }
      for (const row of batch) {
        input.listener(row.payload as AgentEvent);
        cursor = row.id;
      }
    }

    const unsubscribe = this.eventStream.subscribe((event) => {
      if (input.taskId && event.taskId !== input.taskId) {
        return;
      }
      input.listener(event);
    });

    return { unsubscribe, lastReplayedId: cursor };
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

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return workspace;
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

  private evaluateReferenceAccess(input: {
    requesterTask: Task;
    requesterPolicy: Policy;
    targetPolicy: Policy;
    references: TaskReference[];
  }): string | null {
    const requesterLineage = this.getTaskLineage(input.requesterTask).map((task) => task.id);
    const requesterTrust = policyTrustLevel(input.requesterPolicy);

    for (const reference of input.references) {
      const targetTask = this.db.getTask(reference.taskId);
      if (!targetTask) {
        return `reference_unknown:${reference.taskId}`;
      }

      const targetProfile = this.config.profiles[targetTask.profileId];
      const targetTrust = targetProfile
        ? policyTrustLevel(this.requirePolicy(targetProfile.policyId))
        : policyTrustLevel(input.targetPolicy);

      const allowed = canAccessReference({
        requesterTaskId: input.requesterTask.id,
        requesterLineage,
        targetTaskId: targetTask.id,
        sameWorkspace: targetTask.workspaceId === input.requesterTask.workspaceId,
        requesterTrustLevel: requesterTrust,
        targetTrustLevel: targetTrust,
        explicitApproval: false,
      });

      if (!allowed) {
        return `reference_denied:${reference.taskId}`;
      }

      // Audit every successful expansion so reviewers can reconstruct what a child saw.
      void this.emitEvent({
        type: "reference.expanded",
        taskId: input.requesterTask.id,
        sourceTaskId: targetTask.id,
        requestedByTaskId: input.requesterTask.id,
        ts: new Date().toISOString(),
      });
    }

    return null;
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
    const rawCipher = buildRawTranscriptCipher({
      prompt,
      config: this.config.transcript,
      now: new Date(startedAt),
    });
    this.db.createTurn({
      id: turnId,
      taskId,
      promptRedacted,
      status: "running",
      startedAt,
      ...(rawCipher ? { promptRawEncrypted: rawCipher.encrypted, promptRawTtlAt: rawCipher.ttlAt } : {}),
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
    const profile = this.requireProfile(task.profileId);
    const policy = this.requirePolicy(profile.policyId);

    for await (const event of runtime.runTurn(input)) {
      await this.emitAndProjectEvent(task, event);

      if (event.type === "turn.completed") {
        this.db.updateTurn({
          turnId,
          status: "completed",
          usage: event.usage,
          completedAt: event.ts,
        });

        if (event.usage && policy) {
          const updatedTask = this.db.getTask(task.id);
          if (updatedTask) {
            this.rateLimiter.recordUsage(profile.accountId, usageToRateLimitTokens(event.usage));
            const newBudget = updateBudget(updatedTask.budget, event.usage);
            const budgetCheck = checkBudget(newBudget, policy);

            this.db.updateTaskBudget(task.id, newBudget);

            if (budgetCheck.warning) {
              await this.emitAndProjectEvent(task, {
                type: "budget.warning",
                taskId: task.id,
                message: budgetCheck.warning,
                ts: new Date().toISOString(),
              });
            }

            if (!budgetCheck.allowed) {
              const exceededAt = new Date().toISOString();
              const approvalId = this.createApproval({
                taskId: task.id,
                kind: "budget_increase",
                payload: {
                  reason: budgetCheck.reason ?? "Budget exceeded",
                  budget: newBudget,
                },
              });
              await this.emitAndProjectEvent(task, {
                type: "budget.exceeded",
                taskId: task.id,
                message: budgetCheck.reason ?? "Budget exceeded",
                ts: exceededAt,
              });
              // recordEvent flips task status to awaiting_approval when type is
              // approval.requested, so we don't need a separate updateTaskRuntimeState.
              await this.emitAndProjectEvent(task, {
                type: "approval.requested",
                taskId: task.id,
                approvalId,
                kind: "budget_increase",
                ts: exceededAt,
              });
            }
          }
        }
      }

      if (event.type === "task.interrupted" || event.type === "task.failed") {
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

    const currentTask = this.db.getTask(task.id);
    if (currentTask?.status !== "awaiting_approval") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "completed",
        backendThreadId,
        updatedAt: completedAt,
        completedAt,
      });
      await this.emitEvent({
        type: "task.completed",
        taskId: task.id,
        summary: "Run completed",
        ts: completedAt,
      });
    }
  }

  private async failTask(
    taskId: string,
    backendThreadId: string | undefined,
    error: unknown,
    markInterrupted: boolean,
  ): Promise<void> {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const task = this.db.getTask(taskId);
    if (!task) {
      return;
    }
    const event: AgentEvent = markInterrupted
      ? {
          type: "task.interrupted",
          taskId,
          error: message,
          ts: failedAt,
        }
      : {
          type: "task.failed",
          taskId,
          error: message,
          ts: failedAt,
        };
    await this.emitAndProjectEvent(task, event);
  }

  private async continueTaskAfterApproval(taskId: string, prompt?: string | undefined): Promise<void> {
    if (this.closed) {
      return;
    }
    const task = this.db.getTask(taskId);
    if (!task) {
      return;
    }
    if (this.db.listPendingApprovals(task.id).length > 0) {
      return;
    }

    const latestTurn = this.db.getLatestTurn(task.id);
    if (this.canResumeTask(task, latestTurn)) {
      await this.resumeTask({ taskId: task.id, prompt });
      return;
    }

    if (this.closed) {
      return;
    }
    if (task.status === "queued") {
      const turnPrompt = prompt ?? latestTurn?.promptRedacted;
      if (turnPrompt) {
        await this.runTask({ taskId: task.id, prompt: turnPrompt });
      }
    }
  }

  private decideApprovalContinuation(input: {
    approval: ReturnType<AppDatabase["listApprovals"]>[number];
    task: Task;
    latestTurn: ReturnType<AppDatabase["getLatestTurn"]>;
    remainingPendingApprovals: number;
  }): ApprovalContinuation {
    if (input.remainingPendingApprovals > 0) {
      return { kind: "resolve_only" };
    }

    if (input.approval.kind === "cross_harness_delegation") {
      return { kind: "requeue" };
    }

    if (input.approval.kind === "budget_increase") {
      return this.canResumeTask(input.task, input.latestTurn)
        ? { kind: "auto_resume" }
        : { kind: "requeue" };
    }

    return this.canResumeTask(input.task, input.latestTurn)
      ? { kind: "auto_resume" }
      : { kind: "requeue" };
  }

  private canResumeTask(task: Task, latestTurn: ReturnType<AppDatabase["getLatestTurn"]>): boolean {
    if (!task.backendThreadId) {
      return false;
    }
    const resumableStatuses: Task["status"][] = ["interrupted", "reconcile_required", "queued", "awaiting_approval"];
    if (!resumableStatuses.includes(task.status)) {
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
    if (latestTurn?.status === "running") {
      return false;
    }
    return true;
  }

  private async emitEvent(event: AgentEvent): Promise<void> {
    await this.eventStore.append(event);
    this.eventStream.publish(event);
  }

  private async projectEvent(task: Task, event: AgentEvent): Promise<void> {
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

    if (event.type === "task.backend_thread") {
      const current = this.db.getTask(task.id);
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: current?.status ?? "running",
        backendThreadId: event.backendThreadId,
        updatedAt: event.ts,
      });
      return;
    }

    if (event.type === "task.interrupted") {
      const current = this.db.getTask(task.id);
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "interrupted",
        backendThreadId: current?.backendThreadId ?? task.backendThreadId,
        updatedAt: event.ts,
      });
      return;
    }

    if (event.type === "task.failed") {
      const current = this.db.getTask(task.id);
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "failed",
        backendThreadId: current?.backendThreadId ?? task.backendThreadId,
        updatedAt: event.ts,
        completedAt: event.ts,
      });
      return;
    }

    if (event.type === "approval.requested") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "awaiting_approval",
        backendThreadId: task.backendThreadId,
        updatedAt: event.ts,
      });
    }
  }

  private async emitAndProjectEvent(task: Task, event: AgentEvent): Promise<void> {
    await this.emitEvent(event);
    await this.projectEvent(task, event);
  }

}

function usageToRateLimitTokens(usage: TurnUsage): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
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

async function waitForCompletion(run: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function toArtifactRefs(artifacts: StoredArtifact[]): ArtifactRef[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    ref: artifact.ref,
    ...(artifact.description ? { description: artifact.description } : {}),
  }));
}
