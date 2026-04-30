import process from "node:process";
import { AutoPmMcpService } from "./auto-pm-service.js";
import { openOrchestrator } from "../app.js";

const LATEST_PROTOCOL_VERSION = "2025-11-25";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export async function runStdioMcpServer(configPath: string, taskId: string): Promise<void> {
  const orchestrator = await openOrchestrator(configPath);
  const service = new AutoPmMcpService(orchestrator.createMcpHandlers(taskId));
  let buffer = Buffer.alloc(0);
  let framing: "headers" | "jsonl" | null = null;

  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

      while (true) {
        if (!framing) {
          const asText = buffer.toString("utf8");
          if (asText.startsWith("Content-Length:")) {
            framing = "headers";
          } else if (asText.includes("\n")) {
            framing = "jsonl";
          } else {
            break;
          }
        }

        if (framing === "jsonl") {
          const newline = buffer.indexOf("\n");
          if (newline === -1) {
            break;
          }
          const line = buffer.subarray(0, newline).toString("utf8").trim();
          buffer = buffer.subarray(newline + 1);
          if (!line) {
            continue;
          }
          const message = JSON.parse(line) as JsonRpcRequest;
          const response = await handleMessage(service, message);
          if (response) {
            writeMessage(response, framing);
          }
          continue;
        }

        const headerBoundary = buffer.indexOf("\r\n\r\n");
        if (headerBoundary === -1) {
          break;
        }

        const header = buffer.subarray(0, headerBoundary).toString("utf8");
        const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
        if (!lengthMatch) {
          throw new Error("Missing Content-Length header");
        }

        const contentLength = Number(lengthMatch[1]);
        const bodyStart = headerBoundary + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) {
          break;
        }

        const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.subarray(bodyEnd);
        const message = JSON.parse(body) as JsonRpcRequest;
        const response = await handleMessage(service, message);
        if (response) {
          writeMessage(response, framing);
        }
      }
    }
  } finally {
    await orchestrator.close();
  }
}

async function handleMessage(service: AutoPmMcpService, message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (message.method === "notifications/initialized") {
    return null;
  }

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "auto-pm-lite",
          version: "0.1.0",
        },
      },
    };
  }

  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        tools: service.listMcpTools(),
      },
    };
  }

  if (message.method === "tools/call") {
    try {
      const params = message.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = "arguments" in params ? params.arguments : {};
      const result = await service.invokeTool(name, args);
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result,
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: {
      code: -32601,
      message: `Method not found: ${message.method}`,
    },
  };
}

function writeMessage(message: JsonRpcResponse, framing: "headers" | "jsonl"): void {
  const payload = JSON.stringify(message);
  if (framing === "jsonl") {
    process.stdout.write(`${payload}\n`);
  } else {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  }
}
