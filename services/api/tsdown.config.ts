import { defineConfig, type UserConfig } from "tsdown"

// One build per entry: Rolldown splits the modules several entries share into chunks of their own,
// and the entries must stay self-contained files, each a whole program.
function perEntry({
  entry,
  ...shared
}: Omit<UserConfig, "entry"> & { entry: Record<string, string> }): UserConfig[] {
  return Object.entries(entry).map(([name, source]) => ({ ...shared, entry: { [name]: source } }))
}

export default defineConfig(
  perEntry({
    entry: {
      main: "src/main.ts",
      server: "src/server.ts",
      "db/migrate": "src/db/migrate.ts",
      "db/seed": "src/db/seed.ts",
      "db/ingest-jurisdictions": "src/db/ingest-jurisdictions.ts",
      "db/backfill-jurisdictions": "src/db/backfill-jurisdictions.ts",
      "db/backfill-population": "src/db/backfill-population.ts",
      "db/backfill-reference-codes": "src/db/backfill-reference-codes.ts",
      "db/backfill-served-key": "src/db/backfill-served-key.ts",
      "db/backfill-user-activity": "src/db/backfill-user-activity.ts",
      "db/backfill-signup-seats": "src/db/backfill-signup-seats.ts",
      "db/backfill-post-geom": "src/db/backfill-post-geom.ts",
      // db/seed-demo-la.ts: the LA demo-community seeder, emitted so an operator can run
      //   `node dist/db/seed-demo-la.js [--yes|--purge --yes]` INSIDE the api container (which already
      //   carries DATABASE_URL) WITHOUT tsx or handling credentials. NEVER wired into the deploy
      //   sequence: it is a manually-invoked one-off (default run is a rehearsal that rolls back), and
      //   it refuses to run twice (purge first). Same operational stance as backfill-reference-codes.
      "db/seed-demo-la": "src/db/seed-demo-la.ts",
      // db/demo-join-event.ts: companion one-off that RSVPs a subset of the seeded demo users onto one
      //   existing event (by EVENT reference code or uuid), mirroring joinCleanupTx semantics. Same
      //   manual, rehearse-by-default stance as seed-demo-la; never part of the deploy sequence.
      "db/demo-join-event": "src/db/demo-join-event.ts",
    },
    outDir: "dist",
    format: "esm",
    fixedExtension: false,
    target: "node24",
    platform: "node",
    dts: false,
    sourcemap: true,
    outputOptions: {
      codeSplitting: false,
      // The images run with --enable-source-maps, and Node keeps every loaded map in memory for the life
      // of the process. Stack remapping needs only the mappings; embedding the sources would add about
      // 45 MB of heap to the api.
      sourcemapExcludeSources: true,
    },
    deps: {
      neverBundle: true,
      // @civfix/seams ships TypeScript source (a private workspace package), so it is bundled in rather
      // than resolved from node_modules at runtime.
      alwaysBundle: [/^@civfix\/seams(\/|$)/],
    },
  }),
)
