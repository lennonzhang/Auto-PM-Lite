import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDesktopRuntimeDependencies } from "./desktop-runtime-deps.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDist = path.join(repoRoot, "dist", "desktop");

await fs.access(path.join(desktopDist, "main", "index.js"));
await fs.access(path.join(desktopDist, "preload", "index.cjs"));
await fs.access(path.join(desktopDist, "renderer", "index.html"));
await prepareDesktopRuntimeDependencies({ repoRoot });
