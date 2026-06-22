import { defineConfig } from "tsup"

export default defineConfig({
  // main.ts: the HTTP server entrypoint. server.ts: the factory (imported by tests/embedding).
  // db/migrate.ts: the migration runner, emitted so the PRODUCTION image can run it WITHOUT tsx (the
  //   deploy sequence runs `node dist/db/migrate.js` before the API serves; see README + the compose
  //   `migrate` init service). It applies services/api/drizzle/0000..0005 in order, idempotently.
  // db/seed.ts + db/ingest-jurisdictions.ts: the jurisdiction-population CLIs, emitted so the production
  //   image can run `node dist/db/seed.js` (curated dev/federal/tribal set) or
  //   `node dist/db/ingest-jurisdictions.js <file> <layer> [geoid-prefix]` (real TIGER/PAD-US boundaries)
  //   WITHOUT tsx. These run AFTER migrate in the deploy sequence (compose `ingest` init service);
  //   without them the jurisdictions table stays empty, the spatial resolver returns null for every pin,
  //   and the admin Jurisdictions directory reads empty. Both are idempotent (ON CONFLICT), so re-runs are
  //   safe.
  // db/backfill-jurisdictions.ts: the Phase-5 one-off, emitted so the production image runs
  //   `node dist/db/backfill-jurisdictions.js` (the compose `backfill` init service, AFTER ingest) WITHOUT
  //   tsx. It re-resolves `reports.jurisdiction_geoid` for existing NULL rows (the "Unmapped" backlog),
  //   which DO NOT self-heal because resolution happens once at write time. Idempotent
  //   (WHERE jurisdiction_geoid IS NULL), so re-running it is safe.
  // db/backfill-population.ts: fills jurisdictions.population from Census ACS (TIGER carries none), emitted
  //   so the image can run `node dist/db/backfill-population.js` WITHOUT tsx. Idempotent (re-UPSERTs the
  //   same values), so re-running is safe. Guard-free core (backfill-population-core.ts) is never bundled
  //   into the server (only this CLI + the tsx scripts/refresh-boundaries import it).
  // db/backfill-reference-codes.ts: the issue-#56 one-off, emitted so the image runs
  //   `node dist/db/backfill-reference-codes.js` WITHOUT tsx. Stamps reference codes on historical
  //   reports + cleanups (and resolves cleanup jurisdictions), AFTER deploy is healthy (NEVER in the
  //   migration tx). Idempotent (only touches reference_code IS NULL rows) + race-free (shares the
  //   reference_counters allocator with live creates). Guard-free core is never bundled into the server.
  // NOTE the boundary-prep runner (scripts/prepare-boundaries.ts) and the manifest
  //   (src/db/boundaries/manifest.ts) are deliberately NOT entries: the runner is a GDAL-dependent ops
  //   tool run via tsx that never executes inside the production image, and the manifest is consumed only
  //   by that tsx runner + the vitest unit suite.
  entry: [
    "src/main.ts",
    "src/server.ts",
    "src/db/migrate.ts",
    "src/db/seed.ts",
    "src/db/ingest-jurisdictions.ts",
    "src/db/backfill-jurisdictions.ts",
    "src/db/backfill-population.ts",
    "src/db/backfill-reference-codes.ts",
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
