import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { build } from "tsup";
import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(repoRoot, "dist", "desktop", "main", "index.js");

await build({
  entry: {
    index: "src/desktop/main/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  shims: false,
  outDir: "dist/desktop/main",
  external: ["electron"],
});

await build({
  entry: {
    index: "src/desktop/preload/index.ts",
  },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  shims: false,
  outDir: "dist/desktop/preload",
  outExtension: () => ({ js: ".cjs" }),
  external: ["electron"],
});

const server = await createServer({
  configFile: path.join(repoRoot, "src", "desktop", "renderer", "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    strictPort: false,
  },
});
await server.listen();

const urls = server.resolvedUrls?.local ?? [];
const devServerUrl = urls.find((url) => url.startsWith("http://127.0.0.1")) ?? urls[0];
if (!devServerUrl) {
  throw new Error("Unable to resolve desktop renderer dev server URL");
}

const child = spawn(String(electronPath), [mainPath], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AUTO_PM_DESKTOP_DEV_SERVER: devServerUrl,
  },
  stdio: "inherit",
});

const stop = async () => {
  if (!child.killed) {
    child.kill();
  }
  await server.close();
};

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(143));
});

const exitCode = await new Promise<number | null>((resolve) => {
  child.on("exit", (code) => resolve(code));
});
await stop();
process.exit(exitCode ?? 0);
