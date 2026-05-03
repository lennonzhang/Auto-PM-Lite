import { rebuild } from "@electron/rebuild";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPackage from "electron/package.json" with { type: "json" };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDist = path.join(repoRoot, "dist", "desktop");
const desktopNodeModules = path.join(desktopDist, "node_modules");
const rootRequire = createRequire(path.join(repoRoot, "package.json"));
const copiedPackages = new Set<string>();

await fs.access(path.join(desktopDist, "main", "index.js"));
await fs.access(path.join(desktopDist, "preload", "index.cjs"));
await fs.access(path.join(desktopDist, "renderer", "index.html"));

await fs.rm(desktopNodeModules, { recursive: true, force: true });
await fs.mkdir(desktopNodeModules, { recursive: true });

const betterSqliteVersion = await copyPackageTree("better-sqlite3", rootRequire);
await writePackageManifest(betterSqliteVersion);

if (!await installElectronPrebuild()) {
  await rebuild({
    buildPath: desktopDist,
    electronVersion: electronPackage.version,
    onlyModules: ["better-sqlite3"],
    force: true,
    buildFromSource: true,
    mode: "sequential",
    projectRootPath: desktopDist,
  });
}

await verifyNativeBinding();

interface PackageJson {
  name?: string | undefined;
  version?: string | undefined;
  dependencies?: Record<string, string> | undefined;
  optionalDependencies?: Record<string, string> | undefined;
}

async function copyPackageTree(name: string, resolver: ReturnType<typeof createRequire>): Promise<string> {
  const packageJsonPath = resolver.resolve(`${name}/package.json`);
  const source = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageJson;
  const packageName = packageJson.name ?? name;
  if (copiedPackages.has(packageName)) {
    return packageJson.version ?? "0.0.0";
  }

  await copyRuntimePackage(packageName, source);
  copiedPackages.add(packageName);

  const packageRequire = createRequire(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    await copyPackageTree(dependency, packageRequire);
  }

  return packageJson.version ?? "0.0.0";
}

async function copyRuntimePackage(name: string, source: string): Promise<void> {
  const destination = path.join(desktopNodeModules, ...name.split("/"));
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(source, sourcePath).replaceAll("\\", "/");
      return relativePath !== ".git"
        && !relativePath.startsWith(".git/")
        && relativePath !== "node_modules"
        && !relativePath.startsWith("node_modules/");
    },
  });
}

async function writePackageManifest(betterSqliteVersion: string): Promise<void> {
  await fs.writeFile(
    path.join(desktopDist, "package.json"),
    `${JSON.stringify({
      name: "auto-pm-lite-desktop-smoke",
      private: true,
      type: "module",
      dependencies: {
        "better-sqlite3": betterSqliteVersion,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function verifyNativeBinding(): Promise<void> {
  const binaryPath = path.join(desktopNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  await fs.access(binaryPath);
}

async function installElectronPrebuild(): Promise<boolean> {
  const betterSqliteDir = path.join(desktopNodeModules, "better-sqlite3");
  const prebuildInstallBin = path.join(desktopNodeModules, "prebuild-install", "bin.js");
  const nodeCommand = await resolveNodeCommand();
  return new Promise((resolve) => {
    const child = spawn(
      nodeCommand,
      [
        prebuildInstallBin,
        "--runtime=electron",
        `--target=${electronPackage.version}`,
        `--arch=${process.arch}`,
        "--tag-prefix=v",
      ],
      {
        cwd: betterSqliteDir,
        env: {
          ...process.env,
          npm_config_runtime: "electron",
          npm_config_target: electronPackage.version,
          npm_config_arch: process.arch,
        },
        stdio: "inherit",
      },
    );
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function resolveNodeCommand(): Promise<string> {
  try {
    await fs.access(process.execPath);
    return process.execPath;
  } catch {
    return "node";
  }
}
