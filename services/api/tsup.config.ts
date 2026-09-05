import { defineConfig } from "tsup"

export default defineConfig({
  entry: [
    "src/main.ts",
    "src/server.ts",
    "src/db/migrate.ts",
    "src/db/seed.ts",
    "src/db/ingest-jurisdictions.ts",
    "src/db/backfill-jurisdictions.ts",
    "src/db/backfill-population.ts",
    "src/db/backfill-reference-codes.ts",
    "src/db/backfill-served-key.ts",
    "src/db/backfill-user-activity.ts",
  ],
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
