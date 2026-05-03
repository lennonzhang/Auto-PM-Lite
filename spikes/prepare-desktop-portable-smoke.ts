import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const electronPackagePath = require.resolve("electron/package.json");
const electronPackageRoot = path.dirname(electronPackagePath);
const electronDist = path.join(electronPackageRoot, "dist");
const desktopDist = path.join(repoRoot, "dist", "desktop");
const portableRoot = path.join(repoRoot, "dist", "desktop-portable", "Auto-PM-Lite");
const portableResources = path.join(portableRoot, "resources");
const portableApp = path.join(portableResources, "app");

await fs.access(path.join(desktopDist, "main", "index.js"));
await fs.access(path.join(desktopDist, "preload", "index.cjs"));
await fs.access(path.join(desktopDist, "renderer", "index.html"));

await fs.mkdir(path.dirname(portableRoot), { recursive: true });
await fs.mkdir(portableRoot, { recursive: true });
await fs.cp(electronDist, portableRoot, { recursive: true, dereference: true, force: true });
await fs.rm(portableApp, { recursive: true, force: true });
await fs.mkdir(portableApp, { recursive: true });

for (const entry of ["main", "preload", "renderer", "node_modules", "package.json"]) {
  await fs.cp(path.join(desktopDist, entry), path.join(portableApp, entry), { recursive: true, dereference: true });
}

await fs.writeFile(path.join(portableApp, "package.json"), `${JSON.stringify({
  name: "auto-pm-lite-desktop",
  private: true,
  type: "module",
  main: "main/index.js",
}, null, 2)}\n`, "utf8");

await fs.rm(path.join(portableRoot, "Auto-PM-Lite.exe"), { force: true });
await fs.rename(path.join(portableRoot, "electron.exe"), path.join(portableRoot, "Auto-PM-Lite.exe"));
process.stdout.write(`desktop portable prepared at ${portableRoot}\n`);
