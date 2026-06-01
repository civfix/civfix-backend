import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts", "src/worker.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  skipNodeModulesBundle: true,
})
