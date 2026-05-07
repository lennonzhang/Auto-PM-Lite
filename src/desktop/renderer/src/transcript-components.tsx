import React from "react";
import type { AgentItem, CommandOutputChunk } from "../../../core/events.js";
import { DefaultRendererRegistry, itemRendererKey, type RendererRegistry } from "./renderer-registry.js";
import type { TaskViewModel } from "./transcript-reducer.js";

const defaultRegistry = new DefaultRendererRegistry();

export function TranscriptView(props: {
  view: TaskViewModel;
  registry?: RendererRegistry | undefined;
}) {
  const registry = props.registry ?? defaultRegistry;
  return (
    <div className="itemTranscript" data-testid="v2-transcript">
      {props.view.resyncRequired ? (
        <div className="warningLine" data-testid="transcript-resync">Transcript resync required. Reconnect or replay this task.</div>
      ) : null}
      {props.view.rootItemOrder.map((itemId) => (
        <TranscriptItemTree
          key={itemId}
          itemId={itemId}
          view={props.view}
          registry={registry}
          depth={0}
        />
      ))}
      {props.view.rootItemOrder.length === 0 ? <div className="empty">No transcript items</div> : null}
    </div>
  );
}

function TranscriptItemTree(props: {
  itemId: string;
  view: TaskViewModel;
  registry: RendererRegistry;
  depth: number;
}) {
  const item = props.view.items.get(props.itemId);
  if (!item) {
    return null;
  }
  const childIds = props.view.childrenByParentId.get(props.itemId) ?? [];
  return (
    <div className="transcriptTreeNode">
      <TranscriptItemRow item={item} registry={props.registry} depth={props.depth} />
      {childIds.length > 0 ? (
        <div className="transcriptChildren">
          {childIds.map((childId) => (
            <TranscriptItemTree
              key={childId}
              itemId={childId}
              view={props.view}
              registry={props.registry}
              depth={props.depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptItemRow(props: {
  item: AgentItem;
  registry?: RendererRegistry | undefined;
  depth?: number | undefined;
}) {
  const registry = props.registry ?? defaultRegistry;
  const item = props.item;
  return (
    <article
      className={`transcriptItem ${itemRendererKey(item)} ${item.status}`}
      style={{ marginLeft: (props.depth ?? 0) * 18 }}
      data-testid={`transcript-item-${item.kind}`}
    >
      <header className="transcriptItemHeader">
        <span className="itemKind">{itemLabel(item)}</span>
        <span className={`itemStatus ${item.status}`}>{item.status.replace(/_/g, " ")}</span>
      </header>
      {renderItemBody(item, registry)}
      {item.error ? <pre className="itemError">{item.error.code}: {item.error.message}</pre> : null}
    </article>
  );
}

function renderItemBody(item: AgentItem, registry: RendererRegistry): React.ReactNode {
  switch (item.kind) {
    case "user_message":
      return <p className="messageText">{item.payload.text}</p>;
    case "assistant_message":
      return <p className="messageText">{item.payload.text}</p>;
    case "reasoning":
      return (
        <div className="reasoningBlock">
          {item.payload.redacted ? <em>redacted reasoning</em> : null}
          {item.payload.summary.map((entry, index) => <p key={`summary-${index}`}>{entry}</p>)}
          {item.payload.content.map((entry, index) => <p key={`content-${index}`}>{entry}</p>)}
        </div>
      );
    case "command_execution":
      return (
        <div className="commandBlock">
          <div className="commandMeta">
            <code>{item.payload.command}</code>
            <span>{item.payload.cwd}</span>
          </div>
          <CommandOutput chunks={item.payload.outputChunks} fallback={item.payload.aggregatedOutput} />
        </div>
      );
    case "tool_call": {
      const renderer = registry.getToolRenderer(item.payload.tool);
      const isPartial = item.payload.phase === "input_streaming";
      const output = item.payload.output;
      return (
        <div className="toolBlock" data-tool-renderer={renderer.key}>
          <div className="toolTitle">
            <strong>{toolName(item)}</strong>
            <span>{item.payload.phase.replace(/_/g, " ")}</span>
          </div>
          <pre className="toolInput">{renderer.renderInput(item.payload.inputText ?? item.payload.input, { partial: isPartial })}</pre>
          {item.payload.phase !== "completed" && item.payload.phase !== "failed" ? (
            <div className="toolProgress">{renderer.renderProgress(item)}</div>
          ) : null}
          {output !== undefined ? <pre className="toolResult">{renderer.renderResult(output, item)}</pre> : null}
          {item.payload.error ? <pre className="itemError">{renderer.renderError(item.payload.error, item)}</pre> : null}
        </div>
      );
    }
    case "file_change":
      return (
        <div className="fileChangeBlock">
          {item.payload.changes.map((change) => (
            <div className="fileChangeLine" key={`${change.changeKind}:${change.path}`}>
              <span>{change.changeKind}</span>
              <code>{change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path}</code>
              {change.binary ? <em>binary</em> : null}
            </div>
          ))}
          {item.payload.patchPreview ? <pre>{item.payload.patchPreview}</pre> : null}
        </div>
      );
    case "todo_list":
      return (
        <ul className="todoBlock">
          {item.payload.items.map((todo, index) => (
            <li key={`${index}:${todo.text}`} className={todo.completed ? "done" : ""}>{todo.text}</li>
          ))}
        </ul>
      );
    case "web_search":
      return (
        <div className="webSearchBlock">
          <strong>{item.payload.query}</strong>
          {item.payload.results?.map((result, index) => (
            <p key={`${index}:${result.url ?? result.title}`}>
              {result.title ?? result.url ?? "result"}
              {result.snippet ? <small>{result.snippet}</small> : null}
            </p>
          ))}
        </div>
      );
    case "delegation":
      return (
        <div className="delegationBlock">
          <span>{item.payload.status}</span>
          {item.payload.childTaskId ? <code>{item.payload.childTaskId}</code> : null}
          {item.payload.prompt ? <p>{item.payload.prompt}</p> : null}
          {item.payload.finalResponse ? <pre>{item.payload.finalResponse}</pre> : null}
        </div>
      );
    case "context_compaction":
      return (
        <div className="compactionBlock">
          <span>{item.payload.trigger}</span>
          <code>{`${item.payload.preTokens ?? "-"} -> ${item.payload.postTokens ?? "-"}`}</code>
        </div>
      );
    case "system_notice":
      return (
        <div className={`systemNotice ${item.payload.level}`}>
          <strong>{item.payload.code}</strong>
          <span>{item.payload.message}</span>
          {item.payload.details === undefined ? null : <pre>{safeJson(item.payload.details)}</pre>}
        </div>
      );
  }
}

function CommandOutput(props: { chunks: CommandOutputChunk[]; fallback: string }) {
  const chunks = props.chunks.length > 0
    ? props.chunks
    : props.fallback
      ? [{ stream: "stdout" as const, text: props.fallback }]
      : [];
  if (chunks.length === 0) {
    return <div className="empty compact">No command output</div>;
  }
  return (
    <pre className="commandOutput">
      {chunks.map((chunk, index) => (
        <span key={`${index}:${chunk.stream}`} className={`commandChunk ${chunk.stream}`}>
          <b>{chunk.stream}</b>
          {chunk.text}
          {chunk.truncated ? " [truncated]" : ""}
        </span>
      ))}
    </pre>
  );
}

function itemLabel(item: AgentItem): string {
  switch (item.kind) {
    case "assistant_message":
      return "Assistant";
    case "user_message":
      return "User";
    case "reasoning":
      return "Reasoning";
    case "command_execution":
      return "Command";
    case "tool_call":
      return "Tool";
    case "file_change":
      return "File Change";
    case "todo_list":
      return "Todo";
    case "web_search":
      return "Web Search";
    case "delegation":
      return "Delegation";
    case "context_compaction":
      return "Compaction";
    case "system_notice":
      return "Notice";
  }
}

function toolName(item: AgentItem<"tool_call">): string {
  const tool = item.payload.tool;
  return tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
