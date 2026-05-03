import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(repoRoot, "dist", "desktop", "main", "index.js");
const portableExe = path.join(repoRoot, "dist", "desktop-portable", "Auto-PM-Lite", "Auto-PM-Lite.exe");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-desktop-smoke-"));
const configPath = path.join(tempRoot, "config.toml");
const userDataPath = path.join(tempRoot, "user-data");

const smokeTarget = await resolveSmokeTarget();

await fs.mkdir(userDataPath, { recursive: true });

const child = spawn(smokeTarget.command, smokeTarget.args, {
  cwd: repoRoot,
  env: {
    ...process.env,
    AUTO_PM_CONFIG_PATH: configPath,
    AUTO_PM_DESKTOP_USER_DATA: userDataPath,
    AUTO_PM_DESKTOP_SMOKE: "1",
    AUTO_PM_DESKTOP_FAKE_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const timeout = setTimeout(() => {
  child.kill();
  process.stderr.write(`${stderr}\n`);
  throw new Error("desktop smoke timed out before AUTO_PM_DESKTOP_READY");
}, 20_000);

child.stdout.on("data", (chunk: Buffer) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString("utf8");
});

const exitCode = await new Promise<number | null>((resolve) => {
  child.on("exit", (code) => resolve(code));
});
clearTimeout(timeout);

if (!stdout.includes("AUTO_PM_DESKTOP_READY")) {
  process.stderr.write(stderr);
  throw new Error("desktop smoke did not report readiness");
}

if (exitCode !== 0) {
  process.stderr.write(stderr);
  throw new Error(`desktop smoke exited with ${exitCode}`);
}

process.stdout.write("desktop smoke passed\n");

async function resolveSmokeTarget(): Promise<{ command: string; args: string[] }> {
  try {
    await fs.access(portableExe);
    return { command: portableExe, args: ["--no-sandbox"] };
  } catch {}

  try {
    await fs.access(mainPath);
    return { command: String(electronPath), args: ["--no-sandbox", mainPath] };
  } catch {
    throw new Error("desktop build missing; run pnpm run desktop:build before pnpm run desktop:smoke");
  }
}
