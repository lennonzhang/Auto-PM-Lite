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
    ...(process.env.AUTO_PM_CLAUDE_MODEL ? { model: process.env.AUTO_PM_CLAUDE_MODEL } : {}),
    env: safeEnv(),
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

function safeEnv(): Record<string, string> {
  const keys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "CLAUDE_CODE_USE_POWERSHELL_TOOL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "ENABLE_PROMPT_CACHING_1H",
  ];
  return Object.fromEntries(keys.flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value]] : [];
  }));
}
