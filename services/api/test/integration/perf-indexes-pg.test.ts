// Each statement below is the shape the repository sends, with its values bound as parameters, so the
// check exercises the partial-predicate and expression matching the planner really performs (a strict
// `expr = $1` implying `expr IS NOT NULL`, the OR arms of the erasure revoke, lower(jsonb ->> text)).
// Sequential scans are disabled so a tiny test table cannot hide a missing or unmatchable index.

import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedFollowEdge, testHandle, withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"

const pg = await withPg()

const INDEXES: Array<{ table: string; name: string; def: RegExp }> = [
  {
    table: "follows_people",
    name: "follows_people_followee_created_idx",
    def: /\(followee_id, created_at DESC, follower_id DESC\)$/,
  },
  {
    table: "cleanup_team_invites",
    name: "cleanup_team_invites_inviter_pending_idx",
    def: /\(invited_by\) WHERE \(status = 'pending'::text\)$/,
  },
  {
    table: "moderation_items",
    name: "moderation_items_meta_user_id_idx",
    def: /\(\(\(meta -> 'user'::text\) ->> 'id'::text\)\) WHERE \(\(\(meta -> 'user'::text\) ->> 'id'::text\) IS NOT NULL\)$/,
  },
  {
    table: "moderation_items",
    name: "moderation_items_meta_reporter_user_id_idx",
    def: /\(\(meta ->> 'reporterUserId'::text\)\) WHERE \(\(meta ->> 'reporterUserId'::text\) IS NOT NULL\)$/,
  },
  {
    table: "mail_events",
    name: "mail_events_bounced_recipient_idx",
    def: /\(lower\(\(meta ->> 'failedRecipient'::text\)\)\) WHERE \(type = 'bounced'::text\)$/,
  },
  {
    table: "cleanup_timeline",
    name: "cleanup_timeline_flag_state_idx",
    def: /\(cleanup_id, created_at DESC, id DESC\) WHERE \(kind = ANY \(ARRAY\['flag'::text, 'unflag'::text\]\)\)$/,
  },
  {
    table: "push_tokens",
    name: "push_tokens_active_token_idx",
    def: /\(token\) WHERE \(revoked_at IS NULL\)$/,
  },
  {
    table: "broadcast_deliveries",
    name: "broadcast_deliveries_broadcast_created_idx",
    def: /\(broadcast_id, created_at DESC, id DESC\)$/,
  },
]

describe.skipIf(!pg)("performance indexes 0186-0192 (integration)", () => {
  let h: PgHarness
  let captured: { query: string; params: unknown[] } | null = null
  let debugSql: Sql

  beforeAll(() => {
    h = pg as PgHarness
    debugSql = postgres(h.uri, {
      max: 1,
      onnotice: () => {},
      debug: (_conn: number, query: string, params: unknown[]) => {
        if (query.includes("JOIN follows_people f")) captured = { query, params }
      },
    })
  })

  afterAll(async () => {
    await debugSql.end()
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  async function planOf(statement: string, params: unknown[]): Promise<string> {
    return await h.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (COSTS OFF) ${statement}`,
        params as never[],
      )
      return rows.map((row) => row["QUERY PLAN"]).join("\n")
    })
  }

  it.each(INDEXES)("$table carries $name", async ({ table, name, def }) => {
    const rows = await h.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${table} AND indexname = ${name}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toMatch(def)
  })

  it("serves a followers page from the followee keyset index", async () => {
    const target = await newUser("Followee")
    for (let i = 0; i < 40; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, i))
      await seedFollowEdge(h.sql, await newUser(`Follower ${i}`), target, at)
    }
    await h.sql`ANALYZE follows_people`

    const repo = makeDrizzleSocialRepository(debugSql)
    const first = await repo.listFollowers({ id: target, viewerId: null, cursor: null, limit: 5 })
    captured = null
    await repo.listFollowers({ id: target, viewerId: null, cursor: first.nextCursor, limit: 5 })

    expect(captured, "the followers query was not captured").not.toBeNull()
    const plan = await planOf(captured!.query, captured!.params)
    expect(plan).toContain("follows_people_followee_created_idx")
  })

  it("lets erasure BitmapOr both arms of the pending event-team invite revoke", async () => {
    const plan = await planOf(
      `UPDATE cleanup_team_invites
          SET status = 'revoked', invited_email = NULL, email_scrubbed_at = now()
        WHERE status = 'pending' AND (invited_user_id = $1 OR invited_by = $1)`,
      [randomUUID()],
    )
    expect(plan).toContain("cleanup_team_invites_inviter_pending_idx")
    expect(plan).toContain("cleanup_team_invites_invitee_pending_idx")
  })

  it("serves both erasure moderation scrubs from the partial expression indexes", async () => {
    for (let i = 0; i < 50; i++) {
      await h.sql`
        INSERT INTO moderation_items (kind, subject_type, subject_id, meta)
        VALUES ('pattern', 'user', ${randomUUID()},
                ${h.sql.json({ user: { id: randomUUID() }, reporterUserId: randomUUID() })})
      `
    }
    await h.sql`ANALYZE moderation_items`

    const byUser = await planOf(
      `UPDATE moderation_items SET meta = jsonb_set(meta, '{user,name}', to_jsonb($2::text), false)
        WHERE meta->'user'->>'id' = $1`,
      [randomUUID(), "Deleted User"],
    )
    expect(byUser).toContain("moderation_items_meta_user_id_idx")

    const byReporter = await planOf(
      `UPDATE moderation_items SET meta = jsonb_set(meta, '{desc}', to_jsonb(''::text), false)
        WHERE meta->>'reporterUserId' = $1`,
      [randomUUID()],
    )
    expect(byReporter).toContain("moderation_items_meta_reporter_user_id_idx")
  })

  it("serves the legacy-contact bounce probe from the recipient expression index", async () => {
    for (let i = 0; i < 200; i++) {
      await h.sql`
        INSERT INTO mail_events (type, meta)
        VALUES ('bounced', ${h.sql.json({ failedRecipient: `Other${i}@Example.org` })})
      `
    }
    await h.sql`ANALYZE mail_events`

    const plan = await planOf(
      `SELECT 1 FROM mail_events me
        WHERE me.type = 'bounced'
          AND lower(me.meta->>'failedRecipient') = lower($1)
          AND me.created_at > COALESCE($2::timestamptz, '-infinity'::timestamptz)`,
      ["Clerk@City.gov", null],
    )
    expect(plan).toContain("mail_events_bounced_recipient_idx")
  })

  it("answers the event flag-state probe from the flag/unflag index", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await seedCleanup(h.sql, { organizerUserId: organizer })
    for (let i = 0; i < 200; i++) {
      await h.sql`
        INSERT INTO cleanup_timeline (cleanup_id, kind, created_at)
        VALUES (${cleanupId}, 'note', now() - make_interval(mins => ${i}))
      `
    }
    await h.sql`ANALYZE cleanup_timeline`

    const plan = await planOf(
      `SELECT ct.kind = 'flag' FROM cleanup_timeline ct
        WHERE ct.cleanup_id = $1 AND ct.kind IN ('flag', 'unflag')
        ORDER BY ct.created_at DESC, ct.id DESC
        LIMIT 1`,
      [cleanupId],
    )
    expect(plan).toContain("cleanup_timeline_flag_state_idx")
    expect(plan).not.toContain("Sort")
  })

  it("prunes invalid push tokens through the active-token index", async () => {
    const plan = await planOf(
      `UPDATE push_tokens SET revoked_at = now() WHERE token IN ($1, $2) AND revoked_at IS NULL`,
      ["token-a", "token-b"],
    )
    expect(plan).toContain("push_tokens_active_token_idx")
  })

  it("pages a broadcast's deliveries as an index range with no sort", async () => {
    const plan = await planOf(
      `SELECT id FROM broadcast_deliveries
        WHERE broadcast_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT 51`,
      [randomUUID(), "2026-01-01T00:00:00Z", randomUUID()],
    )
    expect(plan).toContain("broadcast_deliveries_broadcast_created_idx")
    expect(plan).not.toContain("Sort")
  })
})
