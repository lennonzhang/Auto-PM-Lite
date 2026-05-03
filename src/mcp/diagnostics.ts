import { spawn } from "node:child_process";
import { AutoPmMcpService, type AutoPmMcpHandlers } from "./auto-pm-service.js";

const REQUIRED_TOOLS = ["delegate_to", "request_capability", "wait_for_task", "get_task_result", "report_artifact"] as const;
const PROTOCOL_VERSION = "2025-11-25";

export interface McpProbeResult {
  ok: boolean;
  message: string;
  tools?: string[] | undefined;
}

export function probeInProcessMcp(handlers: AutoPmMcpHandlers): McpProbeResult {
  const service = new AutoPmMcpService(handlers);
  const tools = service.listMcpTools().map((tool) => tool.name);
  const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Missing MCP tools: ${missing.join(", ")}`,
      tools,
    };
  }
  return {
    ok: true,
    message: "In-process MCP tools are available.",
    tools,
  };
}

export async function probeStdioMcp(input: {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
}): Promise<McpProbeResult> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const timeoutMs = input.timeoutMs ?? 3_000;
  let stdout = "";
  let stderr = "";
  let stdoutCursor = 0;

  const timeout = setTimeout(() => {
    child.kill();
  }, timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await sendJsonLine(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "auto-pm-lite-diagnostics",
          version: "0.1.0",
        },
      },
    });
    await readJsonLine(() => stdout, () => stdoutCursor, (cursor) => {
      stdoutCursor = cursor;
    }, 1_000);
    await sendJsonLine(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    await sendJsonLine(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await readJsonLine(() => stdout, () => stdoutCursor, (cursor) => {
      stdoutCursor = cursor;
    }, 1_000) as {
      result?: {
        tools?: Array<{ name?: unknown }>;
      };
      error?: {
        message?: unknown;
      };
    };

    if (listed.error) {
      return { ok: false, message: String(listed.error.message ?? "MCP tools/list failed") };
    }

    const tools = (listed.result?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");
    const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Missing MCP tools: ${missing.join(", ")}`,
        tools,
      };
    }

    return {
      ok: true,
      message: "MCP stdio bridge handshake succeeded.",
      tools,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (stderr.trim()) {
      // stderr is intentionally summarized instead of propagated verbatim.
    }
  }
}

function sendJsonLine(child: ReturnType<typeof spawn>, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin) {
      reject(new Error("MCP stdio stdin is unavailable."));
      return;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readJsonLine(read: () => string, getCursor: () => number, setCursor: (cursor: number) => void, timeoutMs: number): Promise<unknown> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = read();
    const cursor = getCursor();
    const newline = output.indexOf("\n", cursor);
    if (newline !== -1) {
      const line = output.slice(cursor, newline).trim();
      setCursor(newline + 1);
      if (line) {
        return JSON.parse(line);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("MCP stdio handshake timed out.");
}
