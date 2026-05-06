import { describe, expect, it } from "vitest";
import { DefaultRendererRegistry, genericJsonToolRenderer, itemRendererKey } from "../../src/desktop/renderer/src/renderer-registry.js";
import type { AgentItem } from "../../src/core/events.js";

describe("renderer registry", () => {
  it("selects specialized tool renderers and falls back to generic JSON", () => {
    const registry = new DefaultRendererRegistry();

    expect(registry.getToolRenderer({ runtime: "claude", name: "Bash" }).key).toBe("shell");
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
});
