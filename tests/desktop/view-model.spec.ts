import { describe, expect, it } from "vitest";
import {
  artifactLabel,
  approvedMergeApprovalId,
  buildTaskTree,
  canApplyMerge,
  canDiscardWorkspace,
  canRequestMerge,
  childTasksForTask,
  diffStats,
  filterTasks,
  pendingApprovalsForTask,
  runtimeSummary,
  taskBudgetSummary,
  taskCanCancel,
  taskCanPause,
  taskCanResume,
  taskCanRun,
  taskResultSummary,
} from "../../src/desktop/renderer/src/view-model.js";
import type { ApprovalView, ArtifactView, RuntimeHealth, TaskDetail, TaskResultView, TaskSummary, WorkspaceDiffView } from "../../src/api/types.js";
import type { ApprovalKind } from "../../src/core/types.js";

describe("desktop workbench view model", () => {
  it("filters tasks by operational bucket", () => {
    const tasks = [
      task("a", "queued"),
      task("b", "running"),
      task("c", "awaiting_approval"),
      task("d", "failed"),
      task("e", "completed"),
    ];

    expect(filterTasks(tasks, "active").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(filterTasks(tasks, "approval").map((entry) => entry.id)).toEqual(["c"]);
    expect(filterTasks(tasks, "failed").map((entry) => entry.id)).toEqual(["d"]);
    expect(filterTasks(tasks, "all")).toHaveLength(5);
  });

  it("calculates task actions and pending approvals", () => {
    expect(taskCanRun(task("a", "queued"))).toBe(true);
    expect(taskCanRun(task("b", "running"))).toBe(false);
    expect(taskCanPause(task("b", "running"))).toBe(true);
    expect(taskCanResume(task("p", "paused"))).toBe(true);
    expect(taskCanCancel(task("b", "running"))).toBe(true);
    expect(taskCanCancel(task("c", "completed"))).toBe(false);

    const approvals = [
      approval("a1", "task-1", "pending"),
      approval("a2", "task-1", "approved"),
      approval("a3", "task-2", "pending"),
    ];
    expect(pendingApprovalsForTask(approvals, "task-1").map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("builds task tree and child task lists", () => {
    const tasks = [
      task("parent", "running"),
      task("child-a", "queued", "parent"),
      task("child-b", "completed", "parent"),
      task("grandchild", "failed", "child-a"),
    ];

    const tree = buildTaskTree(tasks);
    expect(tree.map((node) => node.task.id)).toEqual(["parent"]);
    expect(tree[0]?.children.map((node) => node.task.id)).toEqual(["child-a", "child-b"]);
    expect(tree[0]?.children[0]?.children.map((node) => node.task.id)).toEqual(["grandchild"]);
    expect(childTasksForTask(tasks, "parent").map((entry) => entry.id)).toEqual(["child-a", "child-b"]);
  });

  it("calculates workspace merge actions", () => {
    const detail = detailTask("task-1", "active");
    const diff: WorkspaceDiffView = {
      taskId: "task-1",
      workspaceId: "ws",
      baseRef: "base",
      changes: [{ path: "a.txt", changeKind: "modify", binary: false }],
      patch: "diff",
      truncated: false,
    };
    const approvals = [approval("merge-1", "task-1", "approved", "workspace_merge")];

    expect(canRequestMerge(detail, diff)).toBe(true);
    expect(canApplyMerge({ ...detail, workspace: { ...detail.workspace!, status: "merge_requested" } }, approvals)).toBe(true);
    expect(approvedMergeApprovalId(detail, approvals)).toBe("merge-1");
    expect(canDiscardWorkspace(detail)).toBe(true);
    expect(canDiscardWorkspace({ ...detail, workspace: { ...detail.workspace!, status: "merged" } })).toBe(false);
    expect(diffStats(diff)).toEqual({ total: 1, binary: 0, text: 1, truncated: false });
  });

  it("summarizes budget, artifacts, and task results", () => {
    const detail = detailTask("task-1", "active");
    detail.budget = {
      maxTokens: 10,
      maxCostUsd: 0.05,
      inputTokens: 6,
      outputTokens: 4,
      estimatedCostUsd: 0.06,
    };
    const artifact: ArtifactView = {
      id: "artifact-1",
      taskId: detail.id,
      kind: "file",
      ref: "result.txt",
      description: "Result file",
      ts: new Date().toISOString(),
    };
    const result: TaskResultView = {
      taskId: detail.id,
      parentTaskId: "parent",
      status: "awaiting_approval",
      runtime: "claude",
      profileId: "profile",
      latestMessage: "done",
      artifacts: [artifact],
      pendingApprovalIds: ["approval-1"],
    };

    expect(taskBudgetSummary(detail)).toEqual({
      tokens: "10/10",
      cost: "$0.0600/$0.0500",
      warnings: ["token budget reached", "cost budget reached"],
    });
    expect(artifactLabel(artifact)).toBe("Result file");
    expect(taskResultSummary(result)).toBe("awaiting_approval with 1 pending approval(s)");
  });

  it("summarizes runtime diagnostics", () => {
    const health: RuntimeHealth[] = [
      {
        runtime: "claude",
        available: true,
        profiles: ["p"],
        staticChecks: [{ id: "a", label: "A", status: "ok" }],
        capabilityChecks: [{ id: "b", label: "B", status: "warning" }],
      },
      {
        runtime: "codex",
        available: false,
        profiles: [],
        staticChecks: [{ id: "c", label: "C", status: "error" }],
        capabilityChecks: [],
      },
    ];

    expect(runtimeSummary(health)).toEqual({ available: 1, totalErrors: 1, totalWarnings: 1 });
  });
});

function task(id: string, status: string, parentTaskId?: string): TaskSummary {
  return {
    id,
    name: null,
    profileId: "profile",
    runtime: "claude",
    status,
    cwd: "cwd",
    ...(parentTaskId ? { parentTaskId } : {}),
    delegationDepth: parentTaskId ? 1 : 0,
    triggeredBy: parentTaskId ? `delegate:${parentTaskId}` : "user",
    createdAt: new Date().toISOString(),
  };
}

function detailTask(id: string, workspaceStatus: NonNullable<TaskDetail["workspace"]>["status"]): TaskDetail {
  return {
    id,
    profileId: "profile",
    runtime: "claude",
    cwd: "cwd",
    workspaceId: "ws",
    delegationDepth: 0,
    delegationChain: [],
    status: "queued",
    budget: {},
    triggeredBy: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
    artifacts: [],
    workspace: {
      id: "ws",
      path: "cwd",
      parentWorkspaceId: "parent",
      status: workspaceStatus,
      unsafeDirectCwd: false,
      createdAt: new Date().toISOString(),
    },
  };
}

function approval(id: string, taskId: string, status: ApprovalView["status"], kind: ApprovalKind = "shell"): ApprovalView {
  return {
    id,
    taskId,
    kind,
    payload: {},
    status,
    requestedAt: new Date().toISOString(),
    category: kind === "workspace_merge" ? "capability_request" : "tool_approval",
  };
}
