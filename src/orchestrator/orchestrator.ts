import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ApprovalPayload, ApprovalView, CanonicalEvent, EventEnvelope, ItemPayload, TaskError } from "../core/events.js";
import type { AppConfig, ApprovalKind, ArtifactRef, BudgetSnapshot, DelegateToResult, Policy, RuntimeSession, Task, TaskReference, TurnUsage, Workspace, WorkspaceDiff, WorkspaceMergeError, WorkspaceMergeResult } from "../core/types.js";
import type { AutoPmMcpHandlers, McpToolResult } from "../mcp/auto-pm-service.js";
import { redactText } from "../core/redaction.js";
import { canAccessReference, policyTrustLevel } from "../core/reference.js";
import { buildRawTranscriptCipher } from "../core/transcript.js";
import { AppDatabase, type StoredApproval, type StoredArtifact } from "../storage/db.js";
import { AppError } from "../api/types.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { shouldRequireApproval } from "./policy.js";
import { canAccessTaskLineage, evaluateDelegationPolicy, exceedsDelegationDepth, resolveDelegationTargetProfile, type DelegateTaskInput as DelegateTaskRequest, wouldCreateDelegationCycle } from "./delegation.js";
import { buildDelegationChain, nextDelegationDepth } from "./task-tree.js";
import { WorkspaceManager } from "./workspace.js";
import { checkBudget, updateBudget } from "./budget.js";
import { DefaultTaskScheduler } from "./scheduler.js";
import { NoOpRateLimiter, TokenBucketRateLimiter, type RateLimiter } from "./rate-limit.js";
import { EventHub } from "./event-hub.js";
import { expirePendingApprovals } from "./approval.js";
import { buildContinuationContext, withContinuationPrompt } from "./continuation-context.js";

export interface CreateTaskInput {
  profileId: string;
  cwd: string;
  name?: string;
  model?: string | undefined;
}

export interface RunTaskInput {
  taskId: string;
  prompt: string;
  requestId?: string | undefined;
}

export interface SendTurnInput extends RunTaskInput {}

export interface ResumeTaskInput {
  taskId: string;
  prompt?: string | undefined;
  requestId?: string | undefined;
}

export interface HandoffTaskInput {
  taskId: string;
  targetProfileId: string;
  prompt?: string | undefined;
  reason: string;
  requestId?: string | undefined;
}

export interface ForkTaskInput {
  taskId: string;
  fromTurnId?: string | undefined;
  name?: string | undefined;
  mode?: "task" | "session" | undefined;
  prompt?: string | undefined;
  requestId?: string | undefined;
}

export interface ForkTaskResult {
  forkKind: "native" | "logical";
  sourceTaskId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  childTaskId?: string | undefined;
  childSessionId: string;
}

export interface RolloverSessionInput {
  taskId: string;
  reason: "context_limit" | "model_change" | "profile_change" | "session_corrupt" | "manual";
  targetProfileId?: string | undefined;
  carryOverPrompt?: string | undefined;
  requestId?: string | undefined;
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
  model: string;
  latestMessage?: string | undefined;
  terminalError?: string | undefined;
  artifacts: StoredArtifact[];
  pendingApprovalIds: string[];
}

type ApprovalContinuation =
  | { kind: "resolve_only" }
  | { kind: "requeue" }
  | { kind: "auto_resume"; prompt?: string | undefined };

export class Orchestrator {
  private readonly workspaceManager: WorkspaceManager;
  private readonly eventHub: EventHub;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly activeTaskActions = new Set<string>();
  private readonly pauseRequests = new Set<string>();
  private readonly scheduler: DefaultTaskScheduler;
  private readonly rateLimiter: RateLimiter;
  private readonly pendingContinuations = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly runtimes: Record<string, RuntimeAdapter> = {},
  ) {
    this.workspaceManager = new WorkspaceManager(config.workspace);
    this.eventHub = new EventHub(this.db.db, {
      redaction: { additionalPatterns: config.redaction.additionalPatterns },
    });
    this.scheduler = new DefaultTaskScheduler({
      maxConcurrentTasksGlobal: config.scheduler.maxConcurrentTasksGlobal,
      maxConcurrentTasksPerAccount: config.scheduler.maxConcurrentTasksPerAccount,
    });
    this.rateLimiter = config.rateLimit.enabled
      ? new TokenBucketRateLimiter(config.rateLimit)
      : new NoOpRateLimiter();
  }

  syncConfig(): void {
    this.db.syncConfig(this.config);
  }

  configRedactionPatterns(): string[] {
    return this.config.redaction.additionalPatterns;
  }

  recoverStaleRunningTasks(): { recoveredTaskIds: string[] } {
    const now = new Date().toISOString();
    const staleTasks = [
      ...this.db.listTasksByStatus("running"),
      ...this.db.listTasksByStatus("cancelling"),
    ];
    for (const task of staleTasks) {
      const terminalEvent = this.db.getLatestTerminalTaskEvent(task.id);
      if (terminalEvent) {
        const status = terminalEventToTaskStatus(terminalEvent.type);
        this.db.updateTaskRuntimeState({
          taskId: task.id,
          status,
          updatedAt: terminalEvent.ts,
          ...(status === "closed" ? { closedAt: terminalEvent.ts } : {}),
        });
        continue;
      }
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "reconcile_required",
        updatedAt: now,
      });
    }
    return { recoveredTaskIds: staleTasks.map((task) => task.id) };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const profile = this.config.profiles[input.profileId];
    if (!profile) {
      throw new Error(`Unknown profile: ${input.profileId}`);
    }

    const policy = this.requirePolicy(profile.policyId);
    const model = resolveTaskModel(profile, input.model);
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
      model,
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
    this.publishTaskEvent(task, { kind: "task.queued" }, { ts: now });
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

  getLatestCompletedMessage(taskId: string): string | undefined {
    return this.db.getLatestCompletedMessage(taskId);
  }

  getLatestTerminalError(taskId: string): string | undefined {
    return this.db.getLatestTerminalError(taskId);
  }

  getWorkspace(workspaceId: string): ReturnType<AppDatabase["getWorkspace"]> {
    return this.db.getWorkspace(workspaceId);
  }

  listWorkspaceChanges(taskId: string): WorkspaceDiff["changes"] {
    const task = this.requireTask(taskId);
    const workspace = this.requireWorkspace(task.workspaceId);
    return this.workspaceManager.listChanges(workspace);
  }

  getWorkspaceDiff(taskId: string): WorkspaceDiff {
    const task = this.requireTask(taskId);
    const workspace = this.requireWorkspace(task.workspaceId);
    if (!workspace.baseRef) {
      throw new Error("workspace_missing_base_ref");
    }
    const inspected = this.workspaceManager.inspectWorkspace(workspace);
    const patch = redactText(this.workspaceManager.getDiffPatch(workspace), {
      additionalPatterns: this.config.redaction.additionalPatterns,
    });
    return {
      taskId,
      workspaceId: workspace.id,
      baseRef: workspace.baseRef,
      head: inspected.head,
      changes: this.workspaceManager.listChanges(workspace),
      patch,
      truncated: false,
    };
  }

  async requestWorkspaceMerge(input: { taskId: string; reason: string }): Promise<{ approvalId: string; workspaceId: string }> {
    const task = this.requireTask(input.taskId);
    const workspace = this.requireWorkspace(task.workspaceId);
    const parentWorkspace = this.requireParentWorkspace(workspace);
    this.assertWorkspaceMergeable(workspace, parentWorkspace);
    const parentInspection = this.workspaceManager.inspectWorkspace(parentWorkspace);
    if (parentInspection.dirty) {
      throw new Error("parent_workspace_dirty");
    }

    const approvalId = this.createApproval({
      taskId: task.id,
      kind: "workspace_merge",
      payload: {
        reason: input.reason,
        workspaceId: workspace.id,
        changes: this.workspaceManager.listChanges(workspace),
      },
    });
    const now = new Date().toISOString();
    this.db.updateWorkspaceLifecycle({
      workspaceId: workspace.id,
      status: "merge_requested",
      mergeRequestedAt: now,
      mergeApprovalId: approvalId,
      mergeError: null,
    });
    this.publishTaskEvent(task, {
      kind: "workspace.merge_requested",
      workspaceId: workspace.id,
      approvalId,
    }, { ts: now });
    return { approvalId, workspaceId: workspace.id };
  }

  async applyApprovedWorkspaceMerge(input: { taskId: string; approvalId: string }): Promise<WorkspaceMergeResult> {
    const task = this.requireTask(input.taskId);
    const workspace = this.requireWorkspace(task.workspaceId);
    const parentWorkspace = this.requireParentWorkspace(workspace);
    this.assertWorkspaceMergeable(workspace, parentWorkspace, true);
    const approval = this.db.listApprovals(task.id).find((entry) => entry.id === input.approvalId);
    if (!approval || approval.kind !== "workspace_merge" || approval.status !== "approved") {
      throw new Error("workspace_merge_approval_required");
    }

    const changes = this.workspaceManager.listChanges(workspace);
    const parentInspection = this.workspaceManager.inspectWorkspace(parentWorkspace);
    const childInspection = this.workspaceManager.inspectWorkspace(workspace);
    const parentAdvanced = Boolean(parentInspection.head && parentInspection.head !== workspace.baseRef);
    const startedAt = new Date().toISOString();
    this.db.updateWorkspaceLifecycle({ workspaceId: workspace.id, status: "merging", mergeError: null });
    this.publishTaskEvent(task, {
      kind: "workspace.merge_started",
      workspaceId: workspace.id,
      parentAdvanced,
    }, { ts: startedAt });

    if (parentInspection.dirty) {
      const error: WorkspaceMergeError = {
        code: "parent_dirty",
        message: "parent_workspace_dirty",
        parentHead: parentInspection.head,
        childHead: childInspection.head,
      };
      return this.recordWorkspaceMergeFailure(task, workspace, changes, parentAdvanced, error);
    }

    try {
      const patch = this.workspaceManager.getDiffPatch(workspace);
      const applyResult = this.workspaceManager.applyPatchToParent({
        parentWorkspace,
        childWorkspace: workspace,
        patch,
      });
      const mergedAt = new Date().toISOString();
      this.db.updateWorkspaceLifecycle({
        workspaceId: workspace.id,
        status: "merged",
        head: applyResult.childHead,
        dirty: false,
        mergedAt,
        mergeError: null,
      });
      this.publishTaskEvent(task, {
        kind: "workspace.merged",
        workspaceId: workspace.id,
        parentAdvanced: applyResult.parentAdvanced,
      }, { ts: mergedAt });
      return {
        taskId: task.id,
        workspaceId: workspace.id,
        status: "merged",
        parentAdvanced: applyResult.parentAdvanced,
        parentHead: applyResult.parentHead,
        childHead: applyResult.childHead,
        changes,
      };
    } catch (error) {
      const mergeError: WorkspaceMergeError = {
        code: "merge_conflict",
        message: error instanceof Error ? error.message : String(error),
        parentHead: parentInspection.head,
        childHead: childInspection.head,
      };
      return this.recordWorkspaceMergeFailure(task, workspace, changes, parentAdvanced, mergeError);
    }
  }

  async discardWorkspace(taskId: string): Promise<{ taskId: string; workspaceId: string; status: Workspace["status"] }> {
    const task = this.requireTask(taskId);
    const workspace = this.requireWorkspace(task.workspaceId);
    if (!workspace.parentWorkspaceId) {
      throw new Error("cannot_discard_top_level_workspace");
    }
    if (workspace.status === "merged" || workspace.status === "discarded") {
      throw new Error("workspace_not_discardable");
    }
    this.workspaceManager.discardWorkspace(workspace);
    const discardedAt = new Date().toISOString();
    this.db.updateWorkspaceLifecycle({
      workspaceId: workspace.id,
      status: "discarded",
      discardedAt,
    });
    this.publishTaskEvent(task, {
      kind: "workspace.discarded",
      workspaceId: workspace.id,
    }, { ts: discardedAt });
    return { taskId: task.id, workspaceId: workspace.id, status: "discarded" };
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
    if (task) {
      this.publishTaskEvent(task, {
        kind: "approval.resolved",
        approvalId: input.approvalId,
        approved: input.approved,
        ...(input.reason ? { reason: input.reason } : {}),
      }, { ts: resolvedAt });
    }

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
    const approval = this.requireApproval(approvalId);
    this.publishAndProjectTaskEvent(task, {
      kind: "approval.requested",
      approval: toApprovalView(approval),
    }, { ts: approval.requestedAt });
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
      return deniedDelegation("cross_harness_delegation_disabled");
    }

    let targetProfile;
    try {
      targetProfile = resolveDelegationTargetProfile(this.config, parentTask, input);
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    if (targetProfile.runtime === parentTask.runtime) {
      return deniedDelegation("cross_harness_delegation_required");
    }

    const targetPolicy = this.requirePolicy(targetProfile.policyId);
    const parentWorkspace = this.requireWorkspace(parentTask.workspaceId);
    const inspectedParentWorkspace = {
      ...parentWorkspace,
      ...this.workspaceManager.inspectWorkspace(parentWorkspace),
    };
    const delegationPolicy = evaluateDelegationPolicy({
      request: input,
      parentPolicy,
      targetPolicy,
      parentWorkspace: inspectedParentWorkspace,
    });
    if (!delegationPolicy.allowed) {
      return deniedDelegation(delegationPolicy.denialCode, delegationPolicy.message);
    }

    const nextDepth = nextDelegationDepth(parentTask.delegationDepth);
    if (exceedsDelegationDepth(parentTask.delegationDepth, parentPolicy.maxDepth) || exceedsDelegationDepth(parentTask.delegationDepth, targetPolicy.maxDepth)) {
      return { status: "max_depth", denialCode: "max_depth", message: "max_depth" };
    }

    const lineage = this.getTaskLineage(parentTask);
    if (wouldCreateDelegationCycle(lineage, targetProfile)) {
      return { status: "cycle_detected", denialCode: "cycle_detected", message: "cycle_detected" };
    }

    if (input.references && input.references.length > 0) {
      const denied = this.evaluateReferenceAccess({
        requesterTask: parentTask,
        requesterPolicy: parentPolicy,
        targetPolicy,
        references: input.references,
      });
      if (denied) {
        return deniedDelegation(denied);
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
      const approval = this.requireApproval(approvalId);
      this.publishAndProjectTaskEvent(parentTask, {
        kind: "approval.requested",
        approval: toApprovalView(approval),
      }, { ts: now });
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
      parentWorkspace: inspectedParentWorkspace,
      requestedWorkspaceMode: delegationPolicy.workspaceMode,
    });
    const workspace = this.workspaceManager.createChildWorkspace({
      taskId: childTaskId,
      cwd: parentTask.cwd,
      parentWorkspace: inspectedParentWorkspace,
      plan: childWorkspacePlan,
      createdAt: now,
    });
    const childTask: Task = {
      id: childTaskId,
      name: `${input.taskType}:${targetProfile.runtime}`,
      profileId: targetProfile.id,
      runtime: targetProfile.runtime,
      model: resolveTaskModel(targetProfile),
      cwd: workspace.path,
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
    this.publishTaskEvent(parentTask, {
      kind: "item.started",
      item: {
        id: delegationItemId(childTask.id),
        taskId: parentTask.id,
        sessionId: this.sessionIdForTask(parentTask),
        kind: "delegation",
        status: "in_progress",
        startedAt: now,
        updatedAt: now,
        payload: {
          childTaskId: childTask.id,
          targetRuntime: targetProfile.runtime,
          targetProfileId: targetProfile.id,
          prompt: input.prompt,
          status: "started",
        },
      },
    }, { ts: now });
    this.publishTaskEvent(childTask, { kind: "task.queued" }, { ts: now });

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
      const parentTask = this.db.getTask(parentTaskId);
      if (parentTask) {
        const completedAt = new Date().toISOString();
        this.publishTaskEvent(parentTask, {
          kind: "item.completed",
          itemId: delegationItemId(childTaskId),
          itemKind: "delegation",
          finalPayload: {
            childTaskId,
            status: "completed",
            finalResponse: this.db.getLatestCompletedMessage(childTaskId),
          },
          completedAt,
        }, { ts: completedAt });
      }
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

  createDiagnosticMcpHandlers(taskId = "__diagnostic__"): AutoPmMcpHandlers {
    return {
      delegateTo: async () => this.toMcpToolResult({ status: "diagnostic" }),
      requestCapability: async () => this.toMcpToolResult({ approvalId: `diagnostic-${taskId}`, status: "pending" }),
      waitForTask: async () => this.toMcpToolResult({ taskId, status: "completed", artifacts: [], pendingApprovalIds: [] }),
      getTaskResult: async () => this.toMcpToolResult({ taskId, status: "completed", artifacts: [], pendingApprovalIds: [] }),
      reportArtifact: async () => this.toMcpToolResult({ id: `diagnostic-${taskId}`, taskId, kind: "file", ref: "diagnostic" }),
    };
  }

  async runTask(input: RunTaskInput): Promise<void> {
    await this.sendTurn(input);
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const task = this.db.getTask(input.taskId);
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`);
    }
    const existing = input.requestId ? this.db.getTurnByRequestId(task.id, input.requestId) : null;
    if (existing) {
      return;
    }
    this.assertCanSendTurn(task);
    const session = this.db.getCurrentSession(task.id) ?? this.createInitialSession(task, new Date().toISOString());
    await this.submitTurn({
      task,
      session,
      prompt: input.prompt,
      mode: session.backendThreadId ? "next_turn" : "first_turn",
      requestId: input.requestId,
      markInterruptedOnFailure: true,
    });
  }

  async handoffTask(input: HandoffTaskInput): Promise<void> {
    const task = this.requireTask(input.taskId);
    if (input.requestId && this.db.getTurnByRequestId(task.id, input.requestId)) {
      return;
    }
    this.assertCanRunSaga(task);
    const sourceSession = this.requireCurrentSession(task.id);
    const targetProfile = this.requireProfile(input.targetProfileId);
    const latestTurn = this.db.getLatestTurn(task.id);
    const now = new Date().toISOString();
    const context = this.createContinuationContext({
      kind: "handoff",
      task,
      sourceSession,
      sourceTurnId: latestTurn?.id,
      policyId: targetProfile.policyId,
      prompt: input.prompt,
      handoffReason: input.reason,
    });
    const targetSession = this.createRuntimeSession({
      task,
      profileId: targetProfile.id,
      model: resolveTaskModel(targetProfile),
      runtime: targetProfile.runtime,
      cwd: task.cwd,
      status: "opening",
      now,
      handoffFromSessionId: sourceSession.id,
    });

    this.publishAndProjectTaskEvent(task, {
      kind: "task.handoff_started",
      sourceSessionId: sourceSession.id,
      targetSessionId: targetSession.id,
      contextTokens: context.tokenEstimate,
    }, { ts: now, sessionId: targetSession.id });

    try {
      await this.submitTurn({
        task,
        session: targetSession,
        prompt: withContinuationPrompt(context.xml, input.prompt),
        mode: "handoff",
        requestId: input.requestId,
        markInterruptedOnFailure: false,
        idleReason: "handoff_completed",
        activateSession: false,
        projectTaskFailure: false,
      });
      const completedAt = new Date().toISOString();
      await this.closeRuntimeSessionHandle(sourceSession);
      this.db.updateRuntimeSession({
        sessionId: sourceSession.id,
        status: "closed",
        closeReason: "handoff",
        closedAt: completedAt,
      });
      this.db.updateRuntimeSession({
        sessionId: targetSession.id,
        status: "active",
        lastUsedAt: completedAt,
      });
      this.publishAndProjectTaskEvent(task, { kind: "session.closed", sessionId: sourceSession.id, reason: "handoff" }, { ts: completedAt, sessionId: sourceSession.id });
      this.publishAndProjectTaskEvent(task, { kind: "task.handoff_completed", sourceSessionId: sourceSession.id, targetSessionId: targetSession.id }, { ts: completedAt, sessionId: targetSession.id });
      this.db.updateTaskRuntimeState({ taskId: task.id, status: "idle", updatedAt: completedAt });
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.db.updateRuntimeSession({
        sessionId: targetSession.id,
        status: "failed",
        closeReason: "failed",
        closedAt: failedAt,
      });
      const current = this.db.getTask(task.id);
      if (current?.status !== "failed" && current?.status !== "closed") {
        this.db.updateTaskRuntimeState({
          taskId: task.id,
          status: "idle",
          updatedAt: failedAt,
        });
      }
      this.publishAndProjectTaskEvent(task, { kind: "session.failed", sessionId: targetSession.id, error: toTaskError(errorMessage(error)) }, { ts: failedAt, sessionId: targetSession.id });
      this.publishAndProjectTaskEvent(task, {
        kind: "task.handoff_failed",
        sourceSessionId: sourceSession.id,
        error: toTaskError(errorMessage(error)),
        rolledBack: true,
      }, { ts: failedAt, sessionId: sourceSession.id });
      throw error instanceof AppError && error.code === "continuation_context_too_large"
        ? error
        : new AppError("handoff_failed", `handoff_failed: ${errorMessage(error)}`);
    }
  }

  async forkTask(input: ForkTaskInput): Promise<ForkTaskResult> {
    const sourceTask = this.requireTask(input.taskId);
    if (input.requestId) {
      const existingTurn = this.db.getTurnByRequestId(sourceTask.id, input.requestId);
      if (existingTurn) {
        const existingSession = this.db.getRuntimeSession(existingTurn.sessionId);
        return {
          forkKind: sourceTask.runtime === "claude" ? "native" : "logical",
          sourceTaskId: sourceTask.id,
          sourceSessionId: existingSession?.parentSessionId ?? existingTurn.sessionId,
          sourceTurnId: existingTurn.id,
          childSessionId: existingTurn.sessionId,
        };
      }
    }
    this.assertCanRunSaga(sourceTask);
    const sourceSession = this.requireCurrentSession(sourceTask.id);
    const sourceTurn = input.fromTurnId
      ? this.db.listTurns(sourceTask.id).find((turn) => turn.id === input.fromTurnId)
      : this.db.listTurns(sourceTask.id).filter((turn) => turn.status === "completed").at(-1);
    if (!sourceTurn) {
      throw new AppError("not_recoverable", "not_recoverable");
    }
    if (sourceTurn.sessionId !== sourceSession.id) {
      throw new AppError("fork_truncation_required", "fork_truncation_required");
    }

    const now = new Date().toISOString();
    const mode = input.mode ?? "task";
    const childTask = mode === "task"
      ? this.createForkChildTask(sourceTask, input.name, now)
      : sourceTask;
    const targetSession = this.createRuntimeSession({
      task: childTask,
      profileId: sourceSession.profileId,
      model: sourceSession.model,
      runtime: sourceSession.runtime,
      cwd: childTask.cwd,
      status: mode === "task" ? "active" : "closed",
      now,
      parentSessionId: sourceSession.id,
      forkedFromTurnId: sourceTurn.id,
    });

    let forkKind: "native" | "logical" = "logical";
    try {
      if (sourceSession.runtime === "claude" && sourceSession.backendThreadId) {
        const runtime = this.runtimes[sourceSession.runtime];
        if (!runtime?.forkSession) {
          throw new AppError("runtime_capability_unavailable", "runtime_capability_unavailable");
        }
        if (input.fromTurnId) {
          throw new AppError("fork_truncation_required", "fork_truncation_required");
        }
        const result = await runtime.forkSession({
          taskId: childTask.id,
          sourceSessionId: sourceSession.id,
          targetSessionId: targetSession.id,
          profileId: sourceSession.profileId,
          model: sourceSession.model,
          cwd: childTask.cwd,
          sourceBackendThreadId: sourceSession.backendThreadId,
        });
      this.db.updateRuntimeSession({
        sessionId: targetSession.id,
        status: mode === "task" ? "active" : "closed",
        backendThreadId: result.backendThreadId,
        lastUsedAt: now,
      });
        forkKind = result.forkKind;
      if (mode === "session") {
        this.db.updateRuntimeSession({
          sessionId: targetSession.id,
          closeReason: "forked",
          closedAt: now,
        });
      }
      }

      if (sourceSession.runtime === "codex") {
        const context = this.createContinuationContext({
          kind: "fork",
          task: sourceTask,
          sourceSession,
          sourceTurnId: sourceTurn.id,
          policyId: this.requireProfile(sourceSession.profileId).policyId,
          prompt: input.prompt,
        });
        await this.submitTurn({
          task: childTask,
          session: targetSession,
          prompt: withContinuationPrompt(context.xml, input.prompt),
        mode: "fork",
        requestId: input.requestId,
        markInterruptedOnFailure: false,
        activateSession: mode === "task",
        projectTaskFailure: false,
      });
      if (mode === "session") {
        const forkedAt = new Date().toISOString();
        this.db.updateRuntimeSession({
          sessionId: targetSession.id,
          status: "closed",
          closeReason: "forked",
          closedAt: forkedAt,
        });
      }
    }
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.db.updateRuntimeSession({
        sessionId: targetSession.id,
        status: "failed",
        closeReason: "failed",
        closedAt: failedAt,
      });
      if (mode === "task" && childTask.id !== sourceTask.id) {
        this.db.updateTaskRuntimeState({
          taskId: childTask.id,
          status: "failed",
          updatedAt: failedAt,
        });
      }
      throw error;
    }

    this.publishAndProjectTaskEvent(sourceTask, {
      kind: "task.forked",
      sourceSessionId: sourceSession.id,
      targetSessionId: targetSession.id,
      forkKind,
      ...(mode === "task" ? { childTaskId: childTask.id } : {}),
    }, { ts: now, sessionId: sourceSession.id });

    return {
      forkKind,
      sourceTaskId: sourceTask.id,
      sourceSessionId: sourceSession.id,
      sourceTurnId: sourceTurn.id,
      ...(mode === "task" ? { childTaskId: childTask.id } : {}),
      childSessionId: targetSession.id,
    };
  }

  async rolloverSession(input: RolloverSessionInput): Promise<void> {
    const task = this.requireTask(input.taskId);
    if (input.requestId && this.db.getTurnByRequestId(task.id, input.requestId)) {
      return;
    }
    this.assertCanRunSaga(task);
    const sourceSession = this.requireCurrentSession(task.id);
    const targetProfile = input.targetProfileId ? this.requireProfile(input.targetProfileId) : this.requireProfile(sourceSession.profileId);
    const latestTurn = this.db.getLatestTurn(task.id);
    const now = new Date().toISOString();
    const context = this.createContinuationContext({
      kind: "rollover",
      task,
      sourceSession,
      sourceTurnId: latestTurn?.id,
      policyId: targetProfile.policyId,
      prompt: input.carryOverPrompt,
      rolloverReason: input.reason,
    });
    const targetSession = this.createRuntimeSession({
      task,
      profileId: targetProfile.id,
      model: resolveTaskModel(targetProfile),
      runtime: targetProfile.runtime,
      cwd: task.cwd,
      status: "opening",
      now,
      rolloverFromSessionId: sourceSession.id,
    });

    this.publishAndProjectTaskEvent(task, {
      kind: "task.rollover_started",
      sourceSessionId: sourceSession.id,
      targetSessionId: targetSession.id,
      reason: input.reason,
    }, { ts: now, sessionId: targetSession.id });

    try {
      await this.submitTurn({
        task,
        session: targetSession,
        prompt: withContinuationPrompt(context.xml, input.carryOverPrompt),
        mode: "rollover",
        requestId: input.requestId,
        markInterruptedOnFailure: false,
        idleReason: "rollover_completed",
        activateSession: false,
        projectTaskFailure: false,
      });
      const completedAt = new Date().toISOString();
      await this.closeRuntimeSessionHandle(sourceSession);
      this.db.updateRuntimeSession({
        sessionId: sourceSession.id,
        status: "closed",
        closeReason: "rollover",
        closedAt: completedAt,
      });
      this.db.updateRuntimeSession({
        sessionId: targetSession.id,
        status: "active",
        lastUsedAt: completedAt,
      });
      this.publishAndProjectTaskEvent(task, { kind: "session.closed", sessionId: sourceSession.id, reason: "rollover" }, { ts: completedAt, sessionId: sourceSession.id });
      this.publishAndProjectTaskEvent(task, { kind: "task.rollover_completed", sourceSessionId: sourceSession.id, targetSessionId: targetSession.id }, { ts: completedAt, sessionId: targetSession.id });
      this.db.updateTaskRuntimeState({ taskId: task.id, status: "idle", updatedAt: completedAt });
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.db.updateRuntimeSession({
        sessionId: targetSession.id,
        status: "failed",
        closeReason: "failed",
        closedAt: failedAt,
      });
      const current = this.db.getTask(task.id);
      if (current?.status !== "failed" && current?.status !== "closed") {
        this.db.updateTaskRuntimeState({
          taskId: task.id,
          status: "idle",
          updatedAt: failedAt,
        });
      }
      this.publishAndProjectTaskEvent(task, { kind: "session.failed", sessionId: targetSession.id, error: toTaskError(errorMessage(error)) }, { ts: failedAt, sessionId: targetSession.id });
      throw error instanceof AppError && error.code === "continuation_context_too_large"
        ? error
        : new AppError("rollover_failed", `rollover_failed: ${errorMessage(error)}`);
    }
  }

  async resumeTask(input: ResumeTaskInput): Promise<void> {
    const task = this.db.getTask(input.taskId);
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`);
    }
    const session = this.db.getCurrentSession(task.id);
    if (!session?.backendThreadId) {
      throw new AppError("session_unavailable", "session_unavailable");
    }
    const latestTurn = this.db.getLatestTurn(task.id);
    if (!this.canResumeTask(task, latestTurn)) {
      const now = new Date().toISOString();
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "reconcile_required",
        updatedAt: now,
      });
      throw new AppError("not_recoverable", "not_recoverable");
    }
    const turnPrompt = input.prompt ?? latestTurn?.promptRedacted;
    if (!turnPrompt) {
      throw new Error(`Task ${task.id} has no resumable prompt`);
    }
    await this.submitTurn({
      task,
      session,
      prompt: turnPrompt,
      mode: "recovery",
      requestId: input.requestId,
      markInterruptedOnFailure: false,
    });
  }

  async pauseTask(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (task.status !== "running") {
      throw new AppError("validation_failed", `Task ${task.id} is not running and cannot be paused`);
    }

    const session = this.db.getCurrentSession(task.id);
    if (!session) {
      throw new AppError("validation_failed", `Task ${task.id} has no active session to pause`);
    }
    const runtime = this.runtimes[session.runtime];
    if (!runtime) {
      throw new Error(`Runtime adapter not configured for ${session.runtime}`);
    }

    this.pauseRequests.add(task.id);
    await runtime.pauseTask(session.id);
    await this.markTaskPaused(task);
  }

  async cancelTask(taskId: string, reason?: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (task.status === "failed" || task.status === "closed") {
      throw new AppError("validation_failed", "task_terminal");
    }
    if (task.status === "cancelling") {
      throw new AppError("task_busy", "task_busy");
    }

    this.pauseRequests.delete(task.id);
    const now = new Date().toISOString();
    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "cancelling",
      updatedAt: now,
    });
    this.publishAndProjectTaskEvent(task, { kind: "task.cancellation_requested", taskId: task.id, ...(reason ? { reason } : {}) }, { ts: now });

    const activeSessions = this.db.listRuntimeSessionsByStatus(task.id, "active");
    await Promise.allSettled(activeSessions.map(async (session) => {
      const runtime = this.runtimes[session.runtime];
      if (runtime) {
        await runtime.cancelTask(session.id);
        await runtime.closeTask(session.id);
      }
      this.db.updateRuntimeSession({
        sessionId: session.id,
        status: "closed",
        closeReason: "cancelled",
        closedAt: now,
      });
      this.publishAndProjectTaskEvent(task, { kind: "session.closed", sessionId: session.id, reason: "cancelled" }, { ts: now });
    }));
    const latestTurn = this.db.getLatestTurn(task.id);
    if (latestTurn?.status === "running" || latestTurn?.status === "paused") {
      this.db.updateTurn({
        turnId: latestTurn.id,
        status: "cancelled",
        completedAt: now,
      });
    }
    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "interrupted",
      updatedAt: now,
    });
    const current = this.db.getTask(task.id) ?? task;
    this.publishAndProjectTaskEvent(current, { kind: "task.cancelled", taskId: task.id, ...(reason ? { reason } : {}) }, { ts: now });
  }

  async closeTask(taskId: string, summary?: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.status === "running" || task.status === "cancelling") {
      throw new AppError("validation_failed", "task_busy");
    }
    if (task.status === "closed") {
      return;
    }
    const now = new Date().toISOString();
    for (const session of this.db.listRuntimeSessionsByStatus(task.id, "active")) {
      const runtime = this.runtimes[session.runtime];
      if (runtime) {
        await runtime.closeTask(session.id);
      }
      this.db.updateRuntimeSession({
        sessionId: session.id,
        status: "closed",
        closeReason: "task_closed",
        closedAt: now,
      });
      this.publishAndProjectTaskEvent(task, { kind: "session.closed", sessionId: session.id, reason: "task_closed" }, { ts: now });
    }
    this.db.updateTaskRuntimeState({
      taskId: task.id,
      status: "closed",
      updatedAt: now,
      closedAt: now,
    });
    const current = this.db.getTask(task.id) ?? task;
    this.publishAndProjectTaskEvent(current, { kind: "task.closed", taskId: task.id, ...(summary ? { summary } : {}) }, { ts: now });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(Array.from(this.pendingContinuations));
    this.eventHub.close();
    this.db.close();
  }

  async replayAndSubscribe(input: {
    taskId: string;
    sinceTaskSeq?: number | undefined;
    listener: (event: EventEnvelope) => void;
  }): Promise<{ unsubscribe: () => void; lastTaskSeq: number }> {
    return this.eventHub.replayAndSubscribe(input);
  }

  listEvents(input: Parameters<EventHub["listEvents"]>[0]) {
    return this.eventHub.listEvents(input);
  }

  getRedactedRawEvent(rawRef: string) {
    return this.eventHub.getRedactedRawEvent(rawRef);
  }

  checkEventProjection(taskId: string) {
    return this.eventHub.checkProjection(taskId);
  }

  subscribeToTaskEvents(taskId: string, listener: (event: EventEnvelope) => void): () => void {
    return this.eventHub.subscribe({ taskId, listener });
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

  private requireParentWorkspace(workspace: Workspace): Workspace {
    if (!workspace.parentWorkspaceId) {
      throw new Error("workspace_not_mergeable:missing_parent");
    }
    return this.requireWorkspace(workspace.parentWorkspaceId);
  }

  private assertWorkspaceMergeable(workspace: Workspace, parentWorkspace: Workspace, allowFailedRetry = false): void {
    if (!workspace.parentWorkspaceId) {
      throw new Error("workspace_not_mergeable:top_level");
    }
    if (!workspace.baseRef) {
      throw new Error("workspace_not_mergeable:missing_base_ref");
    }
    const allowedStatuses: Workspace["status"][] = allowFailedRetry
      ? ["merge_requested", "merge_failed"]
      : ["active", "merge_failed"];
    if (!allowedStatuses.includes(workspace.status)) {
      throw new Error("workspace_not_mergeable:invalid_status");
    }
    if (!parentWorkspace.repoRoot || !workspace.repoRoot) {
      throw new Error("workspace_not_mergeable:not_git");
    }
  }

  private async recordWorkspaceMergeFailure(
    task: Task,
    workspace: Workspace,
    changes: WorkspaceMergeResult["changes"],
    parentAdvanced: boolean,
    error: WorkspaceMergeError,
  ): Promise<WorkspaceMergeResult> {
    const failedAt = new Date().toISOString();
    const storedError: WorkspaceMergeError = { ...error, changes };
    this.db.updateWorkspaceLifecycle({
      workspaceId: workspace.id,
      status: "merge_failed",
      mergeError: storedError,
    });
    this.publishTaskEvent(task, {
      kind: "workspace.merge_failed",
      workspaceId: workspace.id,
      error: toTaskError(storedError.message, {
        code: storedError.code,
        parentHead: storedError.parentHead,
        childHead: storedError.childHead,
        changes: storedError.changes,
      }),
    }, { ts: failedAt });
    return {
      taskId: task.id,
      workspaceId: workspace.id,
      status: "merge_failed",
      parentAdvanced,
      parentHead: error.parentHead,
      childHead: error.childHead,
      changes,
      error: storedError,
    };
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
      this.publishSystemNotice(input.requesterTask, {
        level: "info",
        code: "runtime_notice",
        message: "Reference expanded",
        details: {
          sourceTaskId: targetTask.id,
          requestedByTaskId: input.requesterTask.id,
        },
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
      model: task.model,
      ...(this.db.getLatestCompletedMessage(task.id) ? { latestMessage: this.db.getLatestCompletedMessage(task.id) } : {}),
      ...(this.db.getLatestTerminalError(task.id) ? { terminalError: this.db.getLatestTerminalError(task.id) } : {}),
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

  private async submitTurn(input: {
    task: Task;
    session: RuntimeSession;
    prompt: string;
    mode: "first_turn" | "next_turn" | "recovery" | "handoff" | "fork" | "rollover";
    requestId?: string | undefined;
    markInterruptedOnFailure: boolean;
    idleReason?: Extract<CanonicalEvent, { kind: "task.idle" }>["reason"] | undefined;
    activateSession?: boolean | undefined;
    projectTaskFailure?: boolean | undefined;
  }): Promise<void> {
    if (input.requestId && this.db.getTurnByRequestId(input.task.id, input.requestId)) {
      return;
    }
    if (this.activeTaskActions.has(input.task.id)) {
      throw new AppError("task_busy", "task_busy");
    }
    this.activeTaskActions.add(input.task.id);
    const profile = this.requireProfile(input.session.profileId);
    const runtime = this.runtimes[input.session.runtime];
    if (!runtime) {
      throw new Error(`Runtime adapter not configured for ${input.session.runtime}`);
    }

    const rateLimitCheck = await this.rateLimiter.checkLimit(profile.accountId);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    await this.scheduler.acquire(input.task.id, profile.accountId);
    this.rateLimiter.recordRequest(profile.accountId);

    const startedAt = new Date().toISOString();
    let handle;
    try {
      handle = input.session.backendThreadId
        ? await runtime.resumeTask({
            taskId: input.task.id,
            sessionId: input.session.id,
            profileId: input.session.profileId,
            model: input.session.model,
            cwd: input.session.cwd,
            backendThreadId: input.session.backendThreadId,
          })
        : await runtime.startTask({
            taskId: input.task.id,
            sessionId: input.session.id,
            profileId: input.session.profileId,
            model: input.session.model,
            cwd: input.session.cwd,
          });

      if (handle.backendThreadId) {
        this.db.updateRuntimeSession({
          sessionId: input.session.id,
          status: input.activateSession === false ? input.session.status : "active",
          backendThreadId: handle.backendThreadId,
        });
        input.session.backendThreadId = handle.backendThreadId;
      }

      this.db.updateTaskRuntimeState({
        taskId: input.task.id,
        status: "running",
        updatedAt: startedAt,
      });
      const runningTask = this.db.getTask(input.task.id) ?? input.task;
      this.publishTaskEvent(runningTask, {
        kind: "task.started",
        profileId: input.session.profileId,
        model: input.session.model,
        cwd: input.session.cwd,
      }, { ts: startedAt, sessionId: input.session.id });

      const turnId = await this.beginTurn(input.task.id, input.session.id, input.prompt, startedAt, input.requestId);
      await this.consumeTurn(input.task, input.session, runtime, {
        taskId: input.task.id,
        sessionId: input.session.id,
        turnId,
        profileId: input.session.profileId,
        model: input.session.model,
        cwd: input.session.cwd,
        prompt: input.prompt,
      }, turnId, input.idleReason, input.activateSession !== false);
    } catch (error) {
      if (this.pauseRequests.has(input.task.id)) {
        await this.markTaskPaused(input.task);
        return;
      }
      if (input.projectTaskFailure !== false) {
        await this.failTask(input.task.id, error, input.markInterruptedOnFailure);
      }
      throw error;
    } finally {
      this.scheduler.recordComplete(input.task.id);
      await runtime.closeTask(input.session.id);
      this.pauseRequests.delete(input.task.id);
      this.activeTaskActions.delete(input.task.id);
    }
  }

  private async beginTurn(taskId: string, sessionId: string, prompt: string, startedAt: string, requestId?: string | undefined): Promise<string> {
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
      sessionId,
      turnNumber: this.db.nextTurnNumber(taskId),
      ...(requestId ? { requestId } : {}),
      promptRedacted,
      status: "running",
      startedAt,
      ...(rawCipher ? { promptRawEncrypted: rawCipher.encrypted, promptRawTtlAt: rawCipher.ttlAt } : {}),
    });
    return turnId;
  }

  private async consumeTurn(
    task: Task,
    session: RuntimeSession,
    runtime: RuntimeAdapter,
    input: { taskId: string; sessionId: string; turnId: string; profileId: string; model: string; cwd: string; prompt: string },
    turnId: string,
    idleReason: Extract<CanonicalEvent, { kind: "task.idle" }>["reason"] = "turn_completed",
    activateSession = true,
  ): Promise<void> {
    const profile = this.requireProfile(session.profileId);
    const policy = this.requirePolicy(profile.policyId);

    for await (const output of runtime.runTurn(input)) {
      const events = "events" in output ? output.events : [output.event];
      for (const event of events) {
        const envelope = this.publishAndProjectTaskEvent(task, event, {
          turnId,
          raw: output.raw,
        });

        if (event.kind === "turn.completed") {
          this.db.updateTurn({
            turnId,
            status: "completed",
            usage: event.usage,
            completedAt: envelope.ts,
          });

          if (event.usage && policy) {
            const updatedTask = this.db.getTask(task.id);
            if (updatedTask) {
              this.rateLimiter.recordUsage(profile.accountId, usageToRateLimitTokens(event.usage));
              const newBudget = updateBudget(updatedTask.budget, event.usage);
              const budgetCheck = checkBudget(newBudget, policy);

              this.db.updateTaskBudget(task.id, newBudget);

              if (budgetCheck.warning) {
                this.publishAndProjectTaskEvent(task, {
                  kind: "budget.warning",
                  message: budgetCheck.warning,
                  budget: newBudget,
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
                this.publishAndProjectTaskEvent(task, {
                  kind: "budget.exceeded",
                  message: budgetCheck.reason ?? "Budget exceeded",
                  budget: newBudget,
                }, { ts: exceededAt });
                const approval = this.requireApproval(approvalId);
                this.publishAndProjectTaskEvent(task, {
                  kind: "approval.requested",
                  approval: toApprovalView(approval),
                }, { ts: exceededAt });
              }
            }
          }
        }

        if (event.kind === "task.interrupted" || event.kind === "task.failed" || event.kind === "turn.failed") {
          this.db.updateTurn({
            turnId,
            status: "failed",
            completedAt: envelope.ts,
          });
        }
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
    if (currentTask?.status === "paused") {
      return;
    }
    if (currentTask && !["awaiting_approval", "failed", "interrupted", "closed", "cancelling"].includes(currentTask.status)) {
      const latestSession = this.db.getRuntimeSession(session.id) ?? session;
      this.db.updateRuntimeSession({
        sessionId: session.id,
        status: activateSession ? "active" : latestSession.status,
        lastUsedAt: completedAt,
      });
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "idle",
        updatedAt: completedAt,
      });
      this.publishAndProjectTaskEvent(currentTask, { kind: "task.idle", reason: idleReason }, { ts: completedAt, sessionId: session.id });
    }
  }

  private async failTask(
    taskId: string,
    error: unknown,
    markInterrupted: boolean,
  ): Promise<void> {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const task = this.db.getTask(taskId);
    if (!task) {
      return;
    }
    this.publishAndProjectTaskEvent(task, markInterrupted
      ? { kind: "task.interrupted", error: toTaskError(message) }
      : { kind: "task.failed", error: toTaskError(message) }, { ts: failedAt });
  }

  private async markTaskPaused(task: Task): Promise<void> {
    const pausedAt = new Date().toISOString();
    const current = this.db.getTask(task.id);
    if (!current || current.status === "paused") {
      return;
    }

    const latestTurn = this.db.getLatestTurn(task.id);
    if (latestTurn?.status === "running") {
      this.db.updateTurn({
        turnId: latestTurn.id,
        status: "paused",
        completedAt: pausedAt,
      });
    }

    this.publishAndProjectTaskEvent(current, { kind: "task.paused" }, { ts: pausedAt });
  }

  private assertCanSendTurn(task: Task): void {
    if (task.status === "running" || task.status === "cancelling") {
      throw new AppError("task_busy", "task_busy");
    }
    if (task.status === "awaiting_approval") {
      throw new AppError("approval_required", "approval_required");
    }
    if (task.status === "closed" || task.status === "failed") {
      throw new AppError("task_terminal", "task_terminal");
    }
    if (task.status === "paused" || task.status === "interrupted" || task.status === "reconcile_required") {
      throw new AppError("not_recoverable", "not_recoverable");
    }
    if (!fs.existsSync(task.cwd)) {
      throw new AppError("workspace_unavailable", `workspace_unavailable:${task.cwd}`);
    }
  }

  private assertCanRunSaga(task: Task): void {
    if (task.status === "running" || task.status === "cancelling") {
      throw new AppError("task_busy", "task_busy");
    }
    if (task.status === "awaiting_approval") {
      throw new AppError("approval_required", "approval_required");
    }
    if (task.status === "closed" || task.status === "failed") {
      throw new AppError("task_terminal", "task_terminal");
    }
    if (!fs.existsSync(task.cwd)) {
      throw new AppError("workspace_unavailable", `workspace_unavailable:${task.cwd}`);
    }
    if (this.db.listPendingApprovals(task.id).length > 0) {
      throw new AppError("approval_required", "approval_required");
    }
  }

  private createInitialSession(task: Task, now: string): RuntimeSession {
    return this.createRuntimeSession({
      task,
      profileId: task.profileId,
      model: task.model,
      runtime: task.runtime,
      cwd: task.cwd,
      status: "active",
      now,
    });
  }

  private createRuntimeSession(input: {
    task: Task;
    profileId: string;
    model: string;
    runtime: Task["runtime"];
    cwd: string;
    status: RuntimeSession["status"];
    now: string;
    parentSessionId?: string | undefined;
    forkedFromTurnId?: string | undefined;
    handoffFromSessionId?: string | undefined;
    rolloverFromSessionId?: string | undefined;
  }): RuntimeSession {
    const session: RuntimeSession = {
      id: randomUUID(),
      taskId: input.task.id,
      runtime: input.runtime,
      profileId: input.profileId,
      model: input.model,
      cwd: input.cwd,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.forkedFromTurnId ? { forkedFromTurnId: input.forkedFromTurnId } : {}),
      ...(input.handoffFromSessionId ? { handoffFromSessionId: input.handoffFromSessionId } : {}),
      ...(input.rolloverFromSessionId ? { rolloverFromSessionId: input.rolloverFromSessionId } : {}),
      status: input.status,
      createdAt: input.now,
    };
    this.db.createRuntimeSession(session);
    this.publishAndProjectTaskEvent(input.task, {
      kind: "session.opened",
      sessionId: session.id,
      runtime: session.runtime,
      profileId: session.profileId,
      model: session.model,
    }, { ts: input.now, sessionId: session.id });
    return session;
  }

  private requireCurrentSession(taskId: string): RuntimeSession {
    const session = this.db.getCurrentSession(taskId);
    if (!session) {
      throw new AppError("session_unavailable", "session_unavailable");
    }
    return session;
  }

  private createContinuationContext(input: {
    kind: "handoff" | "fork" | "rollover";
    task: Task;
    sourceSession: RuntimeSession;
    sourceTurnId?: string | undefined;
    policyId: string;
    prompt?: string | undefined;
    handoffReason?: string | undefined;
    rolloverReason?: string | undefined;
  }) {
    const workspace = this.requireWorkspace(input.task.workspaceId);
    const changes = workspace.baseRef ? this.workspaceManager.listChanges(workspace) : [];
    return buildContinuationContext({
      kind: input.kind,
      task: {
        id: input.task.id,
        name: input.task.name,
        objective: input.task.name ?? this.db.getLatestTurn(input.task.id)?.promptRedacted ?? input.prompt ?? input.task.id,
      },
      source: {
        runtime: input.sourceSession.runtime,
        profileId: input.sourceSession.profileId,
        sessionId: input.sourceSession.id,
        turnId: input.sourceTurnId,
      },
      policyId: input.policyId,
      budgetRemaining: input.task.budget,
      pendingApprovalIds: this.db.listPendingApprovals(input.task.id).map((approval) => approval.id),
      cwd: input.task.cwd,
      latestMessage: this.db.getLatestCompletedMessage(input.task.id),
      terminalError: this.db.getLatestTerminalError(input.task.id),
      workspaceChanges: changes,
      handoffReason: input.handoffReason,
      rolloverReason: input.rolloverReason,
      userPrompt: input.prompt,
    });
  }

  private async closeRuntimeSessionHandle(session: RuntimeSession): Promise<void> {
    const runtime = this.runtimes[session.runtime];
    if (runtime) {
      await runtime.closeTask(session.id);
    }
  }

  private createForkChildTask(sourceTask: Task, name: string | undefined, now: string): Task {
    const childTaskId = randomUUID();
    const profile = this.requireProfile(sourceTask.profileId);
    const policy = this.requirePolicy(profile.policyId);
    const parentWorkspace = this.requireWorkspace(sourceTask.workspaceId);
    const inspectedParentWorkspace = {
      ...parentWorkspace,
      ...this.workspaceManager.inspectWorkspace(parentWorkspace),
    };
    const childWorkspacePlan = this.workspaceManager.resolveWorkspacePlan({
      taskKind: "child",
      cwd: sourceTask.cwd,
      parentWorkspace: inspectedParentWorkspace,
      requestedWorkspaceMode: "share",
    });
    const workspace = this.workspaceManager.createChildWorkspace({
      taskId: childTaskId,
      cwd: sourceTask.cwd,
      parentWorkspace: inspectedParentWorkspace,
      plan: childWorkspacePlan,
      createdAt: now,
    });
    const childTask: Task = {
      id: childTaskId,
      name: name ?? `${sourceTask.name ?? sourceTask.id}:fork`,
      profileId: sourceTask.profileId,
      runtime: sourceTask.runtime,
      model: sourceTask.model,
      cwd: workspace.path,
      workspaceId: workspace.id,
      parentTaskId: sourceTask.id,
      delegationDepth: nextDelegationDepth(sourceTask.delegationDepth),
      delegationChain: buildDelegationChain(sourceTask.delegationChain, sourceTask.id),
      status: "idle",
      budget: toBudgetSnapshot(policy),
      triggeredBy: `delegate:${sourceTask.id}`,
      createdAt: now,
      updatedAt: now,
    };
    this.db.createTaskRecord({ task: childTask, workspace });
    this.publishTaskEvent(childTask, { kind: "task.queued" }, { ts: now });
    this.db.updateTaskRuntimeState({ taskId: childTask.id, status: "idle", updatedAt: now });
    this.publishAndProjectTaskEvent(childTask, { kind: "task.idle", reason: "recovered" }, { ts: now });
    return childTask;
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
    const session = this.db.getCurrentSession(task.id);
    if (!session?.backendThreadId) {
      return false;
    }
    const resumableStatuses: Task["status"][] = ["paused", "interrupted", "reconcile_required", "awaiting_approval"];
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
      return latestTurn?.status === "failed" || latestTurn?.status === "completed" || latestTurn?.status === "cancelled";
    }
    if (task.status === "paused") {
      return latestTurn?.status === "paused" || latestTurn?.status === "failed" || latestTurn?.status === "cancelled";
    }
    if (latestTurn?.status === "running") {
      return false;
    }
    return true;
  }

  private publishTaskEvent(task: Task, event: CanonicalEvent, options: PublishTaskEventOptions = {}): EventEnvelope {
    return this.eventHub.publish({
      runtime: task.runtime,
      taskId: task.id,
      sessionId: options.sessionId ?? this.sessionIdForTask(task),
      turnId: options.turnId,
      ts: options.ts,
      raw: options.raw,
      event,
    });
  }

  private publishAndProjectTaskEvent(task: Task, event: CanonicalEvent, options: PublishTaskEventOptions = {}): EventEnvelope {
    const envelope = this.publishTaskEvent(task, event, options);
    this.projectEvent(task, envelope);
    return envelope;
  }

  private publishSystemNotice(task: Task, payload: ItemPayload["system_notice"]): EventEnvelope {
    const ts = new Date().toISOString();
    return this.publishTaskEvent(task, {
      kind: "item.started",
      item: {
        id: `system:${randomUUID()}`,
        taskId: task.id,
        sessionId: this.sessionIdForTask(task),
        kind: "system_notice",
        status: "completed",
        startedAt: ts,
        updatedAt: ts,
        completedAt: ts,
        payload,
      },
    }, { ts });
  }

  private projectEvent(task: Task, envelope: EventEnvelope): void {
    const event = envelope.event;
    if (event.kind === "item.completed" && event.itemKind === "file_change") {
      for (const change of event.finalPayload.changes) {
        if (change.changeKind === "rename") {
          continue;
        }
        this.db.insertFileChange({
          taskId: task.id,
          workspaceId: task.workspaceId,
          path: change.path,
          changeKind: change.changeKind,
          ts: envelope.ts,
        });
      }
      return;
    }

    if (event.kind === "session.backend_thread") {
      this.db.updateRuntimeSession({
        sessionId: event.sessionId,
        backendThreadId: event.backendThreadId,
        status: this.db.getRuntimeSession(event.sessionId)?.status === "opening" ? "opening" : "active",
        lastUsedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "task.interrupted") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "interrupted",
        updatedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "task.paused") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "paused",
        updatedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "task.failed") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "failed",
        updatedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "task.cancelled") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "interrupted",
        updatedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "task.idle") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "idle",
        updatedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "task.closed") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "closed",
        updatedAt: envelope.ts,
        closedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "session.closed") {
      this.db.updateRuntimeSession({
        sessionId: event.sessionId,
        status: "closed",
        closeReason: event.reason,
        closedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "session.failed") {
      this.db.updateRuntimeSession({
        sessionId: event.sessionId,
        status: "failed",
        closeReason: "failed",
        closedAt: envelope.ts,
      });
      return;
    }

    if (event.kind === "approval.requested") {
      this.db.updateTaskRuntimeState({
        taskId: task.id,
        status: "awaiting_approval",
        updatedAt: envelope.ts,
      });
    }
  }

  private requireApproval(approvalId: string): StoredApproval {
    const approval = this.db.listApprovals().find((entry) => entry.id === approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    return approval;
  }

  private sessionIdForTask(task: Task): string {
    return this.db.getCurrentSession(task.id)?.id ?? task.id;
  }

}

interface PublishTaskEventOptions {
  sessionId?: string | undefined;
  turnId?: string | undefined;
  ts?: string | undefined;
  raw?: unknown;
}

function resolveTaskModel(profile: { id: string; model: string; allowedModels?: string[] | undefined }, requestedModel?: string | undefined): string {
  const model = (requestedModel ?? profile.model).trim();
  if (!model) {
    throw new AppError("validation_failed", `Model is required for profile ${profile.id}`);
  }
  if (profile.allowedModels && profile.allowedModels.length > 0 && !profile.allowedModels.includes(model)) {
    throw new AppError("validation_failed", `Model ${model} is not allowed for profile ${profile.id}`, {
      profileId: profile.id,
      model,
      allowedModels: profile.allowedModels,
    });
  }
  return model;
}

function terminalEventToTaskStatus(type: "task.idle" | "task.failed" | "task.interrupted" | "task.cancelled" | "task.closed"): Task["status"] {
  switch (type) {
    case "task.idle":
      return "idle";
    case "task.failed":
      return "failed";
    case "task.interrupted":
      return "interrupted";
    case "task.cancelled":
      return "interrupted";
    case "task.closed":
      return "closed";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toTaskError(message: string, details?: unknown): TaskError {
  return {
    code: "internal",
    message,
    retriable: false,
    ...(details === undefined ? {} : { details }),
  };
}

function toApprovalView(approval: StoredApproval): ApprovalView {
  return {
    id: approval.id,
    taskId: approval.taskId,
    ...(approval.parentTaskId ? { parentTaskId: approval.parentTaskId } : {}),
    kind: approval.kind,
    payload: toApprovalPayload(approval.kind, approval.payload),
    status: approval.status,
    requestedAt: approval.requestedAt,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {}),
    ...(approval.resolutionReason ? { resolutionReason: approval.resolutionReason } : {}),
    ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
  };
}

function toApprovalPayload(kind: ApprovalKind, payload: Record<string, unknown>): ApprovalPayload {
  switch (kind) {
    case "shell":
      return {
        kind: "shell",
        command: stringField(payload.command) ?? stringField(payload.toolName) ?? "unknown",
        cwd: stringField(payload.cwd) ?? "",
        ...(stringField(payload.risk) ? { risk: stringField(payload.risk) } : {}),
      };
    case "file_edit":
    case "workspace_write":
      return {
        kind: "file_edit",
        path: stringField(payload.path) ?? "",
        action: actionField(payload.action),
        ...(stringField(payload.preview) ? { preview: stringField(payload.preview) } : {}),
      };
    case "network":
      return {
        kind: "network",
        ...(stringField(payload.host) ? { host: stringField(payload.host) } : {}),
        ...(stringField(payload.url) ? { url: stringField(payload.url) } : {}),
        ...(stringField(payload.reason) ? { reason: stringField(payload.reason) } : {}),
      };
    case "workspace_merge":
      return {
        kind: "workspace_merge",
        workspaceId: stringField(payload.workspaceId) ?? "",
        changes: Array.isArray(payload.changes) ? payload.changes as WorkspaceDiff["changes"] : [],
      };
    case "cross_harness_delegation":
      return {
        kind: "cross_harness_delegation",
        request: payload,
      };
    case "clarification":
      return {
        kind: "clarification",
        question: stringField(payload.question) ?? stringField(payload.reason) ?? "",
        ...(Array.isArray(payload.choices) ? { choices: payload.choices.filter((item): item is string => typeof item === "string") } : {}),
      };
    case "profile_switch":
    case "budget_increase":
    case "sandbox_escape":
      return {
        kind: "generic",
        ...(stringField(payload.reason) ? { reason: stringField(payload.reason) } : {}),
        data: payload,
      };
  }
}

function actionField(value: unknown): "create" | "modify" | "delete" {
  return value === "create" || value === "delete" ? value : "modify";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function delegationItemId(childTaskId: string): string {
  return `delegation:${childTaskId}`;
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

function deniedDelegation(denialCode: string, message = denialCode): DelegateToResult {
  return {
    status: "denied",
    denialCode,
    message,
  };
}

function toArtifactRefs(artifacts: StoredArtifact[]): ArtifactRef[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    ref: artifact.ref,
    ...(artifact.description ? { description: artifact.description } : {}),
  }));
}
