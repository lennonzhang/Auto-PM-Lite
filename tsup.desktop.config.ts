import { defineConfig } from "tsup";

export default defineConfig([
  {
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
  },
  {
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
  },
]);
