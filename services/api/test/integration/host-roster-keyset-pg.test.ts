/**
 * Host roster keyset paging over registrations that share one transaction's now() (Docker-gated; CI
 * runs it). Everyone not yet checked in shares the epoch check-in key, so the checked-in sort places
 * itself inside that tie by registered_at; an anchor the driver cut to milliseconds skipped the rest of
 * the instant.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type { RegistrationRosterSort } from "@civfix/shared"

const pg = await withPg()

const REGISTRATIONS_IN_ONE_TX = 3
const PAGE_GUARD = 10

describe.skipIf(!pg)("host roster keyset cursors keep microsecond precision (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return row!.id
  }

  it.each<RegistrationRosterSort>(["checked_in_at_desc", "registered_at_desc"])(
    "%s pages through every registration of one transaction exactly once",
    async (sort) => {
      const host = await newUser("Roster Host")
      const cleanupId = await seedCleanup(h.sql, {
        organizerUserId: host,
        title: "Roster sweep",
        lng: -118.25,
        lat: 34.05,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000),
      })
      const members = await Promise.all(
        Array.from({ length: REGISTRATIONS_IN_ONE_TX }, (_, i) => newUser(`Member ${i}`)),
      )
      const written = await h.sql.begin(async (tx) => {
        const ids: string[] = []
        for (const userId of members) {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO cleanup_registrations (cleanup_id, user_id, party_size, status, source)
            VALUES (${cleanupId}, ${userId}, 1, 'registered', 'self')
            RETURNING id
          `
          ids.push(row!.id)
        }
        return ids
      })
      const stamps = await h.sql<{ n: number }[]>`
        SELECT count(DISTINCT registered_at)::int AS n
          FROM cleanup_registrations WHERE cleanup_id = ${cleanupId}
      `
      expect(stamps[0]!.n).toBe(1)

      const repo = makeDrizzleHostRegistrationRepository(h.sql)
      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < PAGE_GUARD; page++) {
        const res = await repo.listRoster({
          cleanupId,
          filter: "registered",
          ticketTypeId: null,
          slotId: null,
          sort,
          q: null,
          cursor,
          limit: 1,
          withTotal: false,
        })
        seen.push(...res.rows.map((row) => row.id))
        cursor = res.nextCursor
        if (cursor === null) break
      }
      expect(cursor).toBeNull()
      expect(seen).toHaveLength(REGISTRATIONS_IN_ONE_TX)
      expect(new Set(seen)).toEqual(new Set(written))
    },
  )
})
