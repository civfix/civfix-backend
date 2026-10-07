/**
 * A keyset cursor is caller-controlled text, and the keyset lists bind its instant as `::timestamptz`.
 * JS Date rolls impossible calendar fields forward (Feb 30 becomes Mar 2) and accepts offsets Postgres
 * refuses, so validating with Date alone let a forged cursor reach Postgres, which raised 22008/22009:
 * not an AppError, so a 500 on public lists. A forged cursor must degrade to the first page instead.
 */

import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { parseKeysetCursor } from "../../src/db/cursor-helpers.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"

const ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e01"
const VIEWER = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e03"
const FEB_30 = "2026-02-30T00:00:00Z"

const FORGED_INSTANTS = [
  ["February 30", FEB_30],
  ["February 29 in a non-leap year", "2027-02-29T12:00:00.000Z"],
  ["a +16:00 offset", "2026-09-01T10:00:00+16:00"],
  ["a -16:00 offset", "2026-09-01T10:00:00.5-16:00"],
  ["an offset with 60 minutes", "2026-09-01T10:00:00+05:60"],
  ["hour 24", "2026-09-01T24:00:00Z"],
  ["April 31", "2026-04-31T08:00:00.123456Z"],
] as const

describe("parseKeysetCursor refuses instants Postgres would not accept", () => {
  it.each(FORGED_INSTANTS)("%s gives the first page", (_label, instant) => {
    expect(parseKeysetCursor(`${instant}|${ID}`)).toBeNull()
    expect(parseKeysetCursor(instant)).toBeNull()
    expect(parseKeysetCursor(`${instant}|${ID}`, { requireUuid: true })).toBeNull()
  })
})

describe("parseKeysetCursor rebuilds the bound instant from the validated one", () => {
  it("keeps a microsecond UTC cursor unchanged", () => {
    const parsed = parseKeysetCursor(`2026-09-01T10:00:00.123456Z|${ID}`)
    expect(parsed?.atText).toBe("2026-09-01T10:00:00.123456Z")
    expect(parsed?.at.toISOString()).toBe("2026-09-01T10:00:00.123Z")
  })

  it("keeps a legacy toISOString cursor unchanged", () => {
    expect(parseKeysetCursor(`2026-09-01T10:00:00.123Z|${ID}`)?.atText).toBe(
      "2026-09-01T10:00:00.123Z",
    )
    expect(parseKeysetCursor("2026-09-01T10:00:00.000Z")?.atText).toBe("2026-09-01T10:00:00.000Z")
  })

  it("keeps a cursor with no fraction unchanged", () => {
    expect(parseKeysetCursor(`2026-09-01T10:00:00Z|${ID}`)?.atText).toBe("2026-09-01T10:00:00Z")
  })

  it("converts an offset cursor to UTC and keeps every fraction digit", () => {
    const parsed = parseKeysetCursor(`2026-03-01T01:30:00.000007+02:00|${ID}`)
    expect(parsed?.atText).toBe("2026-02-28T23:30:00.000007Z")
    expect(parsed?.at.toISOString()).toBe("2026-02-28T23:30:00.000Z")
  })

  it("accepts the widest offset Postgres accepts", () => {
    expect(parseKeysetCursor(`2026-09-01T10:00:00-15:59|${ID}`)?.atText).toBe(
      "2026-09-02T01:59:00Z",
    )
    expect(parseKeysetCursor(`2028-02-29T10:00:00+15:59|${ID}`)?.atText).toBe(
      "2028-02-28T18:01:00Z",
    )
  })
})

describe("keyset lists answer a forged cursor with the first page", () => {
  function expectNoAnchor(ctl: FakeSqlControl, match: RegExp): void {
    const stmt = [...ctl.statements].reverse().find((s) => match.test(s.sql))
    expect(stmt).toBeDefined()
    expect(stmt?.sql).not.toContain("::timestamptz")
    expect(stmt?.values).not.toContain(FEB_30)
  }

  const forged = `${FEB_30}|${ID}`

  it("report search", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzleReportRepository(ctl.sql as unknown as Sql)
    await repo.searchReports({ q: null, categories: null, types: null, limit: 1, cursor: forged })
    expectNoAnchor(ctl, /FROM reports r/)
  })

  it("my reports", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzleReportRepository(ctl.sql as unknown as Sql)
    await repo.listMyReports(VIEWER, forged, 1)
    expectNoAnchor(ctl, /FROM reports\s+WHERE reporter_user_id/)
  })

  it("notifications", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzleNotificationRepository(ctl.sql as unknown as Sql)
    await repo.listNotifications(VIEWER, forged, 1)
    expectNoAnchor(ctl, /FROM notifications/)
  })

  it("public feed and replies", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzlePostRepository(ctl.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })
    await repo.publicFeed({ filter: "all", limit: 1, cursor: forged })
    expectNoAnchor(ctl, /FROM posts p\s+WHERE p\.deleted_at IS NULL\s+AND p\.reply_to_id IS NULL/)
    await repo.listReplies(ID, {
      viewerId: VIEWER,
      focalAuthorId: VIEWER,
      limit: 1,
      cursor: forged,
    })
    expectNoAnchor(ctl, /WHERE p\.reply_to_id = \? AND p\.deleted_at IS NULL/)
  })

  it("blocked users", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzleBlocksRepository(ctl.sql as unknown as Sql)
    await repo.listBlocked(VIEWER, { cursor: forged, limit: 1 })
    expectNoAnchor(ctl, /FROM user_blocks b\s+JOIN users u/)
  })
})

describe("GET /v1/reports/search with a forged cursor", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it("answers 200 with the first page instead of a 500", async () => {
    const pin = {
      id: ID,
      lng: -118.24,
      lat: 34.05,
      category: "trash",
      type: "dump",
      status: "published",
      title: "Mattress on the curb",
      description: null,
      addr: null,
      reference_code: "CF-000001",
      thumb_key: null,
      r2_key: null,
      created_at: new Date("2026-09-01T10:00:00.123Z"),
      cursor_at: "2026-09-01T10:00:00.123456Z",
    }
    const db = makeFakeSql([
      {
        match: /FROM reports r/,
        rows: (values) => {
          if (values.includes(FEB_30)) {
            throw Object.assign(new Error(`date/time field value out of range: "${FEB_30}"`), {
              code: "22008",
            })
          }
          return [pin]
        },
      },
    ])
    const env = loadEnv({ NODE_ENV: "test" })
    const container = {
      ...makeContainer(env),
      getDb: () => ({ sql: db.sql }),
    } as unknown as Container
    app = await makeServer({ env, container })

    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/search?cursor=${encodeURIComponent(`${FEB_30}|${ID}`)}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([ID])
    const search = db.statements.find((s) => /FROM reports r/.test(s.sql))
    expect(search?.sql).not.toContain("::timestamptz")
  })
})
