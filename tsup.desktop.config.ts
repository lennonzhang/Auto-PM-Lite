import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/desktop/main/index.ts",
    "src/desktop/preload/index.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: false,
  dts: false,
  splitting: false,
  shims: false,
  outDir: "dist/desktop",
  external: ["electron"],
});
