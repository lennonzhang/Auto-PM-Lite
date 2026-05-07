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
    shellToolRenderer,
    fileReadToolRenderer,
    fileWriteToolRenderer,
    fileEditToolRenderer,
    webSearchToolRenderer,
    todoToolRenderer,
    mcpToolRenderer,
    delegationToolRenderer,
    genericJsonToolRenderer,
  ];
}

const shellToolRenderer: ToolRenderer = {
  key: "shell",
  canRender: (tool) => toolNameIn(tool, ["shell", "bash", "powershell", "PowerShell", "Bash"]),
  summarizeInput: (input) => stringField(input, "command") ?? rawString(input) ?? safeJson(input),
  renderInput: (input) => {
    const command = stringField(input, "command") ?? stringField(input, "cmd") ?? rawString(input) ?? safeJson(input);
    const cwd = stringField(input, "cwd");
    return cwd ? `$ ${command}\n# cwd: ${cwd}` : `$ ${command}`;
  },
  renderProgress: (item) => {
    const command = stringField(item.payload.input, "command") ?? toolLabel(item.payload.tool);
    return `${command} ${item.payload.phase}`;
  },
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const fileReadToolRenderer: ToolRenderer = {
  key: "file_read",
  canRender: (tool) => toolNameIn(tool, ["Read", "read", "file_read"]),
  summarizeInput: (input) => stringField(input, "file_path") ?? stringField(input, "path") ?? safeJson(input),
  renderInput: (input) => `read ${pathField(input)}`,
  renderProgress: (item) => `reading ${pathField(item.payload.input)}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const fileWriteToolRenderer: ToolRenderer = {
  key: "file_write",
  canRender: (tool) => toolNameIn(tool, ["Write", "write", "file_write"]),
  summarizeInput: (input) => stringField(input, "file_path") ?? stringField(input, "path") ?? safeJson(input),
  renderInput: (input) => {
    const content = stringField(input, "content");
    return `write ${pathField(input)}${content ? `\n${preview(content)}` : ""}`;
  },
  renderProgress: (item) => `writing ${pathField(item.payload.input)}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const fileEditToolRenderer: ToolRenderer = {
  key: "file_edit",
  canRender: (tool) => toolNameIn(tool, ["Edit", "MultiEdit", "edit", "file_edit"]),
  summarizeInput: (input) => stringField(input, "file_path") ?? stringField(input, "path") ?? safeJson(input),
  renderInput: (input) => {
    const oldString = stringField(input, "old_string");
    const newString = stringField(input, "new_string");
    const edits = Array.isArray(recordField(input, "edits")) ? recordField(input, "edits") as unknown[] : undefined;
    if (edits) {
      return `edit ${pathField(input)}\n${edits.length} edit(s)`;
    }
    return `edit ${pathField(input)}${oldString || newString ? `\n- ${preview(oldString ?? "")}\n+ ${preview(newString ?? "")}` : ""}`;
  },
  renderProgress: (item) => `editing ${pathField(item.payload.input)}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const webSearchToolRenderer: ToolRenderer = {
  key: "web_search",
  canRender: (tool) => toolNameIn(tool, ["web_search", "WebSearch", "WebFetch"]),
  summarizeInput: (input) => stringField(input, "query") ?? stringField(input, "url") ?? safeJson(input),
  renderInput: (input) => stringField(input, "query") ? `search ${stringField(input, "query")}` : `fetch ${stringField(input, "url") ?? safeJson(input)}`,
  renderProgress: (item) => `${toolLabel(item.payload.tool)} ${item.payload.phase}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const todoToolRenderer: ToolRenderer = {
  key: "todo",
  canRender: (tool) => toolNameIn(tool, ["TodoWrite", "todo", "todo_write"]),
  summarizeInput: (input) => `${todoEntries(input).length} todo item(s)`,
  renderInput: (input) => todoEntries(input).map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n") || safeJson(input),
  renderProgress: (item) => `${todoEntries(item.payload.input).length} todo item(s) ${item.payload.phase}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const delegationToolRenderer: ToolRenderer = {
  key: "delegation",
  canRender: (tool) => toolNameIn(tool, ["delegate_to", "delegation"]) || tool.name.includes("delegate"),
  summarizeInput: (input) => stringField(input, "taskId") ?? stringField(input, "childTaskId") ?? stringField(input, "prompt") ?? safeJson(input),
  renderInput: (input) => {
    const target = stringField(input, "taskId") ?? stringField(input, "childTaskId") ?? stringField(input, "runtime") ?? "delegation";
    const prompt = stringField(input, "prompt");
    return prompt ? `${target}\n${prompt}` : target;
  },
  renderProgress: (item) => `${toolLabel(item.payload.tool)} ${item.payload.phase}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

const mcpToolRenderer: ToolRenderer = {
  key: "mcp_tool",
  canRender: (tool) => tool.namespace === "mcp" || Boolean(tool.namespace),
  summarizeInput: (input) => safeJson(input),
  renderInput: (input) => safeJson(input),
  renderProgress: (item) => `${toolLabel(item.payload.tool)} ${item.payload.phase}`,
  renderResult: (output) => textOutput(output),
  renderError: (error) => `${error.code}: ${error.message}`,
};

function toolLabel(tool: ToolIdentity): string {
  return tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
}

function toolNameIn(tool: ToolIdentity, names: string[]): boolean {
  return names.includes(tool.name);
}

function pathField(input: unknown): string {
  return stringField(input, "file_path") ?? stringField(input, "path") ?? "<unknown>";
}

function stringField(input: unknown, key: string): string | undefined {
  const record = objectInput(input);
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function recordField(input: unknown, key: string): unknown {
  const record = objectInput(input);
  if (!record) {
    return undefined;
  }
  return record[key];
}

function objectInput(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function rawString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  return objectInput(input) ? undefined : input;
}

function todoEntries(input: unknown): Array<{ text: string; completed: boolean }> {
  const raw = Array.isArray(recordField(input, "todos"))
    ? recordField(input, "todos") as unknown[]
    : Array.isArray(recordField(input, "items"))
      ? recordField(input, "items") as unknown[]
      : [];
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { text: String(entry), completed: false };
    }
    const record = entry as Record<string, unknown>;
    return {
      text: typeof record.content === "string" ? record.content : typeof record.text === "string" ? record.text : safeJson(entry),
      completed: record.completed === true || record.status === "completed",
    };
  });
}

function textOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const text = stringField(output, "content") ?? stringField(output, "text") ?? stringField(output, "result") ?? stringField(output, "message");
  return text ?? safeJson(output);
}

function preview(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
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
