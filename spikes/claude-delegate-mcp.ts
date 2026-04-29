import process from "node:process";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const delegateTool = tool(
  "delegate_to",
  "Record a simulated delegation request.",
  {
    targetRuntime: z.enum(["claude", "codex"]),
    prompt: z.string().min(1),
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: `delegation accepted for ${args.targetRuntime}: ${args.prompt}`,
      },
    ],
  }),
);

const mcpServer = createSdkMcpServer({
  name: "auto-pm-lite",
  version: "0.1.0",
  tools: [delegateTool],
});

const prompt = process.argv.slice(2).join(" ") || "Use the delegate_to tool once to ask codex to review the README.";

const session = query({
  prompt,
  options: {
    cwd: process.cwd(),
    permissionMode: "dontAsk",
    allowedTools: ["mcp__auto-pm-lite__delegate_to"],
    mcpServers: {
      "auto-pm-lite": mcpServer,
    },
  },
});

for await (const message of session) {
  if (message.type === "result") {
    process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
  }
}
