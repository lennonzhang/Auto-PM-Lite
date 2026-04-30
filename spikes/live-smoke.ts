import { spawn } from "node:child_process";
import process from "node:process";

type Smoke = {
  name: string;
  command: string;
  args: string[];
  timeoutMs: number;
};

const smokes: Smoke[] = [
  {
    name: "claude-cc-basic",
    command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-ExecutionPolicy", "Bypass", "-Command", "& 'D:\\Code\\script\\claude-setup.ps1' -p 'OK'"],
    timeoutMs: 60_000,
  },
  {
    name: "claude-cc-readonly",
    command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-ExecutionPolicy", "Bypass", "-Command", "& 'D:\\Code\\script\\claude-setup.ps1' -p 'List markdown filenames only.'"],
    timeoutMs: 90_000,
  },
  {
    name: "codex-stream-resume",
    command: "pnpm",
    args: ["tsx", "spikes/codex-stream.ts"],
    timeoutMs: 180_000,
  },
  {
    name: "codex-mcp-delegate",
    command: "pnpm",
    args: ["tsx", "spikes/codex-mcp-delegate.ts"],
    timeoutMs: 180_000,
  },
  {
    name: "codex-approval",
    command: "pnpm",
    args: ["tsx", "spikes/codex-approval.ts"],
    timeoutMs: 180_000,
  },
];

for (const smoke of smokes) {
  process.stdout.write(`SMOKE_START ${smoke.name}\n`);
  const result = await run(smoke);
  process.stdout.write(`SMOKE_DONE ${smoke.name} exit=${result.exitCode}\n`);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
}

function run(smoke: Smoke): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(smoke.command, smoke.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32" && !smoke.command.endsWith("powershell.exe"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      stderr += `Smoke timed out after ${smoke.timeoutMs}ms\n`;
      child.kill();
    }, smoke.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = redact(chunk.toString("utf8"));
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += redact(chunk.toString("utf8"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (smoke.name === "codex-mcp-delegate" && (!stdout.includes('"tool": "delegate_to"') || stdout.includes("timed out handshaking"))) {
        resolve({ exitCode: 1, stderr: `${stderr}Codex MCP smoke did not reach delegate_to.\n` });
        return;
      }
      resolve({ exitCode: code ?? 1, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stderr: `${stderr}${error.message}\n` });
    });
  });
}

function redact(input: string): string {
  return input.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
