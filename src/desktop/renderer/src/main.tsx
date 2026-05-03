import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ApprovalView,
  ConfigMetadata,
  EventEnvelope,
  RuntimeHealth,
  TaskDetail,
  TaskResultView,
  TaskSummary,
  WorkspaceDiffView,
} from "../../../api/types.js";
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
  formatCaughtError,
  defaultModelForProfile,
  modelOptionsForProfile,
  pendingApprovalsForTask,
  runtimeSummary,
  taskDetailResult,
  taskBudgetSummary,
  taskCanCancel,
  taskCanPause,
  taskCanResume,
  taskCanRun,
  taskResultSummary,
  type TaskTreeNode,
  type TaskFilter,
  type DisplayError,
} from "./view-model.js";
import "./styles.css";

function App() {
  const [config, setConfig] = useState<ConfigMetadata | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiffView | null>(null);
  const [taskResult, setTaskResult] = useState<TaskResultView | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [prompt, setPrompt] = useState("");
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskProfile, setNewTaskProfile] = useState("");
  const [newTaskModel, setNewTaskModel] = useState("");
  const [newTaskCwd, setNewTaskCwd] = useState("");
  const [mergeReason, setMergeReason] = useState("Ready to merge");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void refresh();
    void window.autoPm.replayAndSubscribeToEvents({}, (event) => {
      setEvents((current) => [event, ...current].slice(0, 120));
      void refresh(selectedTaskId);
    }).then((subscription) => {
      unsubscribe = subscription.unsubscribe;
    }).catch(setCaughtError);
    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setTaskDetail(null);
      setWorkspaceDiff(null);
      setTaskResult(null);
      return;
    }
    void loadTaskDetail(selectedTaskId);
  }, [selectedTaskId]);

  async function refresh(preferredTaskId = selectedTaskId) {
    try {
      const [metadata, taskList, approvalList, health] = await Promise.all([
        window.autoPm.getConfig(),
        window.autoPm.listTasks(),
        window.autoPm.listApprovals(),
        window.autoPm.getRuntimeHealth(),
      ]);
      setConfig(metadata);
      setTasks(taskList);
      setApprovals(approvalList);
      setRuntimeHealth(health);
      setNewTaskProfile((current) => current || metadata.profileIds[0] || "");
      setNewTaskModel((current) => current || metadata.profiles.find((profile) => profile.id === (newTaskProfile || metadata.profileIds[0]))?.model || "");
      setNewTaskCwd((current) => current || metadata.workspace.rootDir);
      const nextSelected = preferredTaskId && taskList.some((task) => task.id === preferredTaskId)
        ? preferredTaskId
        : taskList[0]?.id ?? null;
      setSelectedTaskId(nextSelected);
      if (nextSelected) {
        await loadTaskDetail(nextSelected);
      }
      setError(null);
    } catch (caught) {
      setCaughtError(caught);
    }
  }

  async function loadTaskDetail(taskId: string) {
    try {
      const detail = await window.autoPm.getTask(taskId);
      setTaskDetail(detail);
      const ownResult = taskDetailResult(detail);
      if (detail.parentTaskId) {
        try {
          setTaskResult(await window.autoPm.getTaskResult({ requesterTaskId: detail.parentTaskId, taskId }));
        } catch {
          setTaskResult(ownResult);
        }
      } else {
        setTaskResult(ownResult);
      }
      if (detail.workspace?.parentWorkspaceId) {
        try {
          setWorkspaceDiff(await window.autoPm.getWorkspaceDiff(taskId));
        } catch {
          setWorkspaceDiff(null);
        }
      } else {
        setWorkspaceDiff(null);
      }
    } catch (caught) {
      setCaughtError(caught);
    }
  }

  const visibleTasks = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const taskTree = useMemo(() => buildTaskTree(visibleTasks), [visibleTasks]);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );
  const selectedApprovals = pendingApprovalsForTask(approvals, selectedTaskId);
  const selectedChildren = childTasksForTask(tasks, selectedTaskId);
  const approvedMergeId = approvedMergeApprovalId(taskDetail, approvals);
  const healthSummary = runtimeSummary(runtimeHealth);
  const budgetSummary = taskBudgetSummary(taskDetail);
  const filteredEvents = events.filter((event) => !selectedTaskId || event.event.taskId === selectedTaskId);
  const selectedNewTaskProfile = config?.profiles.find((profile) => profile.id === newTaskProfile) ?? null;
  const selectedNewTaskModelOptions = modelOptionsForProfile(selectedNewTaskProfile);
  const latestTurnId = taskDetail?.turns[taskDetail.turns.length - 1]?.id;
  const focusedProfile = taskDetail
    ? config?.profiles.find((profile) => profile.id === taskDetail.profileId) ?? null
    : selectedTask
      ? config?.profiles.find((profile) => profile.id === selectedTask.profileId) ?? null
      : null;

  return (
    <div className="app">
      <header className="brandBar">
        <div className="brandLeft">
          <span className="brandMark" />
          <span className="brandName">Auto-PM</span>
          <span className="brandSuffix">Lite</span>
        </div>
        <div className="brandRight">
          <span className={`runtimeIndicator ${healthSummary.available > 0 ? "live" : ""}`}>
            <span className="indicatorDot" />
            {healthSummary.available}/{runtimeHealth.length}
          </span>
          <span className="apiBadge">v{config?.apiVersion ?? "-"}</span>
        </div>
      </header>

      <main className="shell">
        <aside className="sidebar">
          <div className="paneHeader">
            <span>Tasks</span>
            <div className="headerActions">
              <span className="countBadge">{visibleTasks.length}</span>
              <button type="button" onClick={() => void refresh()} title="Refresh" data-testid="refresh">Refresh</button>
            </div>
          </div>
          <div className="filters" role="tablist" aria-label="Task filters">
            {(["all", "active", "approval", "failed"] as const).map((item) => (
              <button key={item} type="button" className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="taskList">
            {taskTree.map((node) => (
              <TaskTreeItem
                key={node.task.id}
                node={node}
                selectedTaskId={selectedTask?.id ?? null}
                onSelect={setSelectedTaskId}
              />
            ))}
            {visibleTasks.length === 0 ? <div className="empty">No tasks</div> : null}
          </div>
          <form className="createTask" onSubmit={(event) => {
            event.preventDefault();
            void createTask();
          }}>
            <div className="createTaskHeader">New Task</div>
            <label>
              Profile
              <select value={newTaskProfile} onChange={(event) => {
                const profileId = event.target.value;
                const profile = config?.profiles.find((entry) => entry.id === profileId) ?? null;
                setNewTaskProfile(profileId);
                setNewTaskModel(defaultModelForProfile(profile));
              }} data-testid="new-task-profile">
                {config?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}
              </select>
            </label>
            {selectedNewTaskProfile ? <ProfilePermissionSummary profile={selectedNewTaskProfile} /> : null}
            <label>
              Model
              {selectedNewTaskModelOptions.length > 0 ? (
                <select value={newTaskModel} onChange={(event) => setNewTaskModel(event.target.value)} data-testid="new-task-model">
                  {selectedNewTaskModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              ) : (
                <input value={newTaskModel} onChange={(event) => setNewTaskModel(event.target.value)} data-testid="new-task-model" />
              )}
            </label>
            <label>
              Cwd
              <input value={newTaskCwd} onChange={(event) => setNewTaskCwd(event.target.value)} data-testid="new-task-cwd" />
            </label>
            <label>
              Name
              <input value={newTaskName} onChange={(event) => setNewTaskName(event.target.value)} placeholder="optional" data-testid="new-task-name" />
            </label>
            <button type="submit" disabled={!newTaskProfile || !newTaskModel || !newTaskCwd || Boolean(busy)} data-testid="create-task">Create Task</button>
          </form>
        </aside>

        <section className="center">
          <div className="topbar">
            <div className="topbarInfo">
              <div className="topbarTitle">
                <h1>{taskDetail?.name ?? selectedTask?.name ?? selectedTask?.id ?? "Auto-PM Lite"}</h1>
                {selectedTask ? (
                  <span className={`statusBadge ${selectedTask.status}`}>
                    {selectedTask.status.replace(/_/g, " ")}
                  </span>
                ) : null}
              </div>
              <p>{taskDetail ? `${taskDetail.profileId} · ${taskDetail.model} · ${profilePermissionText(focusedProfile)} · ${taskDetail.cwd}` : config?.workspace.rootDir}</p>
            </div>
          </div>

          {error ? <ErrorPanel error={error} /> : null}
          {taskDetail?.status === "reconcile_required" ? (
            <div className="warningLine">This task needs reconciliation after restart or interruption.</div>
          ) : null}

          <div className="taskActions">
            <div className="actionRow">
              <button type="button" disabled={!taskCanRun(taskDetail ?? selectedTask) || !prompt || Boolean(busy)} onClick={() => void runFocusedTask()} data-testid="run-task">
                Run
              </button>
              <button type="button" disabled={!taskCanPause(taskDetail ?? selectedTask) || Boolean(busy)} onClick={() => void pauseFocusedTask()} data-testid="pause-task">
                Pause
              </button>
              <button type="button" disabled={!taskCanResume(taskDetail ?? selectedTask) || Boolean(busy)} onClick={() => void resumeFocusedTask()} data-testid="resume-task">
                Resume
              </button>
              <button type="button" disabled={!taskCanCancel(taskDetail ?? selectedTask) || Boolean(busy)} onClick={() => void cancelFocusedTask()} data-testid="cancel-task">
                Cancel
              </button>
            </div>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Send a prompt to the focused task..." data-testid="run-prompt" />
          </div>

          {taskResult ? (
            <div className="resultStrip">
              <strong>Result</strong>
              <span>{taskResultSummary(taskResult)}</span>
            </div>
          ) : null}

          <div className="transcript">
            <div className="paneHeader">
              <span>Turns</span>
              {taskDetail ? <span className="countBadge">{taskDetail.turns.length}</span> : null}
            </div>
            <div className="turnList">
              {taskDetail?.turns.map((turn) => (
                <div className="turnRow" key={turn.id}>
                  <div>
                    <strong>{turn.status}</strong>
                    <time>{new Date(turn.startedAt).toLocaleString()}</time>
                  </div>
                  <p>{turn.promptRedacted}</p>
                  {taskDetail?.latestMessage && turn.id === latestTurnId ? <pre>{taskDetail.latestMessage}</pre> : null}
                </div>
              ))}
              {taskDetail && taskDetail.turns.length === 0 ? <div className="empty">No turns</div> : null}
            </div>
            <div className="paneHeader">
              <span>Events</span>
              <span className="countBadge">{filteredEvents.length}</span>
            </div>
            <div className="eventList">
              {filteredEvents.map((event, index) => (
                <div className="eventRow" key={`${event.event.ts}-${index}`}>
                  <span>{event.event.type}</span>
                  <code>{event.event.taskId.slice(0, 8)}</code>
                  <time>{new Date(event.event.ts).toLocaleTimeString()}</time>
                  <small>{eventSummary(event.event)}</small>
                </div>
              ))}
              {events.length === 0 ? <div className="empty">No live events</div> : null}
            </div>
          </div>
        </section>

        <aside className="inspector">
          <div className="paneHeader">
            <span>Approvals</span>
            {selectedApprovals.length > 0 ? <span className="countBadge attention">{selectedApprovals.length}</span> : null}
          </div>
          <div className="approvalList">
            {selectedApprovals.map((approval) => (
              <div className="approvalRow" key={approval.id}>
                <div>
                  <strong>{approval.kind}</strong>
                  <p>{approval.status} · {approval.category}</p>
                  <code>{JSON.stringify(approval.payload)}</code>
                </div>
                <div className="approvalActions">
                  <button type="button" className="btnApprove" disabled={Boolean(busy)} onClick={() => void resolveApproval(approval.id, true)} data-testid="approval-approve">Approve</button>
                  <button type="button" className="btnDeny" disabled={Boolean(busy)} onClick={() => void resolveApproval(approval.id, false)} data-testid="approval-deny">Deny</button>
                </div>
              </div>
            ))}
            {selectedApprovals.length === 0 ? <div className="empty">No pending approvals</div> : null}
          </div>

          <div className="paneHeader">
            <span>Workspace</span>
          </div>
          <WorkspacePanel
            task={taskDetail}
            diff={workspaceDiff}
            approvals={approvals}
            mergeReason={mergeReason}
            setMergeReason={setMergeReason}
            busy={Boolean(busy)}
            diffOpen={diffOpen}
            setDiffOpen={setDiffOpen}
            onRequestMerge={requestMerge}
            onApplyMerge={() => approvedMergeId ? applyMerge(approvedMergeId) : Promise.resolve()}
            onDiscard={discardWorkspace}
          />

          <div className="paneHeader">
            <span>Budget</span>
          </div>
          <div className="budgetPanel">
            <dl className="metaGrid">
              <dt>Tokens</dt>
              <dd>{budgetSummary.tokens}</dd>
              <dt>Cost</dt>
              <dd>{budgetSummary.cost}</dd>
            </dl>
            {budgetSummary.warnings.map((warning) => <div className="warningLine" key={warning}>{warning}</div>)}
          </div>

          <div className="paneHeader">
            <span>Artifacts</span>
            {taskDetail && taskDetail.artifacts.length > 0 ? <span className="countBadge">{taskDetail.artifacts.length}</span> : null}
          </div>
          <div className="artifactList">
            {taskDetail?.artifacts.map((artifact) => (
              <div className="artifactRow" key={artifact.id}>
                <strong>{artifact.kind}</strong>
                <code>{artifactLabel(artifact)}</code>
                <time>{new Date(artifact.ts).toLocaleString()}</time>
              </div>
            ))}
            {taskDetail && taskDetail.artifacts.length === 0 ? <div className="empty">No artifacts</div> : null}
          </div>

          <div className="paneHeader">
            <span>Children</span>
            {selectedChildren.length > 0 ? <span className="countBadge">{selectedChildren.length}</span> : null}
          </div>
          <div className="childList">
            {selectedChildren.map((child) => (
              <button type="button" className="childRow" key={child.id} onClick={() => setSelectedTaskId(child.id)}>
                <span className={`statusDot ${child.status}`} />
                <span>{child.name ?? child.id.slice(0, 8)}</span>
                <small>{child.runtime}</small>
              </button>
            ))}
            {selectedChildren.length === 0 ? <div className="empty">No child tasks</div> : null}
          </div>

          <div className="paneHeader">
            <span>Runtime</span>
            <div className="headerActions">
              <button type="button" onClick={() => void probeRuntime()}>Probe</button>
              <button type="button" onClick={() => void window.autoPm.openLogsDirectory().catch(setCaughtError)}>Logs</button>
            </div>
          </div>
          <div className="runtimeSummary">
            <span>{healthSummary.available}/{runtimeHealth.length} available</span>
            <span>{healthSummary.totalErrors} errors</span>
            <span>{healthSummary.totalWarnings} warnings</span>
          </div>
          <RuntimePanel health={runtimeHealth} />
        </aside>
      </main>
    </div>
  );

  async function createTask() {
    await perform("create", async () => {
      const created = await window.autoPm.createTask({
        profileId: newTaskProfile,
        cwd: newTaskCwd,
        model: newTaskModel.trim(),
        ...(newTaskName ? { name: newTaskName } : {}),
      });
      setNewTaskName("");
      setSelectedTaskId(created.id);
      await refresh(created.id);
    });
  }

  async function runFocusedTask() {
    if (!selectedTaskId) {
      return;
    }
    await perform("run", async () => {
      await window.autoPm.runTask({ taskId: selectedTaskId, prompt });
      setPrompt("");
      setError(null);
      await refresh(selectedTaskId);
    });
  }

  async function resumeFocusedTask() {
    if (!selectedTaskId) {
      return;
    }
    await perform("resume", async () => {
      await window.autoPm.resumeTask({ taskId: selectedTaskId, ...(prompt ? { prompt } : {}) });
      setPrompt("");
      setError(null);
      await refresh(selectedTaskId);
    });
  }

  async function pauseFocusedTask() {
    if (!selectedTaskId) {
      return;
    }
    await perform("pause", async () => {
      await window.autoPm.pauseTask(selectedTaskId);
      await refresh(selectedTaskId);
    });
  }

  async function cancelFocusedTask() {
    if (!selectedTaskId) {
      return;
    }
    await perform("cancel", async () => {
      await window.autoPm.cancelTask(selectedTaskId);
      await refresh(selectedTaskId);
    });
  }

  async function resolveApproval(approvalId: string, approved: boolean) {
    await perform("approval", async () => {
      await window.autoPm.resolveApproval({ approvalId, approved });
      await refresh(selectedTaskId);
    });
  }

  async function requestMerge() {
    if (!selectedTaskId) {
      return;
    }
    await perform("merge-request", async () => {
      await window.autoPm.requestWorkspaceMerge({ taskId: selectedTaskId, reason: mergeReason });
      await refresh(selectedTaskId);
    });
  }

  async function applyMerge(approvalId: string) {
    if (!selectedTaskId) {
      return;
    }
    await perform("merge-apply", async () => {
      await window.autoPm.applyWorkspaceMerge({ taskId: selectedTaskId, approvalId });
      await refresh(selectedTaskId);
    });
  }

  async function discardWorkspace() {
    if (!selectedTaskId) {
      return;
    }
    await perform("discard", async () => {
      await window.autoPm.discardWorkspace(selectedTaskId);
      await refresh(selectedTaskId);
    });
  }

  async function probeRuntime() {
    await perform("runtime-probe", async () => {
      setRuntimeHealth(await window.autoPm.probeRuntimeLive());
    });
  }

  async function perform(label: string, run: () => Promise<void>) {
    setBusy(label);
    try {
      await run();
      setError(null);
    } catch (caught) {
      setCaughtError(caught);
    } finally {
      setBusy(null);
    }
  }

  function setCaughtError(caught: unknown) {
    setError(formatCaughtError(caught));
  }
}

function ErrorPanel({ error }: { error: DisplayError }) {
  return (
    <div className="errorLine">
      <strong>{error.code}</strong>
      <span>{error.message}</span>
      {error.action ? <small>{error.action}</small> : null}
      {error.details ? <code>{error.details}</code> : null}
    </div>
  );
}

function ProfilePermissionSummary({ profile }: { profile: ConfigMetadata["profiles"][number] }) {
  return (
    <div className="profileSummary" data-testid="profile-permission-summary">
      <span>{profile.runtime}</span>
      <strong>{profilePermissionText(profile)}</strong>
      {profile.runtime === "codex" && profile.codexApprovalPolicy === "on-failure" ? <em>deprecated</em> : null}
    </div>
  );
}

function profilePermissionText(profile?: ConfigMetadata["profiles"][number] | null): string {
  if (!profile) {
    return "-";
  }
  if (profile.runtime === "claude") {
    return profile.claudePermissionMode;
  }
  return `${profile.codexSandboxMode} / ${profile.codexApprovalPolicy} / network:${profile.codexNetworkAccessEnabled ? "on" : "off"}`;
}

function eventSummary(event: EventEnvelope["event"]): string {
  if ("text" in event && typeof event.text === "string") {
    return event.text;
  }
  if ("error" in event && typeof event.error === "string") {
    return event.error;
  }
  if ("summary" in event && typeof event.summary === "string") {
    return event.summary;
  }
  return "";
}

function TaskTreeItem(props: {
  node: TaskTreeNode;
  selectedTaskId: string | null;
  onSelect(taskId: string): void;
  depth?: number | undefined;
}) {
  const depth = props.depth ?? 0;
  return (
    <div>
      <button
        type="button"
        className={`taskRow ${props.node.task.id === props.selectedTaskId ? "selected" : ""}`}
        style={{ paddingLeft: 14 + depth * 16 }}
        onClick={() => props.onSelect(props.node.task.id)}
      >
        <span className={`statusDot ${props.node.task.status}`} />
        <span className="taskName">{props.node.task.name ?? props.node.task.id.slice(0, 8)}</span>
        <span className="taskRuntime">{props.node.task.runtime} · {props.node.task.model}</span>
      </button>
      {props.node.children.map((child) => (
        <TaskTreeItem
          key={child.task.id}
          node={child}
          selectedTaskId={props.selectedTaskId}
          onSelect={props.onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function WorkspacePanel(props: {
  task: TaskDetail | null;
  diff: WorkspaceDiffView | null;
  approvals: ApprovalView[];
  mergeReason: string;
  setMergeReason(value: string): void;
  busy: boolean;
  diffOpen: boolean;
  setDiffOpen(value: boolean): void;
  onRequestMerge(): Promise<void>;
  onApplyMerge(): Promise<void>;
  onDiscard(): Promise<void>;
}) {
  const approvalId = approvedMergeApprovalId(props.task, props.approvals);
  if (!props.task?.workspace) {
    return <div className="empty">No workspace</div>;
  }
  const stats = diffStats(props.diff);
  return (
    <div className="workspacePanel">
      <dl className="metaGrid">
        <dt>Status</dt>
        <dd>{props.task.workspace.status}</dd>
        <dt>Path</dt>
        <dd>{props.task.workspace.path}</dd>
        <dt>Base</dt>
        <dd>{props.task.workspace.baseRef?.slice(0, 10) ?? "-"}</dd>
        <dt>Head</dt>
        <dd>{props.diff?.head?.slice(0, 10) ?? props.task.workspace.head?.slice(0, 10) ?? "-"}</dd>
      </dl>
      <div className="workspaceActions">
        <input value={props.mergeReason} onChange={(event) => props.setMergeReason(event.target.value)} />
        <div className="workspaceBtnRow">
          <button type="button" disabled={!canRequestMerge(props.task, props.diff) || props.busy} onClick={() => void props.onRequestMerge()} data-testid="request-merge">Request merge</button>
          <button type="button" disabled={!canApplyMerge(props.task, props.approvals) || props.busy || !approvalId} onClick={() => void props.onApplyMerge()} data-testid="apply-merge">Apply merge</button>
          <button type="button" disabled={!canDiscardWorkspace(props.task) || props.busy} onClick={() => void props.onDiscard()} data-testid="discard-workspace">Discard</button>
          <button type="button" disabled={!props.diff || props.diff.changes.length === 0} onClick={() => props.setDiffOpen(!props.diffOpen)}>
            {props.diffOpen ? "Hide diff" : `Show diff (${stats.total})`}
          </button>
        </div>
      </div>
      <div className="changeList">
        {props.diff?.changes.map((change) => (
          <div className="changeRow" key={`${change.changeKind}:${change.path}`}>
            <span>{change.changeKind}</span>
            <code>{change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path}</code>
            {change.binary ? <em>binary</em> : null}
          </div>
        ))}
        {props.diff && props.diff.changes.length === 0 ? <div className="empty">No changes</div> : null}
      </div>
      {props.task.workspace.mergeError ? (
        <div className="errorLine">{props.task.workspace.mergeError.code}: {props.task.workspace.mergeError.message}</div>
      ) : null}
      {props.diffOpen && props.diff ? (
        <div className="diffDrawer">
          <div className="diffSummary">
            <span>{stats.text} text</span>
            <span>{stats.binary} binary</span>
            {stats.truncated ? <span>truncated</span> : null}
          </div>
          {props.diff.patch ? <pre className="diffBlock">{props.diff.patch}</pre> : <div className="empty">No text patch</div>}
        </div>
      ) : null}
    </div>
  );
}

function RuntimePanel({ health }: { health: RuntimeHealth[] }) {
  return (
    <div className="runtimePanel">
      {health.map((entry) => (
        <section key={entry.runtime} className="runtimeCard">
          <div className="runtimeHeader">
            <strong>{entry.runtime}</strong>
            <span className={entry.available ? "healthOk" : "healthError"}>{entry.available ? "available" : "blocked"}</span>
          </div>
          {[...entry.staticChecks, ...entry.capabilityChecks].map((check) => (
            <div className={`healthRow ${check.status}`} key={check.id}>
              <span>{check.label}</span>
              <strong>{check.status}</strong>
              <p>{check.message}</p>
              {check.action ? <p>{check.action}</p> : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
