/**
 * Host broadcast keyset paging over rows that share one statement's now() (Docker-gated; CI runs it).
 * plan() inserts every delivery of a broadcast in one statement, so a cursor built from the driver's
 * millisecond Date skipped the rest of that instant on the newest-first delivery list.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { parseKeysetCursor } from "../../src/db/cursor-helpers.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"

const pg = await withPg()

const DELIVERIES_IN_ONE_STATEMENT = 3
const PAGE_GUARD = 10

describe.skipIf(!pg)(
  "host broadcast keyset cursors keep microsecond precision (integration)",
  () => {
    let h: PgHarness

    beforeAll(() => {
      h = pg as PgHarness
    })

    afterAll(async () => {
      await h.teardown()
    })

    async function newUser(name: string): Promise<string> {
      const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id`
      return row!.id
    }

    it("pages through every delivery one statement inserted exactly once", async () => {
      const host = await newUser("Keyset Host")
      const cleanupId = await seedCleanup(h.sql, {
        organizerUserId: host,
        title: "Beach sweep",
        lng: -118.25,
        lat: 34.05,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000),
      })
      const repo = makeDrizzleBroadcastRepository(h.sql)
      const broadcast = await repo.create({
        cleanupId,
        createdBy: host,
        kind: "host_broadcast",
        subject: "Bring gloves",
        bodyMd: "See you there.",
        segment: { kind: "all_registered" },
        channels: ["inapp"],
      })
      const members = await Promise.all(
        Array.from({ length: DELIVERIES_IN_ONE_STATEMENT }, (_, i) => newUser(`Member ${i}`)),
      )
      await repo.insertDeliveries(
        members.map((userId) => ({
          broadcastId: broadcast.id,
          chunkNo: 0,
          recipientKind: "member" as const,
          userId,
          guestId: null,
          channel: "inapp" as const,
        })),
      )
      const stamps = await h.sql<{ n: number }[]>`
      SELECT count(DISTINCT created_at)::int AS n
        FROM broadcast_deliveries WHERE broadcast_id = ${broadcast.id}
    `
      expect(stamps[0]!.n).toBe(1)

      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < PAGE_GUARD; page++) {
        const rows = await repo.listDeliveries({
          broadcastId: broadcast.id,
          cursor: parseKeysetCursor(cursor, { direction: "desc" }),
          limit: 1,
        })
        const row = rows[0]
        if (row === undefined) break
        seen.push(row.id)
        cursor = `${row.cursorAt}|${row.id}`
      }
      expect(seen).toHaveLength(DELIVERIES_IN_ONE_STATEMENT)
      expect(new Set(seen).size).toBe(DELIVERIES_IN_ONE_STATEMENT)
    })

    it("answers not-found when suspending a soft-deleted host and writes no audit row", async () => {
      const userId = await newUser("Gone Host")
      await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`
      const repo = makeDrizzleBroadcastRepository(h.sql)
      const found = await repo.setHostMessagingSuspended(userId, true, {
        action: "host.messaging_suspended",
        actorId: null,
        target: `user:${userId}`,
      })
      expect(found).toBe(false)
      const audits = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE target = ${`user:${userId}`}
    `
      expect(audits[0]!.n).toBe(0)
    })
  },
)
