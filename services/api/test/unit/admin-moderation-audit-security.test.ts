import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"
import { registerAdminEventPageRoutes } from "../../src/routes/admin/pages.routes.js"
import { registerAdminBroadcastRoutes } from "../../src/routes/admin/broadcasts.routes.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"

const OPERATOR = "11111111-1111-4111-8111-111111111111"
const CLEANUP = "22222222-2222-4222-8222-222222222222"
const HOST = "44444444-4444-4444-8444-444444444444"
const AUDIT_ID = "77777777-7777-4777-8777-777777777777"

const PAGE_ROW = {
  page_id: "55555555-5555-4555-8555-555555555555",
  cleanup_id: CLEANUP,
  slug: "beach-sweep",
  title: "Beach sweep",
  status: "unpublished",
  visibility: "public",
  organizer_id: HOST,
  organizer_name: "Ada",
  organizer_handle: "ada",
  organizer_joined: new Date("2026-01-01T00:00:00.000Z"),
  org_name: null,
  view_count: "12",
  published_at: new Date("2026-08-01T00:00:00.000Z"),
  flagged_at: new Date("2026-09-01T00:00:00.000Z"),
  flag_reason: "spam",
  flagged_by_id: OPERATOR,
  flagged_by_name: "Op",
  flagged_by_handle: "op",
  flagged_by_joined: new Date("2026-01-01T00:00:00.000Z"),
  sort_at: new Date("2026-08-01T00:00:00.000Z"),
}

const auditOk: SqlHandler = { match: /INSERT INTO audit_log/, rows: [{ id: AUDIT_ID }] }
const auditDown: SqlHandler = {
  match: /INSERT INTO audit_log/,
  rows: () => {
    throw new Error("audit_log unavailable")
  },
}

interface Harness {
  app: FastifyInstance
  outer: FakeSqlControl
  tx: FakeSqlControl
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function harness(txHandlers: SqlHandler[]): Promise<Harness> {
  const outer = makeFakeSql()
  const tx = makeFakeSql(txHandlers)
  outer.sql.begin = (cb) => cb(tx.sql)
  const container = {
    env: { NODE_ENV: "test", WEB_ORIGINS: ["http://localhost:3000"] },
    storage: new FakeStorage(),
    csrf: { protect: (_req: unknown, _reply: unknown, done: () => void) => done() },
    getDb: () => ({ sql: outer.sql }),
  } as unknown as Container

  const instance = Fastify({ logger: false })
  instance.setErrorHandler(makeErrorHandler())
  instance.setNotFoundHandler(makeNotFoundHandler())
  ;(instance.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  instance.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: OPERATOR, roles: ["operator"] }
    done()
  })
  await registerAdminEventPageRoutes(instance, container)
  await registerAdminBroadcastRoutes(instance, container)
  await instance.ready()
  app = instance
  return { app: instance, outer, tx }
}

function statementsMatching(control: FakeSqlControl, pattern: RegExp): string[] {
  return control.statements.map((s) => s.sql).filter((sql) => pattern.test(sql))
}

describe("operator page moderation writes its audit row in the effect's transaction", () => {
  it("flags a page and audits it inside one transaction", async () => {
    const h = await harness([
      { match: /UPDATE cleanup_pages/, rows: [{ cleanup_id: CLEANUP }] },
      { match: /FROM cleanup_pages p/, rows: [PAGE_ROW] },
      auditOk,
    ])

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/flag`,
      payload: { flagged: true, reason: "spam" },
    })

    expect(res.statusCode).toBe(200)
    expect(h.outer.statements).toEqual([])
    expect(statementsMatching(h.tx, /UPDATE cleanup_pages/)).toHaveLength(1)
    expect(statementsMatching(h.tx, /INSERT INTO audit_log/)).toHaveLength(1)
    const audit = h.tx.statements.find((s) => /INSERT INTO audit_log/.test(s.sql))
    expect(audit?.values).toEqual([
      OPERATOR,
      "event_page.flagged",
      `cleanup:${CLEANUP}`,
      { reason: "spam" },
    ])
  })

  it("rolls the flag back with the failed audit: both run in the transaction that rejects", async () => {
    const h = await harness([
      { match: /UPDATE cleanup_pages/, rows: [{ cleanup_id: CLEANUP }] },
      { match: /FROM cleanup_pages p/, rows: [PAGE_ROW] },
      auditDown,
    ])

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/flag`,
      payload: { flagged: true, reason: "spam" },
    })

    expect(res.statusCode).toBe(500)
    expect(h.outer.statements).toEqual([])
    expect(statementsMatching(h.tx, /UPDATE cleanup_pages/)).toHaveLength(1)
  })

  it("unpublishes a page and audits it inside one transaction", async () => {
    const h = await harness([
      { match: /UPDATE cleanup_pages/, rows: [{ cleanup_id: CLEANUP }] },
      { match: /FROM cleanup_pages p/, rows: [PAGE_ROW] },
      auditOk,
    ])

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/unpublish`,
      payload: { reason: "off-platform payment link" },
    })

    expect(res.statusCode).toBe(200)
    expect(h.outer.statements).toEqual([])
    expect(statementsMatching(h.tx, /INSERT INTO audit_log/)).toHaveLength(1)
  })

  it("404s a missing page before writing any audit row", async () => {
    const h = await harness([{ match: /UPDATE cleanup_pages/, rows: [] }, auditOk])

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/unpublish`,
      payload: { reason: "spam" },
    })

    expect(res.statusCode).toBe(404)
    expect(statementsMatching(h.tx, /INSERT INTO audit_log/)).toHaveLength(0)
    expect(statementsMatching(h.outer, /INSERT INTO audit_log/)).toHaveLength(0)
  })
})

describe("host messaging suspension writes its audit row in the effect's transaction", () => {
  it("suspends and audits inside one transaction", async () => {
    const h = await harness([
      { match: /INSERT INTO user_moderation/, rows: [{ user_id: HOST }] },
      auditOk,
    ])

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/hosts/${HOST}/messaging`,
      payload: { suspended: true, reason: "spam blasts" },
    })

    expect(res.statusCode).toBe(200)
    expect(h.outer.statements).toEqual([])
    expect(statementsMatching(h.tx, /INSERT INTO user_moderation/)).toHaveLength(1)
    const audit = h.tx.statements.find((s) => /INSERT INTO audit_log/.test(s.sql))
    expect(audit?.values).toEqual([
      OPERATOR,
      "host.messaging_suspended",
      `user:${HOST}`,
      { reason: "spam blasts" },
    ])
  })

  it("404s an unknown user instead of auditing a suspension that never happened", async () => {
    const h = await harness([{ match: /INSERT INTO user_moderation/, rows: [] }, auditOk])

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/hosts/${HOST}/messaging`,
      payload: { suspended: true, reason: "spam blasts" },
    })

    expect(res.statusCode).toBe(404)
    expect(statementsMatching(h.tx, /INSERT INTO audit_log/)).toHaveLength(0)
    expect(statementsMatching(h.outer, /INSERT INTO audit_log/)).toHaveLength(0)
  })
})
