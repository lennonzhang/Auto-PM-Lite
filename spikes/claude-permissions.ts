import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.argv.slice(2).join(" ") || "Read the current directory and answer with the names of markdown files only.";

const session = query({
  prompt,
  options: {
    cwd: process.cwd(),
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep"],
  },
});

for await (const message of session) {
  if (message.type === "result") {
    process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
  }
}
