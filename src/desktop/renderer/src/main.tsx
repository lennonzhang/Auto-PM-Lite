import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalView, ConfigMetadata, EventEnvelope, TaskSummary } from "../../../api/types.js";
import "./styles.css";

function App() {
  const [config, setConfig] = useState<ConfigMetadata | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void refresh();
    void window.autoPm.replayAndSubscribeToEvents({}, (event) => {
      setEvents((current) => [event, ...current].slice(0, 80));
      void refresh();
    }).then((subscription) => {
      unsubscribe = subscription.unsubscribe;
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  async function refresh() {
    try {
      const [metadata, taskList, approvalList] = await Promise.all([
        window.autoPm.getConfig(),
        window.autoPm.listTasks(),
        window.autoPm.listApprovals(),
      ]);
      setConfig(metadata);
      setTasks(taskList);
      setApprovals(approvalList);
      setSelectedTaskId((current) => current ?? taskList[0]?.id ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0],
    [selectedTaskId, tasks],
  );
  const selectedApprovals = selectedTask
    ? approvals.filter((approval) => approval.taskId === selectedTask.id)
    : approvals;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="paneHeader">
          <span>Tasks</span>
          <button type="button" onClick={() => void refresh()} title="Refresh">↻</button>
        </div>
        <div className="taskList">
          {tasks.map((task) => (
            <button
              type="button"
              className={`taskRow ${task.id === selectedTask?.id ? "selected" : ""}`}
              key={task.id}
              onClick={() => setSelectedTaskId(task.id)}
            >
              <span className={`statusDot ${task.status}`} />
              <span className="taskName">{task.name ?? task.id.slice(0, 8)}</span>
              <span className="taskRuntime">{task.runtime}</span>
            </button>
          ))}
          {tasks.length === 0 ? <div className="empty">No tasks</div> : null}
        </div>
      </aside>

      <section className="center">
        <div className="topbar">
          <div>
            <h1>{selectedTask?.name ?? selectedTask?.id ?? "Auto-PM Lite"}</h1>
            <p>{selectedTask ? `${selectedTask.profileId} · ${selectedTask.cwd}` : config?.workspace.rootDir}</p>
          </div>
          <span className="apiBadge">API v{config?.apiVersion ?? "-"}</span>
        </div>

        {error ? <div className="errorLine">{error}</div> : null}

        <div className="transcript">
          <div className="paneHeader">
            <span>Events</span>
          </div>
          <div className="eventList">
            {events.map((event, index) => (
              <div className="eventRow" key={`${event.event.ts}-${index}`}>
                <span>{event.event.type}</span>
                <code>{event.event.taskId.slice(0, 8)}</code>
                <time>{new Date(event.event.ts).toLocaleTimeString()}</time>
              </div>
            ))}
            {events.length === 0 ? <div className="empty">No live events</div> : null}
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="paneHeader">
          <span>Approvals</span>
        </div>
        <div className="approvalList">
          {selectedApprovals.map((approval) => (
            <div className="approvalRow" key={approval.id}>
              <div>
                <strong>{approval.kind}</strong>
                <p>{approval.status} · {approval.category}</p>
              </div>
              {approval.status === "pending" ? (
                <div className="approvalActions">
                  <button type="button" onClick={() => void resolveApproval(approval.id, true)}>Approve</button>
                  <button type="button" onClick={() => void resolveApproval(approval.id, false)}>Deny</button>
                </div>
              ) : null}
            </div>
          ))}
          {selectedApprovals.length === 0 ? <div className="empty">No approvals</div> : null}
        </div>

        <div className="paneHeader">
          <span>Runtime</span>
        </div>
        <dl className="metaGrid">
          <dt>Profiles</dt>
          <dd>{config?.profiles.length ?? 0}</dd>
          <dt>Policies</dt>
          <dd>{config?.policies.length ?? 0}</dd>
          <dt>Storage</dt>
          <dd>{config?.storage.dbPath ?? "-"}</dd>
        </dl>
      </aside>
    </main>
  );

  async function resolveApproval(approvalId: string, approved: boolean) {
    await window.autoPm.resolveApproval({ approvalId, approved });
    await refresh();
  }
}

createRoot(document.getElementById("root")!).render(<App />);
