/**
 * P4 Task 4.1 schema integration test (Docker-gated): migration 0047_chat_groups.sql against a live
 * PostGIS container (via withPg). Raw SQL only — no repos exist yet (they land in the following P4
 * tasks). Verifies the things only a real postgres can prove:
 *
 *   - chat_groups + chat_group_members exist, and the kind/visibility/role CHECKs reject bad values;
 *   - the swapped chat_messages_scope_chk is a true exactly-one-of-three on the PARTITIONED parent:
 *     a row with BOTH cleanup_id and group_id is rejected, a row with ONLY group_id inserts, and a
 *     row with NO scope at all is rejected;
 *   - the group-scoped parent indexes (created + partial pinned) exist.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"

const pg = await withPg()

describe.skipIf(!pg)("chat groups schema (0047, integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user and return its id. */
  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /** Insert a minimal group owned by a fresh user and return its id. */
  async function newGroup(name: string): Promise<string> {
    const ownerId = await newUser(`${name} owner`)
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id) VALUES (${name}, ${ownerId}) RETURNING id
    `
    return g!.id
  }

  /** Insert a minimal cleanup and return its id. */
  async function newCleanup(): Promise<string> {
    const organizerId = await newUser("Cleanup organizer")
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Scope-chk fixture",
    })
  }

  it("creates chat_groups and chat_group_members with sensible defaults", async () => {
    const groupId = await newGroup("Defaults group")
    const [g] = await h.sql<{ kind: string; visibility: string; description: string | null }[]>`
      SELECT kind, visibility, description FROM chat_groups WHERE id = ${groupId}
    `
    expect(g).toEqual({ kind: "group", visibility: "private", description: null })

    const userId = await newUser("Default member")
    const [m] = await h.sql<{ role: string; last_read_at: string | null }[]>`
      INSERT INTO chat_group_members (group_id, user_id) VALUES (${groupId}, ${userId})
      RETURNING role, last_read_at
    `
    expect(m).toEqual({ role: "member", last_read_at: null })
  })

  it("rejects bad kind / visibility / role values via the CHECK constraints", async () => {
    const ownerId = await newUser("Checks owner")
    await expect(
      h.sql`INSERT INTO chat_groups (name, owner_id, kind) VALUES ('Bad kind', ${ownerId}, 'broadcast')`,
    ).rejects.toThrow()
    await expect(
      h.sql`INSERT INTO chat_groups (name, owner_id, visibility) VALUES ('Bad vis', ${ownerId}, 'secret')`,
    ).rejects.toThrow()

    const groupId = await newGroup("Bad role group")
    const userId = await newUser("Bad role user")
    await expect(
      h.sql`INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${groupId}, ${userId}, 'moderator')`,
    ).rejects.toThrow()
  })

  it("chat_messages_scope_chk enforces exactly one of (cleanup_id, report_id, group_id)", async () => {
    const groupId = await newGroup("Scope group")
    const cleanupId = await newCleanup()
    const senderId = await newUser("Scope sender")

    // BOTH cleanup_id and group_id set -> two scopes -> rejected.
    await expect(
      h.sql`
        INSERT INTO chat_messages (cleanup_id, group_id, sender_id, body)
        VALUES (${cleanupId}, ${groupId}, ${senderId}, 'two scopes')
      `,
    ).rejects.toThrow(/chat_messages_scope_chk/)

    // ONLY group_id -> exactly one scope -> inserts.
    const [row] = await h.sql<{ id: string; group_id: string }[]>`
      INSERT INTO chat_messages (group_id, sender_id, body)
      VALUES (${groupId}, ${senderId}, 'hello group')
      RETURNING id, group_id
    `
    expect(row!.group_id).toBe(groupId)

    // NO scope at all -> zero scopes -> rejected.
    await expect(
      h.sql`INSERT INTO chat_messages (sender_id, body) VALUES (${senderId}, 'scopeless')`,
    ).rejects.toThrow(/chat_messages_scope_chk/)
  })

  it("declares the group-scoped parent indexes (created + partial pinned)", async () => {
    const rows = await h.sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'chat_messages'
        AND indexname IN ('chat_messages_group_created_idx', 'chat_messages_group_pinned_idx')
    `
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]))
    expect(byName.has("chat_messages_group_created_idx")).toBe(true)
    // The pinned twin must actually be PARTIAL (0046 rationale).
    expect(byName.get("chat_messages_group_pinned_idx")?.toLowerCase()).toContain(
      "where (pinned_at is not null)",
    )
  })
})
