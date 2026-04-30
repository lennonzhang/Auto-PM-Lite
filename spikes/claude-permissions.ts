import process from "node:process";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.argv.slice(2).join(" ") || "Read the current directory, then try to run a harmless pwd command. Answer with the markdown file names and whether the command was denied.";
const permissionRequests: Array<{ toolName: string; input: Record<string, unknown>; blockedPath?: string | undefined }> = [];

const canUseTool: CanUseTool = async (toolName, input, options) => {
  permissionRequests.push({ toolName, input, blockedPath: options.blockedPath });
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    return { behavior: "allow", updatedInput: input };
  }

  return {
    behavior: "deny",
    message: `Denied by smoke canUseTool: ${toolName}`,
    interrupt: false,
  };
};

const session = query({
  prompt,
  options: {
    cwd: process.cwd(),
    ...(process.env.AUTO_PM_CLAUDE_MODEL ? { model: process.env.AUTO_PM_CLAUDE_MODEL } : {}),
    env: safeEnv(),
    permissionMode: "default",
    canUseTool,
  },
});

for await (const message of session) {
  if (message.type === "result") {
    process.stdout.write(`${JSON.stringify({
      subtype: message.subtype,
      session_id: message.session_id,
      permissionRequests,
      result: message.subtype === "success" ? message.result : message.errors,
    }, null, 2)}\n`);
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
