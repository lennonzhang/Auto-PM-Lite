import type { AgentItem, ItemError, ToolIdentity, ToolInput, ToolOutput } from "../../../core/events.js";

export type RenderNode = string;

export interface ToolRenderer {
  key: string;
  canRender(tool: ToolIdentity): boolean;
  summarizeInput(input: ToolInput): string;
  renderInput(input: ToolInput, options: { partial: boolean }): RenderNode;
  renderProgress(item: AgentItem<"tool_call">): RenderNode;
  renderResult(output: ToolOutput | undefined, item: AgentItem<"tool_call">): RenderNode;
  renderError(error: ItemError, item: AgentItem<"tool_call">): RenderNode;
}

export interface RendererRegistry {
  getToolRenderer(tool: ToolIdentity): ToolRenderer;
  registerToolRenderer(renderer: ToolRenderer): void;
}

export class DefaultRendererRegistry implements RendererRegistry {
  private readonly toolRenderers: ToolRenderer[];
  private readonly fallback: ToolRenderer;

  constructor(renderers: ToolRenderer[] = defaultToolRenderers()) {
    this.fallback = genericJsonToolRenderer;
    this.toolRenderers = [...renderers.filter((renderer) => renderer.key !== this.fallback.key), this.fallback];
  }

  registerToolRenderer(renderer: ToolRenderer): void {
    const existing = this.toolRenderers.findIndex((entry) => entry.key === renderer.key);
    if (existing >= 0) {
      this.toolRenderers.splice(existing, 1, renderer);
      return;
    }
    this.toolRenderers.splice(Math.max(0, this.toolRenderers.length - 1), 0, renderer);
  }

  getToolRenderer(tool: ToolIdentity): ToolRenderer {
    return this.toolRenderers.find((renderer) => renderer.canRender(tool)) ?? this.fallback;
  }
}

export function itemRendererKey(item: AgentItem): string {
  switch (item.kind) {
    case "assistant_message":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "command_execution":
      return "command_execution";
    case "tool_call":
      return "tool_call";
    case "file_change":
      return "file_change";
    case "todo_list":
      return "todo_list";
    case "web_search":
      return "web_search";
    case "delegation":
      return "delegation";
    case "context_compaction":
      return "context_compaction";
    case "system_notice":
      return "system_notice";
    case "user_message":
      return "user_message";
  }
}

export const genericJsonToolRenderer: ToolRenderer = {
  key: "generic_json_tool",
  canRender: () => true,
  summarizeInput: (input) => safeJson(input),
  renderInput: (input) => safeJson(input),
  renderProgress: (item) => `${toolLabel(item.payload.tool)} ${item.payload.phase}`,
  renderResult: (output) => safeJson(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

function defaultToolRenderers(): ToolRenderer[] {
  return [
    namedToolRenderer("shell", ["shell", "bash", "powershell", "PowerShell", "Bash"]),
    namedToolRenderer("file_read", ["Read", "read", "file_read"]),
    namedToolRenderer("file_write", ["Write", "write", "file_write"]),
    namedToolRenderer("file_edit", ["Edit", "MultiEdit", "edit", "file_edit"]),
    namedToolRenderer("mcp_tool", [], (tool) => tool.namespace === "mcp" || Boolean(tool.namespace)),
    namedToolRenderer("web_search", ["web_search", "WebSearch", "WebFetch"]),
    namedToolRenderer("todo", ["TodoWrite", "todo", "todo_write"]),
    namedToolRenderer("delegation", ["delegate_to", "delegation"]),
    genericJsonToolRenderer,
  ];
}

function namedToolRenderer(key: string, names: string[], predicate?: (tool: ToolIdentity) => boolean): ToolRenderer {
  return {
    key,
    canRender: (tool) => names.includes(tool.name) || Boolean(predicate?.(tool)),
    summarizeInput: (input) => safeJson(input),
    renderInput: (input) => safeJson(input),
    renderProgress: (item) => `${toolLabel(item.payload.tool)} ${item.payload.phase}`,
    renderResult: (output) => safeJson(output),
    renderError: (error) => `${error.code}: ${error.message}`,
  };
}

function toolLabel(tool: ToolIdentity): string {
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
