
import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { getTableName, is } from "drizzle-orm"
import { PgTable, getTableConfig } from "drizzle-orm/pg-core"
import { withPg, type PgHarness } from "../helpers/pg.js"
import * as schema from "../../src/db/schema/index.js"
import { FEED_HIDDEN_NOTIFICATION_TYPES } from "../../src/services/notification-helpers.js"

const pg = await withPg()

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
  "jurisdiction_contacts",
  "gov_claims",
  "user_moderation",
  "moderation_items",
  "mail_threads",
  "mail_messages",
  "mail_events",
  "outreach_state",
  "cleanup_timeline",
  "dm_threads",
  "dm_messages",
  "dm_read_state",
  "user_blocks",
  "boundary_vintage",
  "reference_counters",
  "inbound_emails",
  "chat_message_reactions",
  "chat_message_mentions",
  "report_chat_members",
  "conversation_mutes",
  "conversation_hides",
  "report_message_forwards",
  "chat_groups",
  "chat_group_members",
  "chat_group_bans",
  "chat_polls",
  "chat_poll_options",
  "chat_poll_votes",
  "volunteer_hours",
  "user_jurisdiction_hours",
  "posts",
  "post_likes",
  "post_saves",
  "post_mentions",
  "cleanup_bans",
  "cleanup_guests",
  "guest_otps",
  "sms_opt_outs",
  "volunteer_hours_audit",
  "media_reap_tombstones",
  "cleanup_slots",
  "cleanup_slot_claims",
  "service_hours_certificates",
  "organizations",
  "organization_members",
  "organization_invites",
  "org_verifications",
  "event_consents",
  "cleanup_team_invites",
  "cleanup_ticket_types",
  "cleanup_registrations",
  "cleanup_registration_seats",
  "cleanup_waitlist",
  "cleanup_questions",
  "cleanup_answers",
  "cleanup_pages",
  "cleanup_page_media",
  "broadcasts",
  "broadcast_deliveries",
  "broadcast_unsubscribes",
  "cleanup_broadcast_mutes",
  "email_suppressions",
  "event_metrics_daily",
  "host_exports",
  "org_stripe_accounts",
  "org_payouts",
  "user_verification",
  "org_donation_settings",
  "org_donation_agreement_changes",
  "org_eligibility",
  "org_eligibility_checks",
  "eligibility_source_revisions",
  "donations",
  "donation_refunds",
  "donation_disputes",
  "donation_reconciliation_runs",
  "stripe_events",
  "legal_documents",
  "consent_records",
] as const

const FOREIGN_TABLES = new Set([
  "_civfix_migrations",
  "spatial_ref_sys",
])

const DROPPED_TABLES = [
  "report_discussion_messages",
  "report_follows",
  "report_message_mentions",
  "report_message_reactions",
  "report_message_user_mentions",
] as const

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
    expect(undeclared.sort()).toEqual([])
    expect([...owned].sort()).toEqual([...EXPECTED_TABLES].sort())
  })

  it("the Drizzle mirror barrel declares exactly the same tables as the hand SQL", async () => {
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
    const rows = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'reports' AND indexname = 'reports_idempotency_key_key'
    `
    expect(rows.length).toBe(1)

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
    const idx = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_email_key'
    `
    expect(idx.length).toBe(1)

    await h.sql`INSERT INTO users (display_name) VALUES ('No Email A')`
    await h.sql`INSERT INTO users (display_name) VALUES ('No Email B')`

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
      expect(def?.toLowerCase()).toContain("using gist")
    }
  })

  it("declares chat_messages as a RANGE-partitioned table", async () => {
    const rows = await h.sql<{ partstrat: string }[]>`
      SELECT partstrat FROM pg_partitioned_table
      WHERE partrelid = 'public.chat_messages'::regclass
    `
    expect(rows.length).toBe(1)
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
    await expect(
      h.sql`INSERT INTO dm_threads (user_lo, user_hi) VALUES (${lo}, ${hi})`,
    ).rejects.toThrow()
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
    await expect(
      h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${a}, ${b})`,
    ).rejects.toThrow()
    await expect(
      h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${a}, ${a})`,
    ).rejects.toThrow()
  })
})

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
    await h.sql`
      INSERT INTO gov_claims (name, method, status) VALUES ('Valid Claim', 'email', 'pending')
    `
    await expect(
      h.sql`INSERT INTO gov_claims (name, method, status) VALUES ('Bad Claim', 'email', 'bogus')`,
    ).rejects.toThrow()
  })

  it("enforces one default (NULL category) contact per geoid via the partial unique index", async () => {
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES ('TEST07', 'Test City', 'place', 1,
              ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))'), 4326))
      ON CONFLICT (geoid) DO NOTHING
    `
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES ('TEST07', NULL, 'a@x.gov')`
    await expect(
      h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES ('TEST07', NULL, 'b@x.gov')`,
    ).rejects.toThrow()
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES ('TEST07', 'trash', 'c@x.gov')`
  })
})

describe.skipIf(!pg)("schema (0061): users.show_volunteer_hours is a NULLable tri-state", () => {
  const h = pg as PgHarness

  it("is boolean, NULLable, and carries NO column default", async () => {
    const rows = await h.sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'show_volunteer_hours'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]?.data_type).toBe("boolean")
    expect(rows[0]?.is_nullable).toBe("YES")
    expect(rows[0]?.column_default).toBeNull()
  })

  it("a fresh user reads the column back as NULL (never chosen), not as a default", async () => {
    const ins = await h.sql<{ show_volunteer_hours: boolean | null }[]>`
      INSERT INTO users (display_name) VALUES ('Hours Tri-State Check')
      RETURNING show_volunteer_hours
    `
    expect(ins.length).toBe(1)
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


describe.skipIf(!pg)("schema (0167): cleanup_slots carries an optional time window", () => {
  const h = pg as PgHarness

  async function newSlotHost(): Promise<string> {
    const id = randomUUID()
    const [host] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Slot Window Host') RETURNING id
    `
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${id}, ${host!.id}, 'site', 'Window sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), now() + interval '7 days', 'upcoming'
      )
    `
    return id
  }

  it("added starts_at and ends_at as NULLable timestamptz with no default", async () => {
    const rows = await h.sql<
      { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cleanup_slots'
        AND column_name IN ('starts_at', 'ends_at')
      ORDER BY column_name
    `
    expect(rows.map((r) => r.column_name)).toEqual(["ends_at", "starts_at"])
    for (const row of rows) {
      expect(row.data_type).toBe("timestamp with time zone")
      expect(row.is_nullable).toBe("YES")
      expect(row.column_default).toBeNull()
    }
  })

  it("enforces cleanup_slots_window_chk: both-or-neither, and ends_at after starts_at", async () => {
    const cleanupId = await newSlotHost()
    const start = new Date(Date.now() + 8 * 86_400_000)
    const end = new Date(start.getTime() + 3_600_000)

    await h.sql`
      INSERT INTO cleanup_slots (cleanup_id, title, starts_at, ends_at)
      VALUES (${cleanupId}, 'Whole event', NULL, NULL)
    `
    await h.sql`
      INSERT INTO cleanup_slots (cleanup_id, title, starts_at, ends_at)
      VALUES (${cleanupId}, 'Morning shift', ${start}, ${end})
    `
    for (const [startsAt, endsAt] of [
      [start, null],
      [null, end],
      [end, start],
      [start, start],
    ] as [Date | null, Date | null][]) {
      await expect(
        h.sql`
          INSERT INTO cleanup_slots (cleanup_id, title, starts_at, ends_at)
          VALUES (${cleanupId}, ${`Bad ${randomUUID().slice(0, 8)}`}, ${startsAt}, ${endsAt})
        `,
      ).rejects.toMatchObject({ code: "23514" })
    }
  })

  it("swapped the title index for the (cleanup, title, window) one", async () => {
    const rows = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'cleanup_slots'
        AND indexname IN (
          'cleanup_slots_cleanup_title_uidx',
          'cleanup_slots_cleanup_title_window_uidx'
        )
    `
    expect(rows.map((r) => r.indexname)).toEqual(["cleanup_slots_cleanup_title_window_uidx"])
  })

  it("keys uniqueness on the window, so the same title at two times coexists", async () => {
    const cleanupId = await newSlotHost()
    const start = new Date(Date.now() + 8 * 86_400_000)
    const end = new Date(start.getTime() + 3_600_000)
    const later = new Date(end.getTime() + 3_600_000)

    await h.sql`
      INSERT INTO cleanup_slots (cleanup_id, title, starts_at, ends_at)
      VALUES (${cleanupId}, 'Sweep', ${start}, ${end})
    `
    await h.sql`
      INSERT INTO cleanup_slots (cleanup_id, title, starts_at, ends_at)
      VALUES (${cleanupId}, 'SWEEP', ${end}, ${later})
    `
    await expect(
      h.sql`
        INSERT INTO cleanup_slots (cleanup_id, title, starts_at, ends_at)
        VALUES (${cleanupId}, 'sweep', ${start}, ${end})
      `,
    ).rejects.toMatchObject({ code: "23505" })
    await h.sql`
      INSERT INTO cleanup_slots (cleanup_id, title) VALUES (${cleanupId}, 'Sweep')
    `
    await expect(
      h.sql`INSERT INTO cleanup_slots (cleanup_id, title) VALUES (${cleanupId}, 'SWEEP')`,
    ).rejects.toMatchObject({ code: "23505" })
  })
})

interface MirroredCheck {
  table: string
  column: string
  mirror: readonly string[]
  omitted?: readonly string[]
  note?: string
}

const MIRRORED_CHECKS: readonly MirroredCheck[] = [
  { table: "media_assets", column: "purpose", mirror: schema.MEDIA_PURPOSE_VALUES },
  { table: "cleanups", column: "event_kind", mirror: schema.EVENT_KIND_VALUES },
  { table: "chat_group_members", column: "role", mirror: schema.GROUP_MEMBER_ROLE_VALUES },
  { table: "cleanup_guests", column: "channel", mirror: schema.GUEST_CONTACT_CHANNEL_VALUES },
  { table: "guest_otps", column: "channel", mirror: schema.GUEST_CONTACT_CHANNEL_VALUES },
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
  { table: "cleanups", column: "visibility", mirror: schema.EVENT_VISIBILITY_VALUES },
  { table: "organizations", column: "verified_status", mirror: schema.ORG_VERIFICATION_STATUS_VALUES },
  { table: "organizations", column: "verified_kind", mirror: schema.ORG_VERIFICATION_KIND_VALUES },
  { table: "organization_members", column: "role", mirror: schema.ORGANIZATION_MEMBER_ROLE_VALUES },
  { table: "organization_invites", column: "role", mirror: schema.ORGANIZATION_INVITE_ROLE_VALUES },
  { table: "organization_invites", column: "status", mirror: schema.ORGANIZATION_INVITE_STATUS_VALUES },
  { table: "org_verifications", column: "status", mirror: schema.ORG_VERIFICATION_STATUS_VALUES },
  { table: "org_verifications", column: "kind", mirror: schema.ORG_VERIFICATION_KIND_VALUES },
  { table: "event_consents", column: "subject_type", mirror: schema.EVENT_CONSENT_SUBJECT_TYPE_VALUES },
  { table: "cleanup_team_invites", column: "role", mirror: schema.EVENT_TEAM_ROLE_VALUES },
  { table: "cleanup_team_invites", column: "status", mirror: schema.EVENT_TEAM_INVITE_STATUS_VALUES },
  { table: "cleanup_ticket_types", column: "visibility", mirror: schema.TICKET_TYPE_VISIBILITY_VALUES },
  { table: "cleanup_registrations", column: "status", mirror: schema.REGISTRATION_STATUS_VALUES },
  { table: "cleanup_registrations", column: "source", mirror: schema.REGISTRATION_SOURCE_VALUES },
  { table: "cleanup_registration_seats", column: "status", mirror: schema.SEAT_STATUS_VALUES },
  { table: "cleanup_registration_seats", column: "checkin_method", mirror: schema.CHECKIN_METHOD_VALUES },
  { table: "cleanup_waitlist", column: "status", mirror: schema.WAITLIST_STATUS_VALUES },
  { table: "cleanup_questions", column: "kind", mirror: schema.EVENT_QUESTION_KIND_VALUES },
  { table: "cleanup_pages", column: "status", mirror: schema.EVENT_PAGE_STATUS_VALUES },
  { table: "cleanup_pages", column: "theme_accent", mirror: schema.THEME_ACCENT_VALUES },
  { table: "broadcasts", column: "kind", mirror: schema.BROADCAST_KIND_VALUES },
  { table: "broadcasts", column: "status", mirror: schema.BROADCAST_STATUS_VALUES },
  { table: "broadcast_deliveries", column: "channel", mirror: schema.BROADCAST_CHANNEL_VALUES },
  { table: "broadcast_deliveries", column: "status", mirror: schema.DELIVERY_STATUS_VALUES },
  { table: "broadcast_deliveries", column: "recipient_kind", mirror: schema.BROADCAST_RECIPIENT_KIND_VALUES },
  {
    table: "broadcast_deliveries",
    column: "suppression_reason",
    mirror: schema.DELIVERY_SUPPRESSION_REASON_VALUES,
  },
  { table: "broadcast_deliveries", column: "failure_kind", mirror: schema.DELIVERY_FAILURE_KIND_VALUES },
  { table: "broadcast_unsubscribes", column: "scope", mirror: schema.UNSUBSCRIBE_SCOPE_VALUES },
  { table: "broadcast_unsubscribes", column: "reason", mirror: schema.UNSUBSCRIBE_REASON_VALUES },
  { table: "email_suppressions", column: "reason", mirror: schema.EMAIL_SUPPRESSION_REASON_VALUES },
  { table: "host_exports", column: "kind", mirror: schema.HOST_EXPORT_KIND_VALUES },
  { table: "host_exports", column: "status", mirror: schema.HOST_EXPORT_STATUS_VALUES },
  { table: "org_stripe_accounts", column: "onboarding_state", mirror: schema.ORG_PAYMENTS_STATE_VALUES },
  { table: "org_payouts", column: "status", mirror: schema.PAYOUT_STATUS_VALUES },
  {
    table: "user_verification",
    column: "status",
    mirror: schema.VERIFICATION_STATUS_VALUES,
    omitted: ["unverified"],
  },
  {
    table: "org_donation_settings",
    column: "disabled_reason",
    mirror: schema.DONATIONS_DISABLED_REASON_VALUES,
  },
  {
    table: "org_donation_agreement_changes",
    column: "change_kind",
    mirror: schema.AGREEMENT_CHANGE_KIND_VALUES,
  },
  { table: "org_eligibility", column: "verdict", mirror: schema.ELIGIBILITY_VERDICT_VALUES },
  { table: "org_eligibility", column: "ein_source", mirror: schema.EIN_SOURCE_VALUES },
  { table: "org_eligibility_checks", column: "source", mirror: schema.ELIGIBILITY_SOURCE_VALUES },
  {
    table: "org_eligibility_checks",
    column: "verdict_contribution",
    mirror: schema.ELIGIBILITY_VERDICT_CONTRIBUTION_VALUES,
  },
  { table: "eligibility_source_revisions", column: "source", mirror: schema.ELIGIBILITY_SOURCE_VALUES },
  { table: "donations", column: "status", mirror: schema.DONATION_STATUS_VALUES },
  { table: "donations", column: "dispute_state", mirror: schema.DONATION_DISPUTE_STATE_VALUES },
  {
    table: "donation_refunds",
    column: "app_fee_refund_state",
    mirror: schema.APP_FEE_REFUND_STATE_VALUES,
  },
  { table: "donation_disputes", column: "state", mirror: schema.DONATION_DISPUTE_STATE_VALUES },
  { table: "donation_reconciliation_runs", column: "status", mirror: schema.RECONCILIATION_STATUS_VALUES },
  { table: "stripe_events", column: "scope", mirror: schema.STRIPE_EVENT_SCOPE_VALUES },
  { table: "legal_documents", column: "type", mirror: schema.LEGAL_DOCUMENT_TYPE_VALUES },
  { table: "consent_records", column: "subject_kind", mirror: schema.CONSENT_SUBJECT_KIND_VALUES },
  { table: "consent_records", column: "surface", mirror: schema.CONSENT_SURFACE_VALUES },
  { table: "chat_groups", column: "kind", mirror: ["group", "channel"] },
  { table: "chat_groups", column: "visibility", mirror: ["private", "public"] },
  { table: "volunteer_hours", column: "source", mirror: ["report", "event", "manual"] },
  { table: "reports", column: "verification_verdict", mirror: ["approved", "rejected"] },
  { table: "broadcast_unsubscribes", column: "subject_kind", mirror: ["user", "guest"] },
]

const CONSTRAINT_QUALIFIERS = /(?:\s+NO INHERIT)?(?:\s+NOT VALID)?$/
const VALUE_SET_CHECK = /^CHECK \(\((\w+) = ANY \(ARRAY\[(.+)\]\)\)\)$/
const NULLABLE_VALUE_SET_CHECK =
  /^CHECK \(\(\((\w+) IS NULL\) OR \(\1 = ANY \(ARRAY\[(.+)\]\)\)\)\)$/

function parseValueSet(def: string): { column: string; values: string[] } | null {
  const expression = def.replace(CONSTRAINT_QUALIFIERS, "")
  const m = VALUE_SET_CHECK.exec(expression) ?? NULLABLE_VALUE_SET_CHECK.exec(expression)
  if (m === null) return null
  const values = [...m[2]!.matchAll(/'((?:[^']|'')*)'::text/g)].map((x) => x[1]!.replace(/''/g, "'"))
  return { column: m[1]!, values }
}

describe.skipIf(!pg)("schema: enum mirrors match the DDL CHECK constraints", () => {
  const h = pg as PgHarness

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
      if (parsed === null) continue
      const key = `${r.tbl}.${parsed.column}`
      const prior = out.get(key)
      out.set(key, prior === undefined ? parsed.values : prior.filter((v) => parsed.values.includes(v)))
    }
    return out
  }

  it("every value-set CHECK in the database is DECLARED in MIRRORED_CHECKS", async () => {
    const declared = new Set(MIRRORED_CHECKS.map((c) => `${c.table}.${c.column}`))
    const undeclared = [...(await dbValueSets()).keys()].filter((k) => !declared.has(k))
    expect(undeclared.sort()).toEqual([])
  })

  it("every DECLARED CHECK actually exists in the database", async () => {
    const inDb = await dbValueSets()
    const missing = MIRRORED_CHECKS.map((c) => `${c.table}.${c.column}`).filter((k) => !inDb.has(k))
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
    for (const purpose of schema.MEDIA_PURPOSE_VALUES) {
      const rows = await h.sql<{ purpose: string }[]>`
        INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose)
        VALUES (gen_random_uuid(), 'image', ${`uploads/purpose-${purpose}`}, 'ready', ${purpose})
        RETURNING purpose
      `
      expect(rows[0]!.purpose).toBe(purpose)
    }
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
    await expect(
      h.sql`INSERT INTO user_verification (user_id, status) VALUES (${u!.id}, 'unverified')`,
    ).rejects.toMatchObject({ code: "23514" })
    for (const status of ["pending", "verified", "rejected"]) {
      const rows = await h.sql<{ status: string }[]>`
        INSERT INTO user_verification (user_id, status) VALUES (${u!.id}, ${status})
        ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status
        RETURNING status
      `
      expect(rows[0]!.status).toBe(status)
    }
  })

  it("every Drizzle-mirror index exists in the live database (F152 parity)", async () => {
    const mirrorIndexNames = new Set<string>()
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue
      for (const idx of getTableConfig(value).indexes) {
        if (idx.config.name) mirrorIndexNames.add(idx.config.name)
      }
    }
    const liveRows = await h.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `
    const liveIndexNames = new Set(liveRows.map((r) => r.indexname))
    const missing = [...mirrorIndexNames].filter((n) => !liveIndexNames.has(n)).sort()
    expect(missing, "mirror-declared indexes with no backing migration").toEqual([])

    for (const name of [
      "abuse_flags_worker_open_subject_reason_key",
      "volunteer_hours_user_created_idx",
    ]) {
      expect(mirrorIndexNames.has(name), `mirror missing ${name}`).toBe(true)
      expect(liveIndexNames.has(name), `db missing ${name}`).toBe(true)
    }
  })

  it("notifications_feed_idx predicate equals FEED_HIDDEN_NOTIFICATION_TYPES (F089)", async () => {
    const rows = await h.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'notifications' AND indexname = 'notifications_feed_idx'
    `
    expect(rows.length).toBe(1)
    const indexdef = rows[0]!.indexdef
    const arrayMatch = /ARRAY\[([^\]]*)\]/i.exec(indexdef)
    expect(arrayMatch, `no ARRAY[...] predicate in ${indexdef}`).not.toBeNull()
    const literals = [...arrayMatch![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(literals.slice().sort()).toEqual([...FEED_HIDDEN_NOTIFICATION_TYPES].slice().sort())
  })
})

afterAll(async () => {
  if (pg) await pg.teardown()
})
