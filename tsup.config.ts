import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/app.ts", "src/mcp/stdio-server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  shims: false,
  outDir: "dist",
});
