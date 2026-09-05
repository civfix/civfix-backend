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
    // db/seed-demo-la.ts: the LA demo-community seeder, emitted so an operator can run
    //   `node dist/db/seed-demo-la.js [--yes|--purge --yes]` INSIDE the api container (which already
    //   carries DATABASE_URL) WITHOUT tsx or handling credentials. NEVER wired into the deploy
    //   sequence: it is a manually-invoked one-off (default run is a rehearsal that rolls back), and
    //   it refuses to run twice (purge first). Same operational stance as backfill-reference-codes.
    "src/db/seed-demo-la.ts",
    // db/demo-join-event.ts: companion one-off — RSVPs a subset of the seeded demo users onto one
    //   existing event (by EVENT reference code or uuid), mirroring joinCleanupTx semantics. Same
    //   manual, rehearse-by-default stance as seed-demo-la; never part of the deploy sequence.
    "src/db/demo-join-event.ts",
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
