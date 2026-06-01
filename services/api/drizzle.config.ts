import { defineConfig } from "drizzle-kit"

/**
 * Drizzle Kit config -- FOR DIFF INSPECTION ONLY.
 *
 * The CANONICAL DDL for civfix is the hand-authored SQL in ./drizzle (0000_extensions.sql,
 * 0001_core.sql, 0002_chat_partitioning.sql), applied by src/db/migrate.ts. drizzle-kit cannot
 * express PostGIS geometry, GiST indexes, or declarative partitioning, so it is NOT the migration
 * generator here. We keep it configured only so a developer can run `pnpm db:generate` to eyeball
 * how the Drizzle table models differ from a baseline.
 *
 * IMPORTANT - two deliberate choices:
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
