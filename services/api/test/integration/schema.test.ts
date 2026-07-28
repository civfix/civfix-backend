/**
 * Schema integration test: apply the canonical migrations and assert the resulting database shape.
 *
 * Requires Docker; SKIPPED (not failed) when Docker is unavailable so the local suite stays green.
 *
 * Verifies the things drizzle-kit could NOT express and that the hand SQL owns:
 *   - EVERY table the migrations create exists, and NO table exists that this file does not declare
 *     (the closed set is what keeps EXPECTED_TABLES from going stale, see below);
 *   - the Drizzle mirror barrel (src/db/schema) and the hand SQL declare the SAME table set;
 *   - reports.idempotency_key has a UNIQUE constraint/index;
 *   - the GiST spatial indexes exist on jurisdictions/reports/cleanups;
 *   - chat_messages / dm_messages are declaratively partitioned (range) tables;
 *   - the migration bookkeeping recorded the Phase 1/2 migration files, in order.
 */

import { afterAll, describe, expect, it } from "vitest"
import { getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { withPg, type PgHarness } from "../helpers/pg.js"
import * as schema from "../../src/db/schema/index.js"

const pg = await withPg()

/**
 * EVERY table the database layer must create — the partitioned PARENTS (chat_messages / dm_messages)
 * only; their monthly children are asserted separately below.
 *
 * This list used to stop at Phase 2 + two audit tables and was ~20 tables stale, which made the "creates
 * every expected table" assertion below near-worthless: a new migration's table was simply unlisted, and a
 * typo'd CREATE TABLE in one would still pass. It is now a CLOSED set — a companion test asserts the
 * database contains nothing outside it — so adding a migration that creates a table FAILS this file until
 * the table is listed here, which is the only thing that keeps the list honest.
 *
 * Excluded on purpose (not created by our migrations): `_civfix_migrations` (the runner's own bookkeeping)
 * and `spatial_ref_sys` (shipped by the PostGIS extension).
 */
const EXPECTED_TABLES = [
  // --- Phase 1 core --------------------------------------------------------------------------------
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
  "cleanup_reports",
  "chat_messages",
  "follows_people",
  "notifications",
  "notification_prefs",
  "push_tokens",
  "anon_tokens",
  "abuse_flags",
  "idempotency_keys",
  "jurisdiction_discovery_tasks",
  "audit_log",
  // --- Phase 2 (admin / operator), 0007_admin_phase2.sql -------------------------------------------
  "jurisdiction_contacts",
  "gov_claims",
  "user_moderation",
  "moderation_items",
  "mail_threads",
  "mail_messages",
  "mail_events",
  "outreach_state",
  "cleanup_timeline",
  // --- 0009 direct messages + privacy --------------------------------------------------------------
  "dm_threads",
  "dm_messages",
  "dm_read_state",
  "user_blocks",
  // --- boundary / reference-code / verification plumbing -------------------------------------------
  "boundary_vintage",
  "reference_counters",
  "user_verification",
  "inbound_emails",
  // --- chat: reactions, mentions, report-chat membership, mutes, forwards, groups, polls -----------
  "chat_message_reactions",
  "chat_message_mentions",
  "report_chat_members",
  "conversation_mutes",
  "report_message_forwards",
  "chat_groups",
  "chat_group_members",
  "chat_polls",
  "chat_poll_options",
  "chat_poll_votes",
  // --- volunteer hours (0038) ----------------------------------------------------------------------
  "volunteer_hours",
  "user_jurisdiction_hours",
  // --- social posts (0051) ------------------------------------------------------------------------
  "posts",
  "post_likes",
  "post_saves",
  "post_mentions",
  // --- 2026-07-24 audit follow-ups ----------------------------------------------------------------
  // The attendee-ban record that makes event removal enforceable (M17, 0052), the append-only
  // volunteer-hours journal (M21, 0053), and the reap-tombstone retry queue that stops the orphan sweep
  // leaking R2 objects when a physical delete fails after the row is gone (0057).
  "cleanup_bans",
  "volunteer_hours_audit",
  "media_reap_tombstones",
  // --- service hours / signup slots (0063, 0064) ---------------------------------------------------
  // P9 host-defined signup roles on an event and the one-slot-per-person claim (0063_cleanup_slots.sql),
  // and the issued, publicly verifiable PDF transcripts of a user's volunteer service
  // (0064_service_hours_certificates.sql).
  "cleanup_slots",
  "cleanup_slot_claims",
  "service_hours_certificates",
] as const

/** Tables present in the container but NOT created by our migrations. */
const FOREIGN_TABLES = new Set([
  "_civfix_migrations", // src/db/migrate.ts bookkeeping
  "spatial_ref_sys", // PostGIS extension
])

/**
 * Tables 0044_drop_report_discussion.sql REMOVED when report discussion became report chat. Asserted
 * absent so a re-added mirror (or a resurrected migration) is caught rather than quietly recreating the
 * dual write path.
 */
const DROPPED_TABLES = [
  "report_discussion_messages",
  "report_follows",
  "report_message_mentions",
  "report_message_reactions",
  "report_message_user_mentions",
] as const

/** Base tables the migrations created: everything public, minus partitions and the foreign tables. */
async function ownedTables(h: PgHarness): Promise<Set<string>> {
  const rows = await h.sql<{ relname: string }[]>`
    SELECT rel.relname
    FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relkind IN ('r', 'p')
      AND NOT rel.relispartition
  `
  return new Set(rows.map((r) => r.relname).filter((t) => !FOREIGN_TABLES.has(t)))
}

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

  it("creates NOTHING outside EXPECTED_TABLES (the list cannot go stale)", async () => {
    const owned = await ownedTables(h)
    const undeclared = [...owned].filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t))
    // A new migration's table lands here until it is added to EXPECTED_TABLES above.
    expect(undeclared.sort()).toEqual([])
    // Symmetrically: nothing in the list has silently disappeared.
    expect([...owned].sort()).toEqual([...EXPECTED_TABLES].sort())
  })

  it("the Drizzle mirror barrel declares exactly the same tables as the hand SQL", async () => {
    // The hand SQL in drizzle/ is the source of DDL truth and src/db/schema is a hand-written MIRROR, so
    // nothing but a test couples them. This is the table-level half of that coupling: a mirror added
    // without a migration (or a migration whose mirror was forgotten) fails here.
    // Cast through `unknown` because the barrel also exports the custom COLUMN helpers (geometry/citext)
    // and the enum tuples, so the union is not narrowable to a table type directly.
    const mirrored = Object.values(schema as Record<string, unknown>)
      .filter((v): v is PgTable => is(v, PgTable))
      .map((t) => getTableName(t))
      .sort()
    const owned = [...(await ownedTables(h))].sort()
    expect(mirrored).toEqual(owned)
  })

  it("0044 really dropped the report-discussion tables", async () => {
    const owned = await ownedTables(h)
    for (const t of DROPPED_TABLES) {
      expect(owned.has(t), `table should have been dropped by 0044: ${t}`).toBe(false)
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
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${key}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
    `
    await expect(
      h.sql`
        INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
        VALUES (${key}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h1')
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
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell, claim_code)
      VALUES (${a}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'held', 'h0', 'shared-code')
    `
    await expect(
      h.sql`
        INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell, claim_code)
        VALUES (${b}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'held', 'h1', 'shared-code')
      `,
    ).rejects.toThrow()
    // Two reports with a NULL claim code are fine (partial index excludes NULLs).
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${"44444444-4444-4444-4444-444444444444"}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'held', 'h2')
    `
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${"55555555-5555-5555-5555-555555555555"}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'held', 'h3')
    `
  })

  it("recorded every migration file in the bookkeeping table", async () => {
    const rows = await h.sql<{ name: string }[]>`SELECT name FROM _civfix_migrations ORDER BY name`
    const names = rows.map((r) => r.name)
    // The bookkeeping must include every Phase 1/2 migration, in order, up to and including the DM +
    // privacy migration (0009). Asserted as a prefix so a later migration (e.g. 0010) added by a parallel
    // step does not break this; the DM contract is that 0000..0009 are recorded in this exact order.
    expect(names.slice(0, 10)).toEqual([
      "0000_extensions.sql",
      "0001_core.sql",
      "0002_chat_partitioning.sql",
      "0003_users_email.sql",
      "0004_cleanup_address.sql",
      "0005_report_claim_code.sql",
      "0006_user_profile.sql",
      "0007_admin_phase2.sql",
      "0008_chat_read_state.sql",
      "0009_dm_and_privacy.sql",
    ])
  })
})

/**
 * 0009 (direct messages + privacy) schema scaffold: applies the SAME canonical migrations and asserts the
 * new DM/blocking tables, columns, and partitioning exist. Docker-gated like the blocks above.
 */
describe.skipIf(!pg)("schema (0009): DM + privacy migration produces the expected shape", () => {
  const h = pg as PgHarness

  it("creates the DM + blocking tables", async () => {
    const rows = await h.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `
    const present = new Set(rows.map((r) => r.table_name))
    for (const t of ["dm_threads", "dm_messages", "dm_read_state", "user_blocks"]) {
      expect(present.has(t), `missing 0009 table: ${t}`).toBe(true)
    }
  })

  it("added users.allow_direct_messages (NOT NULL default true)", async () => {
    const rows = await h.sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'allow_direct_messages'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]?.data_type).toBe("boolean")
    expect(rows[0]?.is_nullable).toBe("NO")

    // A user inserted without the column reads it back as true (the default).
    const ins = await h.sql<{ allow_direct_messages: boolean }[]>`
      INSERT INTO users (display_name) VALUES ('DM Default Check') RETURNING allow_direct_messages
    `
    expect(ins[0]?.allow_direct_messages).toBe(true)
  })

  it("declares dm_messages as a RANGE-partitioned table with the monthly partitions + default", async () => {
    const strat = await h.sql<{ partstrat: string }[]>`
      SELECT partstrat FROM pg_partitioned_table WHERE partrelid = 'public.dm_messages'::regclass
    `
    expect(strat.length).toBe(1)
    expect(strat[0]?.partstrat).toBe("r")

    const children = await h.sql<{ child: string }[]>`
      SELECT c.relname AS child
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.dm_messages'::regclass
    `
    const set = new Set(children.map((r) => r.child))
    expect(set.has("dm_messages_default")).toBe(true)
    expect(set.has("dm_messages_2026_06")).toBe(true)
    expect(set.has("dm_messages_2026_07")).toBe(true)
    expect(set.has("dm_messages_2026_08")).toBe(true)
  })

  it("enforces the unique (user_lo, user_hi) thread pair and the lo<hi CHECK", async () => {
    const a = (
      await h.sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Pair A') RETURNING id`
    )[0]!.id
    const b = (
      await h.sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Pair B') RETURNING id`
    )[0]!.id
    const lo = a < b ? a : b
    const hi = a < b ? b : a

    await h.sql`INSERT INTO dm_threads (user_lo, user_hi) VALUES (${lo}, ${hi})`
    // A second thread for the same pair collides on the unique key.
    await expect(
      h.sql`INSERT INTO dm_threads (user_lo, user_hi) VALUES (${lo}, ${hi})`,
    ).rejects.toThrow()
    // A pair with lo >= hi violates the CHECK.
    await expect(
      h.sql`INSERT INTO dm_threads (user_lo, user_hi) VALUES (${hi}, ${lo})`,
    ).rejects.toThrow()
  })

  it("enforces user_blocks PK (idempotent) and the no-self-block CHECK", async () => {
    const a = (
      await h.sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Blk A') RETURNING id`
    )[0]!.id
    const b = (
      await h.sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Blk B') RETURNING id`
    )[0]!.id
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${a}, ${b})`
    // Re-inserting the same edge collides on the PK.
    await expect(
      h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${a}, ${b})`,
    ).rejects.toThrow()
    // A self-block violates the CHECK.
    await expect(
      h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${a}, ${a})`,
    ).rejects.toThrow()
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

/**
 * 0061 (hours privacy) column-shape drift guard.
 *
 * `users.show_volunteer_hours` is a NULLABLE TRI-STATE with NO column default, and 0061's banner says in
 * so many words "do not 'fix' this back": NULL = never chosen (aggregate + leaderboard stay visible,
 * itemised ledger empty), TRUE = itemised public ledger opted in, FALSE = hidden everywhere public.
 *
 * The behavioural suite only half-covers this. A future `NOT NULL` fails loudly (volunteer-hours-pg.test
 * inserts the column as `null` outright), but a future `DEFAULT true` — the shape a well-meaning
 * "consistency with allow_direct_messages" cleanup reaches for — leaves EVERY existing test green while
 * PG11+ backfills every row that exists today, retroactively opting every account into a NEW, public,
 * paginated record of where a named person physically was and on which dates. That is the regression this
 * block exists to catch, so it pins `column_default` as hard as the type and the nullability.
 *
 * Modelled on the users.allow_direct_messages block above, which pins the OPPOSITE invariant (NOT NULL
 * DEFAULT true) for the DM flag — the two together document that the difference is deliberate.
 */
describe.skipIf(!pg)("schema (0061): users.show_volunteer_hours is a NULLable tri-state", () => {
  const h = pg as PgHarness

  it("is boolean, NULLable, and carries NO column default", async () => {
    const rows = await h.sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'show_volunteer_hours'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]?.data_type).toBe("boolean")
    // NOT NULL would destroy the "never chosen" state the C18 predicates are built on.
    expect(rows[0]?.is_nullable).toBe("YES")
    // ANY default is wrong here, and `DEFAULT true` is the specific one 0061 forbids by name.
    expect(rows[0]?.column_default).toBeNull()
  })

  it("a fresh user reads the column back as NULL (never chosen), not as a default", async () => {
    const ins = await h.sql<{ show_volunteer_hours: boolean | null }[]>`
      INSERT INTO users (display_name) VALUES ('Hours Tri-State Check')
      RETURNING show_volunteer_hours
    `
    expect(ins.length).toBe(1)
    // The round-trip is the half the introspection cannot state: a default added by any route (column
    // default, trigger, rule) shows up here as a non-null read.
    expect(ins[0]?.show_volunteer_hours).toBeNull()
  })

  it("stores all THREE states, so the tri-state is real and not a boolean in disguise", async () => {
    for (const flag of [true, false, null]) {
      const rows = await h.sql<{ show_volunteer_hours: boolean | null }[]>`
        INSERT INTO users (display_name, show_volunteer_hours)
        VALUES (${`Hours Tri-State ${String(flag)}`}, ${flag})
        RETURNING show_volunteer_hours
      `
      expect(rows[0]?.show_volunteer_hours).toBe(flag)
    }
  })
})

/**
 * Mirror <-> DDL drift guard for enum VALUE SETS (audit 2026-07-24, db CROSS-CUTTING).
 *
 * The subsystem has three parallel sources of truth: the hand SQL in drizzle/ (canonical), the Drizzle
 * mirrors in src/db/schema (which carry the enum tuples in types.ts), and the @civfix/shared Zod enums.
 * test/unit/enums.test.ts guards mirror <-> shared. NOTHING guarded mirror <-> DDL — which is exactly how
 * the media_assets.purpose bug shipped: 0051_social_posts.sql introduced purpose='post' in the mirror, in
 * the shared enum and in the claim path, but never widened the inline CHECK 0016 created, so EVERY
 * createPost with media raised 23514 and 500'd. 0054_media_purpose_post.sql widened it; this block is the
 * guard that would have caught it on the day.
 *
 * It works in BOTH directions, which is what makes it a guard rather than a snapshot:
 *   - every value-set CHECK the database actually has must be DECLARED below (so a new CHECK on an
 *     unmapped column fails until its mirror is identified), and
 *   - every declared CHECK must exist with EXACTLY its mirror's value set.
 */

interface MirroredCheck {
  table: string
  column: string
  /** The tuple in src/db/schema/types.ts (or an inline literal set where no mirror exists — see note). */
  mirror: readonly string[]
  /** Mirror values deliberately NOT storable in the column. Each one is asserted to be REJECTED. */
  omitted?: readonly string[]
  note?: string
}

const MIRRORED_CHECKS: readonly MirroredCheck[] = [
  { table: "media_assets", column: "purpose", mirror: schema.MEDIA_PURPOSE_VALUES },
  { table: "cleanups", column: "event_kind", mirror: schema.EVENT_KIND_VALUES },
  { table: "chat_group_members", column: "role", mirror: schema.GROUP_MEMBER_ROLE_VALUES },
  { table: "gov_claims", column: "method", mirror: schema.GOV_METHOD_VALUES },
  { table: "gov_claims", column: "status", mirror: schema.GOV_CLAIM_STATUS_VALUES },
  { table: "inbound_emails", column: "status", mirror: schema.INBOUND_EMAIL_STATUS_VALUES },
  { table: "mail_events", column: "type", mirror: schema.MAIL_EVENT_TYPE_VALUES },
  { table: "mail_messages", column: "direction", mirror: schema.MAIL_DIRECTION_VALUES },
  { table: "mail_threads", column: "status", mirror: schema.MAIL_THREAD_STATUS_VALUES },
  { table: "moderation_items", column: "kind", mirror: schema.MODERATION_KIND_VALUES },
  { table: "moderation_items", column: "priority", mirror: schema.MODERATION_PRIORITY_VALUES },
  { table: "moderation_items", column: "status", mirror: schema.MODERATION_STATUS_VALUES },
  { table: "moderation_items", column: "subject_type", mirror: schema.MODERATION_SUBJECT_TYPE_VALUES },
  { table: "user_moderation", column: "account_status", mirror: schema.USER_ACCOUNT_STATUS_VALUES },
  { table: "user_moderation", column: "risk", mirror: schema.USER_RISK_VALUES },
  {
    table: "user_verification",
    column: "status",
    mirror: schema.VERIFICATION_STATUS_VALUES,
    // 'unverified' is the resting state represented by the ABSENCE of a user_verification row: it is in
    // the shared enum (so the mirror tuple carries it) but must never be stored. Asserted rejected below,
    // so this exemption cannot be used to paper over a genuinely missing value.
    omitted: ["unverified"],
  },
  // --- columns with a DDL value set but NO tuple in types.ts (backend-internal, no shared Zod enum).
  // Listed with inline literals so the closed-set direction of the guard still covers them: a widening in
  // SQL alone fails here and forces a decision about where the value set lives.
  { table: "chat_groups", column: "kind", mirror: ["group", "channel"] },
  { table: "chat_groups", column: "visibility", mirror: ["private", "public"] },
  { table: "volunteer_hours", column: "source", mirror: ["report", "event", "manual"] },
  { table: "reports", column: "verification_verdict", mirror: ["approved", "rejected"] },
]

/** `CHECK ((col = ANY (ARRAY['a'::text, ...])))` — how Postgres renders an inline `col IN (...)`. */
const VALUE_SET_CHECK = /^CHECK \(\((\w+) = ANY \(ARRAY\[(.+)\]\)\)\)$/
/** The nullable variant: `CHECK (((col IS NULL) OR (col = ANY (ARRAY[...]))))`. */
const NULLABLE_VALUE_SET_CHECK =
  /^CHECK \(\(\((\w+) IS NULL\) OR \(\1 = ANY \(ARRAY\[(.+)\]\)\)\)\)$/

function parseValueSet(def: string): { column: string; values: string[] } | null {
  const m = VALUE_SET_CHECK.exec(def) ?? NULLABLE_VALUE_SET_CHECK.exec(def)
  if (m === null) return null
  const values = [...m[2]!.matchAll(/'((?:[^']|'')*)'::text/g)].map((x) => x[1]!.replace(/''/g, "'"))
  return { column: m[1]!, values }
}

describe.skipIf(!pg)("schema: enum mirrors match the DDL CHECK constraints", () => {
  const h = pg as PgHarness

  /** Every value-set CHECK on a non-partition public table we own, keyed "table.column". */
  async function dbValueSets(): Promise<Map<string, string[]>> {
    const rows = await h.sql<{ tbl: string; def: string }[]>`
      SELECT rel.relname AS tbl, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE c.contype = 'c'
        AND n.nspname = 'public'
        AND NOT rel.relispartition
        AND rel.relname <> 'spatial_ref_sys'
    `
    const out = new Map<string, string[]>()
    for (const r of rows) {
      const parsed = parseValueSet(r.def)
      if (parsed !== null) out.set(`${r.tbl}.${parsed.column}`, parsed.values)
    }
    return out
  }

  it("every value-set CHECK in the database is DECLARED in MIRRORED_CHECKS", async () => {
    const declared = new Set(MIRRORED_CHECKS.map((c) => `${c.table}.${c.column}`))
    const undeclared = [...(await dbValueSets()).keys()].filter((k) => !declared.has(k))
    // A migration that adds an enum CHECK lands here until it is mapped to its mirror above.
    expect(undeclared.sort()).toEqual([])
  })

  it("every DECLARED CHECK actually exists in the database", async () => {
    const inDb = await dbValueSets()
    const missing = MIRRORED_CHECKS.map((c) => `${c.table}.${c.column}`).filter((k) => !inDb.has(k))
    // This is the direction the 0051 bug fell through: the mirror carried 'post', and NOTHING asserted a
    // CHECK on media_assets.purpose existed with a matching set.
    expect(missing.sort()).toEqual([])
  })

  it("each CHECK's value set equals its mirror tuple (order-insensitive)", async () => {
    const inDb = await dbValueSets()
    for (const c of MIRRORED_CHECKS) {
      const key = `${c.table}.${c.column}`
      const expected = c.mirror.filter((v) => !(c.omitted ?? []).includes(v)).sort()
      expect(inDb.get(key)?.slice().sort(), `value-set drift on ${key}`).toEqual(expected)
    }
  })

  it("media_assets.purpose accepts EVERY mirrored value — including 'post' (0054)", async () => {
    // The behavioral half: the CHECK introspection above proves the DDL text, this proves an INSERT
    // actually lands. Before 0054 the 'post' iteration raised 23514, which is what 500'd every
    // createPost with media.
    for (const purpose of schema.MEDIA_PURPOSE_VALUES) {
      const rows = await h.sql<{ purpose: string }[]>`
        INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose)
        VALUES (gen_random_uuid(), 'image', ${`uploads/purpose-${purpose}`}, 'ready', ${purpose})
        RETURNING purpose
      `
      expect(rows[0]!.purpose).toBe(purpose)
    }
    // ...and the CHECK is still doing its job: an unmirrored value is rejected.
    await expect(
      h.sql`
        INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose)
        VALUES (gen_random_uuid(), 'image', 'uploads/purpose-bogus', 'ready', 'avatar')
      `,
    ).rejects.toMatchObject({ code: "23514" })
  })

  it("the documented omission is genuinely REJECTED: user_verification.status = 'unverified'", async () => {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Verification Omission') RETURNING id
    `
    // 'unverified' lives in the mirror only because the shared enum has it; the column must refuse it, so
    // the `omitted` exemption above cannot hide a real DDL gap.
    await expect(
      h.sql`INSERT INTO user_verification (user_id, status) VALUES (${u!.id}, 'unverified')`,
    ).rejects.toMatchObject({ code: "23514" })
    // The three storable values do insert.
    for (const status of ["pending", "verified", "rejected"]) {
      const rows = await h.sql<{ status: string }[]>`
        INSERT INTO user_verification (user_id, status) VALUES (${u!.id}, ${status})
        ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status
        RETURNING status
      `
      expect(rows[0]!.status).toBe(status)
    }
  })
})

// Tear down the shared, memoized withPg() harness only after EVERY describe block above has run.
// A per-block afterAll would stop the container before the later blocks' tests execute.
afterAll(async () => {
  if (pg) await pg.teardown()
})
