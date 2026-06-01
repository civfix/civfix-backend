/**
 * Schema integration test: apply the canonical migrations and assert the resulting database shape.
 *
 * Requires Docker; SKIPPED (not failed) when Docker is unavailable so the local suite stays green.
 *
 * Verifies the things drizzle-kit could NOT express and that the hand SQL owns:
 *   - every Phase 1 table exists;
 *   - reports.idempotency_key has a UNIQUE constraint/index;
 *   - the GiST spatial indexes exist on jurisdictions/reports/cleanups;
 *   - chat_messages is a declaratively partitioned (range) table;
 *   - the migration bookkeeping recorded ALL current migration files (0000..0004), in order.
 */

import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

/** Every table the database layer must create (chat_messages is the partitioned parent). */
const EXPECTED_TABLES = [
  "users",
  "oauth_identities",
  "email_otps",
  "sessions",
  "jurisdictions",
  "reports",
  "media_assets",
  "report_timeline",
  "cleanups",
  "cleanup_members",
  "chat_messages",
  "follows_people",
  "report_follows",
  "notifications",
  "notification_prefs",
  "push_tokens",
  "anon_tokens",
  "abuse_flags",
  "idempotency_keys",
  "jurisdiction_discovery_tasks",
  "audit_log",
] as const

describe.skipIf(!pg)("schema: migrations produce the expected shape", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  it("creates every expected table", async () => {
    const rows = await h.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `
    const present = new Set(rows.map((r) => r.table_name))
    for (const t of EXPECTED_TABLES) {
      expect(present.has(t), `missing table: ${t}`).toBe(true)
    }
  })

  it("enforces a UNIQUE constraint on reports.idempotency_key", async () => {
    // A unique index on exactly (idempotency_key) must exist on reports.
    const rows = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'reports' AND indexname = 'reports_idempotency_key_key'
    `
    expect(rows.length).toBe(1)

    // And it must actually reject duplicates: insert one report, then a second with the same key.
    const key = "11111111-1111-1111-1111-111111111111"
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell)
      VALUES (${key}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'submitted', 'h0')
    `
    await expect(
      h.sql`
        INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell)
        VALUES (${key}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'submitted', 'h1')
      `,
    ).rejects.toThrow()
  })

  it("enforces a PARTIAL UNIQUE on users.email but allows multiple NULLs", async () => {
    // The partial unique index must exist on users.
    const idx = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_email_key'
    `
    expect(idx.length).toBe(1)

    // Two rows with NULL email are allowed (partial index excludes NULLs).
    await h.sql`INSERT INTO users (display_name) VALUES ('No Email A')`
    await h.sql`INSERT INTO users (display_name) VALUES ('No Email B')`

    // The same email cannot be inserted twice (case-insensitively, since email is citext).
    await h.sql`INSERT INTO users (display_name, email) VALUES ('Dup A', 'dup@example.com')`
    await expect(
      h.sql`INSERT INTO users (display_name, email) VALUES ('Dup B', 'DUP@example.com')`,
    ).rejects.toThrow()
  })

  it("creates GiST indexes on all geometry columns", async () => {
    const rows = await h.sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('jurisdictions_geom_gist', 'reports_geom_gist', 'cleanups_geom_gist')
    `
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]))
    for (const name of ["jurisdictions_geom_gist", "reports_geom_gist", "cleanups_geom_gist"]) {
      const def = byName.get(name)
      expect(def, `missing GiST index: ${name}`).toBeTruthy()
      // Confirm it is actually a GiST index, not a b-tree that happens to share the name.
      expect(def?.toLowerCase()).toContain("using gist")
    }
  })

  it("declares chat_messages as a RANGE-partitioned table", async () => {
    const rows = await h.sql<{ partstrat: string }[]>`
      SELECT partstrat FROM pg_partitioned_table
      WHERE partrelid = 'public.chat_messages'::regclass
    `
    expect(rows.length).toBe(1)
    // 'r' = range partitioning.
    expect(rows[0]?.partstrat).toBe("r")
  })

  it("created the monthly chat_messages partitions plus a default", async () => {
    const rows = await h.sql<{ child: string }[]>`
      SELECT c.relname AS child
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.chat_messages'::regclass
    `
    const children = new Set(rows.map((r) => r.child))
    expect(children.has("chat_messages_default")).toBe(true)
    expect(children.has("chat_messages_2026_05")).toBe(true)
    expect(children.has("chat_messages_2026_06")).toBe(true)
    expect(children.has("chat_messages_2026_07")).toBe(true)
  })

  it("added the nullable cleanups.address column (0004)", async () => {
    const rows = await h.sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cleanups' AND column_name = 'address'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]?.data_type).toBe("text")
    expect(rows[0]?.is_nullable).toBe("YES")
  })

  it("recorded every migration file in the bookkeeping table", async () => {
    const rows = await h.sql<{ name: string }[]>`SELECT name FROM _civfix_migrations ORDER BY name`
    const names = rows.map((r) => r.name)
    expect(names).toEqual([
      "0000_extensions.sql",
      "0001_core.sql",
      "0002_chat_partitioning.sql",
      "0003_users_email.sql",
      "0004_cleanup_address.sql",
    ])
  })
})
