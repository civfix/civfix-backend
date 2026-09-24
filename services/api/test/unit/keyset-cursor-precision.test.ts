/**
 * Time-keyset cursors must carry the column's full microsecond instant. postgres-js hands timestamptz back
 * as a JS Date (millisecond precision) and serializes a Date param with toISOString(), so a cursor built
 * from the Date skips every row in the anchor's millisecond on a DESC list and repeats them on an ASC one.
 * Rows written by one transaction share now(), so a burst of posts or notifications is exactly that case.
 */

import { describe, it, expect } from "vitest"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { parseKeysetCursor } from "../../src/db/cursor-helpers.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { makeDrizzleGovClaimsRepository } from "../../src/services/admin/gov-claims-repository.drizzle.js"
import { makeDrizzleInboundRepository } from "../../src/services/admin/inbound-repository.drizzle.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"

const AT = new Date("2026-09-01T10:00:00.123Z")
const AT_TEXT = "2026-09-01T10:00:00.123456Z"
const LEGACY_AT_TEXT = "2026-09-01T10:00:00.123Z"
const ID_A = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e01"
const ID_B = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e02"
const VIEWER = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e03"
const CURSOR = `${AT_TEXT}|${ID_A}`

/** Two rows sharing one millisecond, so a limit-1 page has a next cursor anchored on the first. */
function twoRows(extra: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { id: ID_A, cursor_at: AT_TEXT, ...extra },
    { id: ID_B, cursor_at: "2026-09-01T10:00:00.123001Z", ...extra },
  ]
}

function lastStatement(ctl: FakeSqlControl, match: RegExp): { sql: string; values: unknown[] } {
  const hit = [...ctl.statements].reverse().find((s) => match.test(s.sql))
  if (hit === undefined) throw new Error(`no statement matched ${String(match)}`)
  return hit
}

/** The page statement selects the text instant and binds the anchor as text cast to timestamptz. */
function expectExactAnchor(ctl: FakeSqlControl, match: RegExp, atText = AT_TEXT): void {
  const stmt = lastStatement(ctl, match)
  expect(stmt.sql).toMatch(/to_char\(.* AT TIME ZONE 'UTC', \?\) AS cursor_at/)
  expect(stmt.values).toContain(atText)
  expect(stmt.values.some((v) => v instanceof Date && v.getTime() === AT.getTime())).toBe(false)
  expect(stmt.sql).toContain("?::timestamptz")
}

function person(id: string): Record<string, unknown> {
  return {
    id,
    display_name: "Person",
    handle: "person",
    bio: null,
    followers: 0,
    following: 0,
    avatar_r2_key: null,
    avatar_url: null,
    is_following: false,
    deleted_at: null,
  }
}

function postRow(): Record<string, unknown> {
  return {
    author_id: VIEWER,
    kind: "post",
    body: "hello",
    reply_to_id: null,
    thread_root_id: null,
    repost_of_id: null,
    event_id: null,
    report_id: null,
    like_count: 0,
    repost_count: 0,
    reply_count: 0,
    save_count: 0,
    organization_id: null,
    created_at: AT,
    updated_at: AT,
    saved_at: AT,
  }
}

const POST_AUTHORS = /LEFT JOIN media_assets am ON am\.id = u\.avatar_media_id/

function postRepo(list: RegExp): FakeSqlControl & {
  repo: ReturnType<typeof makeDrizzlePostRepository>
} {
  const handlers: SqlHandler[] = [
    { match: POST_AUTHORS, rows: [person(VIEWER)] },
    { match: list, rows: twoRows(postRow()) },
  ]
  const ctl = makeFakeSql(handlers)
  const repo = makeDrizzlePostRepository(ctl.sql as unknown as Sql, {
    presignMedia: () => Promise.resolve({ url: "u" }),
    presignAvatar: () => Promise.resolve("a"),
  })
  return { ...ctl, repo }
}

describe("parseKeysetCursor keeps the cursor instant as text", () => {
  it("returns the microsecond text alongside the Date", () => {
    const parsed = parseKeysetCursor(CURSOR)
    expect(parsed?.atText).toBe(AT_TEXT)
    expect(parsed?.at.getTime()).toBe(AT.getTime())
    expect(parsed?.id).toBe(ID_A)
  })

  it("still decodes a legacy millisecond cursor and a timestamp-only cursor", () => {
    expect(parseKeysetCursor(`${LEGACY_AT_TEXT}|${ID_A}`)).toEqual({
      at: AT,
      id: ID_A,
      atText: LEGACY_AT_TEXT,
    })
    expect(parseKeysetCursor(LEGACY_AT_TEXT, { direction: "asc" })).toEqual({
      at: AT,
      id: "00000000-0000-0000-0000-000000000000",
      atText: LEGACY_AT_TEXT,
    })
  })

  it("rejects what parseTimeCursor rejects", () => {
    expect(parseKeysetCursor(null)).toBeNull()
    expect(parseKeysetCursor(`${AT_TEXT}|not-a-uuid`)).toBeNull()
    expect(parseKeysetCursor(`2101-01-01T00:00:00.000Z|${ID_A}`)).toBeNull()
  })

  it("a legacy millisecond cursor binds the same instant it always meant", async () => {
    const ctl = makeFakeSql([{ match: /FROM notifications/, rows: [] }])
    const repo = makeDrizzleNotificationRepository(ctl.sql as unknown as Sql)
    await repo.listNotifications(VIEWER, `${LEGACY_AT_TEXT}|${ID_A}`, 1)
    expectExactAnchor(ctl, /FROM notifications/, LEGACY_AT_TEXT)
  })
})

describe("consumer keyset lists carry microsecond cursors", () => {
  it("my reports", async () => {
    const match = /FROM reports\s+WHERE reporter_user_id/
    const ctl = makeFakeSql([{ match, rows: twoRows({ created_at: AT, lat: 0, lng: 0 }) }])
    const repo = makeDrizzleReportRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listMyReports(VIEWER, null, 1)
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listMyReports(VIEWER, CURSOR, 1)
    expectExactAnchor(ctl, match)
  })

  it("report search", async () => {
    const match = /FROM reports r/
    const ctl = makeFakeSql([{ match, rows: twoRows({ created_at: AT, lat: 0, lng: 0 }) }])
    const repo = makeDrizzleReportRepository(ctl.sql as unknown as Sql)
    const base = { q: null, categories: null, types: null, limit: 1 }
    const page1 = await repo.searchReports({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.searchReports({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
  })

  it("notifications", async () => {
    const match = /FROM notifications/
    const ctl = makeFakeSql([{ match, rows: twoRows({ created_at: AT, type: "site" }) }])
    const repo = makeDrizzleNotificationRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listNotifications(VIEWER, null, 1)
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listNotifications(VIEWER, CURSOR, 1)
    expectExactAnchor(ctl, match)
  })

  it("home feed (chronological)", async () => {
    const match = /OR p\.author_id IN \(SELECT followee_id/
    const ctl = postRepo(match)
    const base = { viewerId: VIEWER, filter: "all" as const, limit: 1 }
    const page1 = await ctl.repo.homeFeedChronological({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await ctl.repo.homeFeedChronological({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
  })

  it("public feed", async () => {
    const match = /FROM posts p\s+WHERE p\.deleted_at IS NULL\s+AND p\.reply_to_id IS NULL/
    const ctl = postRepo(match)
    const base = { filter: "all" as const, limit: 1 }
    const page1 = await ctl.repo.publicFeed({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await ctl.repo.publicFeed({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
  })

  it("a user's posts", async () => {
    const match = /WHERE p\.author_id = \? AND p\.deleted_at IS NULL AND p\.reply_to_id IS NULL/
    const ctl = postRepo(match)
    const base = { viewerId: VIEWER, limit: 1 }
    const page1 = await ctl.repo.listUserPosts(VIEWER, { ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await ctl.repo.listUserPosts(VIEWER, { ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
  })

  it("saved posts", async () => {
    const match = /FROM post_saves ps/
    const ctl = postRepo(match)
    const base = { viewerId: VIEWER, limit: 1 }
    const page1 = await ctl.repo.listSaves({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await ctl.repo.listSaves({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
    expect(lastStatement(ctl, match).sql).toMatch(/to_char\(ps\.created_at /)
  })

  it("replies (ascending)", async () => {
    const match = /WHERE p\.reply_to_id = \? AND p\.deleted_at IS NULL/
    const ctl = postRepo(match)
    const base = { viewerId: VIEWER, focalAuthorId: VIEWER, limit: 1 }
    const page1 = await ctl.repo.listReplies(ID_B, { ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await ctl.repo.listReplies(ID_B, { ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
    expect(lastStatement(ctl, match).sql).toContain(") > (")
  })

  it("blocked users", async () => {
    const match = /FROM user_blocks b\s+JOIN users u/
    const ctl = makeFakeSql([
      { match, rows: twoRows({ created_at: AT, display_name: "B", handle: null, bio: null }) },
    ])
    const repo = makeDrizzleBlocksRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listBlocked(VIEWER, { cursor: null, limit: 1 })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listBlocked(VIEWER, { cursor: CURSOR, limit: 1 })
    expectExactAnchor(ctl, match)
  })

  it.each(["listFollowers", "listFollowing"] as const)(
    "social connections (%s)",
    async (method) => {
      const match = /JOIN follows_people f ON/
      const ctl = makeFakeSql([{ match, rows: twoRows({ ...person(ID_A), edge_created_at: AT }) }])
      const repo = makeDrizzleSocialRepository(ctl.sql as unknown as Sql)
      const base = { id: VIEWER, viewerId: null, limit: 1 }
      const page1 = await repo[method]({ ...base, cursor: null })
      expect(page1.nextCursor).toBe(CURSOR)
      await repo[method]({ ...base, cursor: CURSOR })
      expectExactAnchor(ctl, match)
    },
  )

  it("volunteer hours ledger", async () => {
    const match = /FROM volunteer_hours vh/
    const ctl = makeFakeSql([
      {
        match,
        rows: twoRows({ created_at: AT, scheduled_at: null, source: "event", hours: 1 }),
      },
    ])
    const repo = makeDrizzleVolunteerHoursRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listEntries({ userId: VIEWER, cursor: null, limit: 1 })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listEntries({ userId: VIEWER, cursor: parseKeysetCursor(CURSOR), limit: 1 })
    expectExactAnchor(ctl, match)
  })
})

describe("admin keyset lists carry microsecond cursors", () => {
  it.each(["newest", "oldest"] as const)("gov claims (%s)", async (sort) => {
    const match = /FROM gov_claims\s+WHERE true/
    const ctl = makeFakeSql([{ match, rows: twoRows({ created_at: AT, checks: {} }) }])
    const repo = makeDrizzleGovClaimsRepository(ctl.sql as unknown as Sql)
    const base = { q: null, filter: "all" as const, sort, limit: 1 }
    const page1 = await repo.list({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.list({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, match)
    expect(lastStatement(ctl, match).sql).toContain(sort === "newest" ? ") < (" : ") > (")
  })

  it("inbound mail", async () => {
    const match = /FROM inbound_emails\s+WHERE true/
    const ctl = makeFakeSql([
      { match, rows: twoRows({ received_at: AT, status: "unread", has_attachments: false }) },
    ])
    const repo = makeDrizzleInboundRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.list({ limit: 1 })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.list({ limit: 1, cursor: CURSOR })
    expectExactAnchor(ctl, match)
  })

  it("mail threads", async () => {
    const match = /FROM mail_threads t\s+LEFT JOIN LATERAL/
    const ctl = makeFakeSql([
      {
        match,
        rows: twoRows({
          created_at: AT,
          last_message_at: AT,
          unread: false,
          status: "open",
          lm_direction: null,
        }),
      },
    ])
    const repo = makeDrizzleMailRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listThreads({ limit: 1 })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listThreads({ limit: 1, cursor: CURSOR })
    expectExactAnchor(ctl, match)
    expect(lastStatement(ctl, match).sql).toMatch(
      /to_char\(COALESCE\(t\.last_message_at, t\.created_at\) /,
    )
  })
})
