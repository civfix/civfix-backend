/**
 * Host broadcast lists page on now()-stamped timestamps, and plan() bulk-inserts every delivery of a
 * broadcast in one transaction, so many rows share one instant. A cursor built from the millisecond Date
 * postgres.js returns skips every row in the anchor's millisecond; these lists must carry the column's
 * microsecond text instead.
 */

import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import type { Container } from "../../src/di.js"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import {
  makeAnnouncementService,
  type AnnouncementServiceDeps,
} from "../../src/services/host/announcement-service.js"
import { makeDrizzleAdminEventPageRepository } from "../../src/services/host/admin-pages-repository.drizzle.js"
import { registerAdminBroadcastRoutes } from "../../src/routes/admin/broadcasts.routes.js"
import { registerAdminEventPageRoutes } from "../../src/routes/admin/pages.routes.js"

const AT = new Date("2026-09-01T10:00:00.123Z")
const AT_TEXT = "2026-09-01T10:00:00.123456Z"
const LEGACY_AT_TEXT = "2026-09-01T10:00:00.123Z"
const ID_A = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e01"
const ID_B = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e02"
const EVENT = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e0e"
const OPERATOR = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e0f"
const NEXT = `${AT_TEXT}|${ID_A}`

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 2,
  emailConcurrency: 2,
  emailRatePerSec: 1000,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

/** Two rows sharing one millisecond, so a limit-1 page has a next cursor anchored on the first. */
function twoRows(extra: Record<string, unknown>, idKey = "id"): Record<string, unknown>[] {
  return [
    { ...extra, [idKey]: ID_A, cursor_at: AT_TEXT },
    { ...extra, [idKey]: ID_B, cursor_at: "2026-09-01T10:00:00.123001Z" },
  ]
}

function broadcastRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cleanup_id: EVENT,
    created_by: OPERATOR,
    kind: "host_broadcast",
    reminder_offset_min: null,
    status: "sent",
    subject: "Bring gloves",
    body_md: "See you there.",
    cta_label: null,
    cta_url: null,
    segment: { kind: "all_registered" },
    channels: ["email"],
    reply_to: null,
    scheduled_at: null,
    planned_at: AT,
    started_at: AT,
    finished_at: AT,
    chunk_size: 200,
    chunk_count: 1,
    recipient_count: 2,
    sent_count: 2,
    failed_count: 0,
    suppressed_count: 0,
    content_scrubbed_at: null,
    created_at: AT,
    updated_at: AT,
    ...extra,
  }
}

function lastStatement(ctl: FakeSqlControl, match: RegExp): { sql: string; values: unknown[] } {
  const hit = [...ctl.statements].reverse().find((s) => match.test(s.sql))
  if (hit === undefined) throw new Error(`no statement matched ${String(match)}`)
  return hit
}

function expectExactAnchor(ctl: FakeSqlControl, match: RegExp, atText = AT_TEXT): void {
  const stmt = lastStatement(ctl, match)
  expect(stmt.sql).toMatch(/to_char\([\s\S]* AT TIME ZONE 'UTC', \?\) AS cursor_at/)
  expect(stmt.values).toContain(atText)
  expect(stmt.values.some((v) => v instanceof Date && v.getTime() === AT.getTime())).toBe(false)
  expect(stmt.sql).toContain("?::timestamptz")
}

function broadcastService(handlers: SqlHandler[]) {
  const ctl = makeFakeSql(handlers)
  const repo = makeDrizzleBroadcastRepository(ctl.sql as unknown as Sql)
  const service = makeBroadcastService({
    repo,
    counters: new InMemoryCounterStore(),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan: () => Promise.resolve(),
  })
  return { ctl, repo, service }
}

describe("host broadcast list cursors", () => {
  const LIST = /FROM broadcasts\s+WHERE cleanup_id = \?/

  it("encodes the microsecond instant and binds it back as text", async () => {
    const { ctl, service } = broadcastService([{ match: LIST, rows: twoRows(broadcastRow()) }])
    const first = await service.list(EVENT, { id: EVENT, limit: 1 })
    expect(first.nextCursor).toBe(NEXT)

    await service.list(EVENT, { id: EVENT, limit: 1, cursor: NEXT })
    expectExactAnchor(ctl, LIST)
  })

  it("still accepts a legacy millisecond cursor as the same instant", async () => {
    const { ctl, service } = broadcastService([{ match: LIST, rows: [] }])
    await service.list(EVENT, { id: EVENT, limit: 1, cursor: `${LEGACY_AT_TEXT}|${ID_A}` })
    expectExactAnchor(ctl, LIST, LEGACY_AT_TEXT)
  })
})

describe("host broadcast delivery cursors", () => {
  const DELIVERIES = /FROM broadcast_deliveries/
  const delivery = {
    channel: "email",
    recipient_kind: "member",
    status: "sent",
    suppression_reason: null,
    failure_kind: null,
    attempts: 1,
    sent_at: AT,
    created_at: AT,
  }

  it("encodes the microsecond instant of deliveries one plan inserted together", async () => {
    const { ctl, service } = broadcastService([
      { match: DELIVERIES, rows: twoRows(delivery) },
      { match: /FROM broadcasts/, rows: [broadcastRow({ id: ID_A })] },
    ])
    const first = await service.listDeliveries(EVENT, { id: EVENT, broadcastId: ID_A, limit: 1 })
    expect(first.nextCursor).toBe(NEXT)

    await service.listDeliveries(EVENT, { id: EVENT, broadcastId: ID_A, limit: 1, cursor: NEXT })
    expectExactAnchor(ctl, DELIVERIES)
  })
})

describe("event announcement cursors", () => {
  const ANNOUNCEMENTS = /AND kind = \?/

  it("encodes the microsecond instant and binds it back as text", async () => {
    const ctl = makeFakeSql([
      { match: ANNOUNCEMENTS, rows: twoRows(broadcastRow({ kind: "announcement" })) },
    ])
    const service = makeAnnouncementService({
      repo: makeDrizzleBroadcastRepository(ctl.sql as unknown as Sql),
      identities: {
        authorsFor: () => Promise.resolve(new Map()),
        organizationFor: () => Promise.resolve(null),
      },
      broadcasts: {} as AnnouncementServiceDeps["broadcasts"],
      config: CONFIG,
    })
    const first = await service.list(EVENT, { id: EVENT, limit: 1 }, { host: true })
    expect(first.nextCursor).toBe(NEXT)

    await service.list(EVENT, { id: EVENT, limit: 1, cursor: NEXT }, { host: true })
    expectExactAnchor(ctl, ANNOUNCEMENTS)
  })
})

async function adminApp(handlers: SqlHandler[]): Promise<{
  app: FastifyInstance
  ctl: FakeSqlControl
}> {
  const ctl = makeFakeSql(handlers)
  const sql = ctl.sql as unknown as Sql
  const container = {
    env: { NODE_ENV: "test", WEB_ORIGINS: ["https://civfix.org"] },
    csrf: { protect: (_req: unknown, _reply: unknown, done: () => void) => done() },
    getDb: () => ({ sql }),
  } as unknown as Container
  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  const alwaysAllowed = () => () =>
    Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(app.decorate as (name: string, value: unknown) => void)("createRateLimit", alwaysAllowed)
  ;(app.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: OPERATOR, roles: ["operator"] }
    done()
  })
  app.decorate("adminBroadcastOverrides", { repo: makeDrizzleBroadcastRepository(sql) })
  app.decorate("adminEventPageOverrides", { repo: makeDrizzleAdminEventPageRepository(sql) })
  await registerAdminBroadcastRoutes(app, container)
  await registerAdminEventPageRoutes(app, container)
  await app.ready()
  return { app, ctl }
}

async function nextCursorOf(app: FastifyInstance, url: string): Promise<string | null> {
  const res = await app.inject({ method: "GET", url })
  expect(res.statusCode).toBe(200)
  return res.json<{ nextCursor: string | null }>().nextCursor
}

describe("operator broadcast list cursors", () => {
  const ADMIN_LIST = /FROM broadcasts b\s+LEFT JOIN cleanups c/

  it("encodes the microsecond instant and binds it back as text", async () => {
    const row = broadcastRow({
      event_title: "Beach Cleanup",
      created_by_name: "Ada",
      created_by_handle: "ada",
      created_by_joined: AT,
    })
    const { app, ctl } = await adminApp([{ match: ADMIN_LIST, rows: twoRows(row) }])
    expect(await nextCursorOf(app, "/v1/admin/broadcasts?limit=1")).toBe(NEXT)

    await nextCursorOf(app, `/v1/admin/broadcasts?limit=1&cursor=${encodeURIComponent(NEXT)}`)
    expectExactAnchor(ctl, ADMIN_LIST)
  })
})

describe("operator host list cursors", () => {
  const HOSTS = /WITH agg AS/

  it("encodes the microsecond instant of the last broadcast and binds it back as text", async () => {
    const host = {
      display_name: "Ada",
      handle: "ada",
      joined_at: AT,
      messaging_suspended: false,
      suspended_at: null,
      suspended_by_id: null,
      suspended_by_name: null,
      suspended_by_handle: null,
      suspended_by_joined: null,
      broadcast_count: 1,
      recipient_count: 2,
      sent_count: 2,
      failed_count: 0,
      suppressed_count: 0,
      events_messaged: 1,
      last_broadcast_at: AT,
      sort_at: AT,
    }
    const { app, ctl } = await adminApp([{ match: HOSTS, rows: twoRows(host, "user_id") }])
    expect(await nextCursorOf(app, "/v1/admin/hosts?limit=1")).toBe(NEXT)

    await nextCursorOf(app, `/v1/admin/hosts?limit=1&cursor=${encodeURIComponent(NEXT)}`)
    const stmt = lastStatement(ctl, HOSTS)
    expectExactAnchor(ctl, HOSTS)
    expect(stmt.sql).toMatch(
      /\(COALESCE\(agg\.last_broadcast_at, 'epoch'::timestamptz\), u\.id\) < \(\?::timestamptz, \?::uuid\)/,
    )
  })
})

describe("operator event page list cursors", () => {
  const PAGES = /FROM cleanup_pages p/

  it("encodes the microsecond instant and binds it back as text", async () => {
    const page = {
      cleanup_id: EVENT,
      slug: "beach-cleanup",
      title: "Beach Cleanup",
      status: "published",
      visibility: "public",
      organizer_id: OPERATOR,
      organizer_name: "Ada",
      organizer_handle: "ada",
      organizer_joined: AT,
      org_name: null,
      view_count: 3,
      published_at: AT,
      flagged_at: null,
      flag_reason: null,
      flagged_by_id: null,
      flagged_by_name: null,
      flagged_by_handle: null,
      flagged_by_joined: null,
      sort_at: AT,
    }
    const { app, ctl } = await adminApp([{ match: PAGES, rows: twoRows(page, "page_id") }])
    expect(await nextCursorOf(app, "/v1/admin/pages?limit=1")).toBe(NEXT)

    await nextCursorOf(app, `/v1/admin/pages?limit=1&cursor=${encodeURIComponent(NEXT)}`)
    expectExactAnchor(ctl, PAGES)
    expect(lastStatement(ctl, PAGES).sql).toMatch(
      /\(COALESCE\(p\.published_at, p\.updated_at\), p\.id\) < \(\?::timestamptz, \?::uuid\)/,
    )
  })
})
