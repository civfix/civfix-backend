import { defineConfig } from "drizzle-kit"

/**
 * FOR DIFF INSPECTION ONLY. The CANONICAL DDL is the hand-authored ./drizzle/NNNN_*.sql, applied by
 * src/db/migrate.ts: drizzle-kit cannot express PostGIS geometry, GiST indexes, or declarative
 * partitioning, so it is NOT the migration generator here. It stays configured only so `pnpm
 * db:generate` can show how the Drizzle table models differ from a baseline.
 *
 * Two deliberate choices:
 *   1. `out` points at ./drizzle/_generated (NOT ./drizzle) so generated artifacts can never collide
 *      with or be picked up alongside the canonical hand SQL that the migrate runner applies.
 *   2. drizzle-kit@0.28 loads the schema through esbuild-register (CJS), which does not rewrite the
 *      NodeNext-style ".js" import specifiers our schema uses (e.g. import ... from "./types.js").
 *      As a result `db:generate` may fail to resolve those relative imports on this toolchain. That
 *      is expected and harmless: tsc / tsup / tsx all resolve ".js" -> ".ts" correctly, the build,
 *      typecheck, and tests are green, and the hand SQL remains the source of truth. If you want a
 *      working diff, run drizzle-kit against a transpiled copy of the schema; do not "fix" this by
 *      dropping the ".js" extensions, which NodeNext requires for the rest of the toolchain.
 */
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/_generated",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
})
