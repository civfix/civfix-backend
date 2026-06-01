import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts", "src/server.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Keep all deps external; this is a service, not a library bundle.
  skipNodeModulesBundle: true,
})
