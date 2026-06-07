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
 *   - the migration bookkeeping recorded ALL current migration files (0000..0005), in order.
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
  // Phase 2 (admin / operator) tables, created by 0007_admin_phase2.sql.
  "jurisdiction_contacts",
  "gov_claims",
  "user_moderation",
  "moderation_items",
  "mail_threads",
  "mail_messages",
  "mail_events",
  "outreach_state",
  "cleanup_timeline",
] as const

describe.skipIf(!pg)("schema: migrations produce the expected shape", () => {
  const h = pg as PgHarness

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

  it("added the nullable reports.claim_code column with a partial unique index (0005)", async () => {
    const cols = await h.sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'reports' AND column_name = 'claim_code'
    `
    expect(cols.length).toBe(1)
    expect(cols[0]?.data_type).toBe("text")
    expect(cols[0]?.is_nullable).toBe("YES")

    // The partial unique index exists and actually rejects two reports sharing a non-null claim code,
    // while permitting many rows with a NULL code.
    const idx = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'reports' AND indexname = 'reports_claim_code_key'
    `
    expect(idx.length).toBe(1)

    const a = "22222222-2222-2222-2222-222222222222"
    const b = "33333333-3333-3333-3333-333333333333"
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, claim_code)
      VALUES (${a}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'held', 'h0', 'shared-code')
    `
    await expect(
      h.sql`
        INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, claim_code)
        VALUES (${b}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'held', 'h1', 'shared-code')
      `,
    ).rejects.toThrow()
    // Two reports with a NULL claim code are fine (partial index excludes NULLs).
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell)
      VALUES (${"44444444-4444-4444-4444-444444444444"}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'held', 'h2')
    `
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell)
      VALUES (${"55555555-5555-5555-5555-555555555555"}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'held', 'h3')
    `
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
      "0005_report_claim_code.sql",
      "0006_user_profile.sql",
      "0007_admin_phase2.sql",
    ])
  })
})

/**
 * Phase 2 (admin / operator) schema scaffold: applies the SAME canonical migrations (0007 included) and
 * asserts the new tables, columns, and constraints exist. Docker-gated like the block above (skipped
 * locally, exercised in CI), so 0007_admin_phase2.sql and its Drizzle mirror are verified against a real
 * Postgres without needing infra on a dev machine.
 */
describe.skipIf(!pg)("schema (Phase 2): admin migration 0007 produces the expected shape", () => {
  const h = pg as PgHarness

  it("creates every Phase 2 admin table", async () => {
    const rows = await h.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `
    const present = new Set(rows.map((r) => r.table_name))
    for (const t of [
      "jurisdiction_contacts",
      "gov_claims",
      "user_moderation",
      "moderation_items",
      "mail_threads",
      "mail_messages",
      "mail_events",
      "outreach_state",
      "cleanup_timeline",
    ]) {
      expect(present.has(t), `missing Phase 2 table: ${t}`).toBe(true)
    }
  })

  it("added cleanups.capacity (nullable int) and cleanups.bags (NOT NULL default 0)", async () => {
    const rows = await h.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cleanups'
        AND column_name IN ('capacity', 'bags')
    `
    const byName = new Map(rows.map((r) => [r.column_name, r]))
    expect(byName.get("capacity")?.data_type).toBe("integer")
    expect(byName.get("capacity")?.is_nullable).toBe("YES")
    expect(byName.get("bags")?.data_type).toBe("integer")
    expect(byName.get("bags")?.is_nullable).toBe("NO")

    // An insert that omits both new columns reads bags back as 0 (default) and capacity as NULL.
    const host = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Cleanup Host') RETURNING id
    `
    const ins = await h.sql<{ bags: number; capacity: number | null }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${host[0]!.id}, 'site', 'Bags default check',
              ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), now(), 'upcoming')
      RETURNING bags, capacity
    `
    expect(ins[0]?.bags).toBe(0)
    expect(ins[0]?.capacity).toBeNull()
  })

  it("enforces the unique thread_token on mail_threads", async () => {
    const idx = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'mail_threads'
        AND indexname = 'mail_threads_thread_token_key'
    `
    expect(idx.length).toBe(1)
    await h.sql`INSERT INTO mail_threads (thread_token) VALUES ('tok-dup')`
    await expect(
      h.sql`INSERT INTO mail_threads (thread_token) VALUES ('tok-dup')`,
    ).rejects.toThrow()
  })

  it("enforces the gov_claims.status CHECK constraint", async () => {
    // A valid status inserts; an invalid one is rejected by the CHECK.
    await h.sql`
      INSERT INTO gov_claims (name, method, status) VALUES ('Valid Claim', 'email', 'pending')
    `
    await expect(
      h.sql`INSERT INTO gov_claims (name, method, status) VALUES ('Bad Claim', 'email', 'bogus')`,
    ).rejects.toThrow()
  })

  it("enforces one default (NULL category) contact per geoid via the partial unique index", async () => {
    // Seed a jurisdiction to reference (geoid FK). The seed already loads some; use a fresh one.
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES ('TEST07', 'Test City', 'place', 1,
              ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))'), 4326))
      ON CONFLICT (geoid) DO NOTHING
    `
    // Two default (NULL category) rows for the same geoid collide on the partial unique index.
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES ('TEST07', NULL, 'a@x.gov')`
    await expect(
      h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES ('TEST07', NULL, 'b@x.gov')`,
    ).rejects.toThrow()
    // But a category-specific row alongside the default is allowed.
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES ('TEST07', 'trash', 'c@x.gov')`
  })
})

// Tear down the shared, memoized withPg() harness only after BOTH describe blocks above have run.
// A per-block afterAll would stop the container before the second (Phase 2) block's tests execute.
afterAll(async () => {
  if (pg) await pg.teardown()
})
