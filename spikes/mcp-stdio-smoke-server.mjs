import process from "node:process";
import fs from "node:fs";

const logPath = process.env.AUTO_PM_MCP_SMOKE_LOG;
log("start");

const tools = [
  {
    name: "delegate_to",
    description: "Smoke-test delegation tool.",
    inputSchema: {
      type: "object",
      properties: {
        targetRuntime: { type: "string", enum: ["claude", "codex"] },
        prompt: { type: "string" },
      },
      required: ["targetRuntime", "prompt"],
      additionalProperties: false,
    },
  },
];

let buffer = Buffer.alloc(0);
let framing = null;

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
      const request = JSON.parse(line);
      log(`request:${request.method}`);
      const response = handle(request);
      if (response) {
        write(response);
      }
      continue;
    }

    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary === -1) {
      break;
    }

    const header = buffer.subarray(0, boundary).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      throw new Error("Missing Content-Length header");
    }

    const length = Number(match[1]);
    const bodyStart = boundary + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      break;
    }

    const request = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    log(`request:${request.method}`);
    buffer = buffer.subarray(bodyEnd);
    const response = handle(request);
    if (response) {
      write(response);
    }
  }
}

function handle(request) {
  if (request.method === "notifications/initialized") {
    return null;
  }

  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "auto-pm-lite-smoke", version: "0.1.0" },
      },
    };
  }

  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { tools },
    };
  }

  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    if (name !== "delegate_to") {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          content: [{ type: "text", text: `unknown tool: ${name}` }],
          isError: true,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        content: [{ type: "text", text: "delegation smoke accepted" }],
        structuredContent: { ok: true },
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  };
}

function write(response) {
  const payload = JSON.stringify(response);
  if (framing === "jsonl") {
    process.stdout.write(`${payload}\n`);
  } else {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  }
  log(`response:${response.id ?? "notification"}`);
}

function log(message) {
  if (logPath) {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  }
}
