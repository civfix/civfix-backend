/**
 * Host CSV exports page their rows by keyset (Docker-gated; CI runs it). The first page once bound an
 * empty cursor as a uuid, so every roster, check-in and answers export failed before its first row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { HostExportKind } from "@civfix/contract"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostExportRepository } from "../../src/services/host/export-repository.drizzle.js"
import { makeHostExportService } from "../../src/services/host/export-service.js"
import { resetHostExportBuildersForTests } from "../../src/services/host/export-builders.js"
import {
  EXPORT_PAGE_SIZE,
  registerEventExportBuilders,
} from "../../src/services/host/host-export-builders.js"

const pg = await withPg()

// Two full pages and one more row: the cursor crosses two page boundaries.
const ATTENDEES = EXPORT_PAGE_SIZE * 2 + 1

describe.skipIf(!pg)("host exports page across keyset boundaries (integration)", () => {
  let h: PgHarness
  let cleanupId: string
  let hostId: string
  let registrationIds: string[]
  let seatIds: string[]
  const objects = new Map<string, Buffer>()

  beforeAll(async () => {
    h = pg as PgHarness
    const [host] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Export Host') RETURNING id`
    hostId = host!.id
    cleanupId = await seedCleanup(h.sql, { organizerUserId: hostId, title: "Export pages" })
    await h.sql`
      INSERT INTO cleanup_guests (cleanup_id, name, channel, email, manage_token_hash)
      SELECT ${cleanupId}, 'Guest ' || n, 'email', 'guest' || n || '@example.test', 'manage-' || n
        FROM generate_series(1, ${ATTENDEES}::int) AS n`
    const registrations = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_registrations (cleanup_id, guest_id)
      SELECT cleanup_id, id FROM cleanup_guests WHERE cleanup_id = ${cleanupId}
      RETURNING id`
    registrationIds = registrations.map((row) => row.id)
    const seats = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_registration_seats (cleanup_id, registration_id, seat_index, ticket_token_hash)
      SELECT cleanup_id, id, 0, 'token-' || id FROM cleanup_registrations WHERE cleanup_id = ${cleanupId}
      RETURNING id`
    seatIds = seats.map((row) => row.id)
    const [question] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_questions (cleanup_id, kind, prompt)
      VALUES (${cleanupId}, 'short_text', 'T-shirt size') RETURNING id`
    await h.sql`
      INSERT INTO cleanup_answers (cleanup_id, registration_id, question_id, value_text)
      SELECT cleanup_id, id, ${question!.id}, 'M' FROM cleanup_registrations WHERE cleanup_id = ${cleanupId}`

    resetHostExportBuildersForTests()
    registerEventExportBuilders(() => h.sql)
  })

  afterAll(async () => {
    resetHostExportBuildersForTests()
    await h.teardown()
  })

  async function exportFirstColumn(kind: HostExportKind): Promise<string[]> {
    const service = makeHostExportService({
      repo: makeDrizzleHostExportRepository(h.sql),
      storage: {
        put: (key, body) => {
          objects.set(key, Buffer.from(body))
          return Promise.resolve()
        },
        presignGet: (key) => Promise.resolve(`https://signed.example/${key}`),
        delete: (key) => {
          objects.delete(key)
          return Promise.resolve()
        },
      },
      config: { maxRows: ATTENDEES * 2, maxBytes: 64 * 1024 * 1024, ttlHours: 1 },
    })
    const created = await service.request({
      cleanupId,
      organizationId: null,
      requestedBy: hostId,
      kind,
      filters: undefined,
    })
    expect(await service.run(created.id)).toEqual({ status: "ready" })
    const ready = await service.get(created.id)
    expect(ready.rowCount).toBe(ATTENDEES)
    expect(ready.truncated).toBe(false)

    const lines = objects.get(ready.r2Key!)!.toString("utf8").trimEnd().split("\n")
    const [, ...rows] = lines.filter((line) => !line.startsWith('"# '))
    return rows.map((line) => line.slice(1, line.indexOf('"', 1)))
  }

  it("exports every registration on the roster once, in keyset order", async () => {
    const ids = await exportFirstColumn("roster")
    expect(ids).toHaveLength(ATTENDEES)
    expect(ids).toEqual([...registrationIds].sort())
  })

  it("exports every seat on the check-in sheet once", async () => {
    const ids = await exportFirstColumn("checkins")
    expect(ids).toHaveLength(ATTENDEES)
    expect([...ids].sort()).toEqual([...seatIds].sort())
  })

  it("exports every answer once", async () => {
    const ids = await exportFirstColumn("answers")
    expect(ids).toHaveLength(ATTENDEES)
    expect([...ids].sort()).toEqual([...registrationIds].sort())
  })
})
