import { describe, expect, it } from "vitest";
import { DefaultRendererRegistry, genericJsonToolRenderer, itemRendererKey } from "../../src/desktop/renderer/src/renderer-registry.js";
import type { AgentItem } from "../../src/core/events.js";

describe("renderer registry", () => {
  it("selects specialized tool renderers and falls back to generic JSON", () => {
    const registry = new DefaultRendererRegistry();

    expect(registry.getToolRenderer({ runtime: "claude", name: "Bash" }).key).toBe("shell");
    expect(registry.getToolRenderer({ runtime: "claude", name: "Read" }).key).toBe("file_read");
    expect(registry.getToolRenderer({ runtime: "claude", name: "Write" }).key).toBe("file_write");
    expect(registry.getToolRenderer({ runtime: "claude", name: "Edit" }).key).toBe("file_edit");
    expect(registry.getToolRenderer({ runtime: "claude", name: "TodoWrite" }).key).toBe("todo");
    expect(registry.getToolRenderer({ runtime: "claude", name: "WebSearch" }).key).toBe("web_search");
    expect(registry.getToolRenderer({ runtime: "codex", namespace: "mcp", name: "auto_pm.delegate_to" }).key).toBe("mcp_tool");
    expect(registry.getToolRenderer({ runtime: "codex", name: "unknown_tool" }).key).toBe("generic_json_tool");
  });

  it("allows registering custom tool renderers", () => {
    const registry = new DefaultRendererRegistry();
    registry.registerToolRenderer({
      key: "custom",
      canRender: (tool) => tool.name === "custom_tool",
      summarizeInput: () => "summary",
      renderInput: () => "input",
      renderProgress: () => "progress",
      renderResult: () => "result",
      renderError: () => "error",
    });

    expect(registry.getToolRenderer({ runtime: "claude", name: "custom_tool" }).key).toBe("custom");
  });

  it("maps item kinds to renderer keys", () => {
    expect(itemRendererKey({
      id: "cmd",
      taskId: "task",
      sessionId: "session",
      kind: "command_execution",
      status: "in_progress",
      startedAt: "now",
      updatedAt: "now",
      payload: {
        command: "echo hi",
        cwd: "cwd",
        source: "model",
        status: "in_progress",
        aggregatedOutput: "",
        outputChunks: [],
      },
    } satisfies AgentItem<"command_execution">)).toBe("command_execution");
  });

  it("renders unknown inputs safely with generic JSON", () => {
    expect(genericJsonToolRenderer.renderInput({ a: 1 }, { partial: false })).toContain("\"a\": 1");
  });

  it("renders core tools with purpose-built summaries instead of generic JSON blobs", () => {
    const registry = new DefaultRendererRegistry();

    expect(registry.getToolRenderer({ runtime: "claude", name: "Bash" }).renderInput({ command: "pnpm test", cwd: "repo" }, { partial: false }))
      .toContain("$ pnpm test");
    expect(registry.getToolRenderer({ runtime: "claude", name: "Read" }).renderInput({ file_path: "src/index.ts" }, { partial: false }))
      .toBe("read src/index.ts");
    expect(registry.getToolRenderer({ runtime: "claude", name: "Write" }).renderInput({ file_path: "a.txt", content: "hello" }, { partial: false }))
      .toContain("write a.txt");
    expect(registry.getToolRenderer({ runtime: "claude", name: "Edit" }).renderInput({ file_path: "a.txt", old_string: "a", new_string: "b" }, { partial: false }))
      .toContain("edit a.txt");
    expect(registry.getToolRenderer({ runtime: "claude", name: "TodoWrite" }).renderInput({ todos: [{ content: "ship", status: "completed" }] }, { partial: false }))
      .toContain("[x] ship");
    expect(registry.getToolRenderer({ runtime: "claude", name: "WebSearch" }).renderInput({ query: "Auto-PM" }, { partial: false }))
      .toBe("search Auto-PM");
  });
});
