import { defineConfig } from "tsup"

export default defineConfig({
  // main.ts: the HTTP server entrypoint. server.ts: the factory (imported by tests/embedding).
  // db/migrate.ts: the migration runner, emitted so the PRODUCTION image can run it WITHOUT tsx (the
  //   deploy sequence runs `node dist/db/migrate.js` before the API serves; see README + the compose
  //   `migrate` init service). It applies services/api/drizzle/0000..0005 in order, idempotently.
  // db/seed.ts + db/ingest-jurisdictions.ts: the jurisdiction-population CLIs, emitted so the production
  //   image can run `node dist/db/seed.js` (curated dev/federal/tribal set) or
  //   `node dist/db/ingest-jurisdictions.js <file> <layer>` (real TIGER/PAD-US boundaries) WITHOUT tsx.
  //   These run AFTER migrate in the deploy sequence (compose `seed` init service); without them the
  //   jurisdictions table stays empty, the spatial resolver returns null for every pin, and the admin
  //   Jurisdictions directory reads empty. Both are idempotent (ON CONFLICT), so re-runs are safe.
  entry: [
    "src/main.ts",
    "src/server.ts",
    "src/db/migrate.ts",
    "src/db/seed.ts",
    "src/db/ingest-jurisdictions.ts",
  ],
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
