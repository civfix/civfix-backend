import { Writable } from "node:stream"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import type { BroadcastDTO } from "@civfix/shared"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"
import { registerHostExportRoutes } from "../../src/routes/host/exports.routes.js"
import { registerHostBroadcastRoutes } from "../../src/routes/host/broadcasts.routes.js"
import {
  makeHostExportService,
  type HostExportService,
} from "../../src/services/host/export-service.js"
import { makeDrizzleHostExportRepository } from "../../src/services/host/export-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"
import type { CommsRuntime } from "../../src/services/host/comms-wiring.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"

const USER = "11111111-1111-4111-8111-111111111111"
const EVENT = "22222222-2222-4222-8222-222222222222"
const EXPORT_ID = "44444444-4444-4444-8444-444444444444"
const BROADCAST_ID = "55555555-5555-4555-8555-555555555555"
const WARN_LEVEL = 40

interface LogLine {
  level: number
  msg?: string
  action?: string
  target?: string
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

function organizerStandingSql() {
  const fake = makeFakeSql([
    {
      match: /FROM cleanups c/,
      rows: [
        {
          cleanup_id: EVENT,
          organizer_user_id: USER,
          organization_id: null,
          visibility: "public",
          event_role: "organizer",
          org_role: null,
        },
      ],
    },
    {
      match: /INSERT INTO audit_log/,
      rows: () => {
        throw new Error("audit_log unavailable")
      },
    },
  ])
  return fake
}

async function build(
  register: (instance: FastifyInstance, container: Container) => Promise<void>,
  decorate: (instance: FastifyInstance) => void,
): Promise<{ app: FastifyInstance; logs: LogLine[]; enqueued: string[] }> {
  const logs: LogLine[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(JSON.parse(chunk.toString("utf8")) as LogLine)
      done()
    },
  })
  const enqueued: string[] = []
  const fake = organizerStandingSql()
  const container = {
    env: { NODE_ENV: "test", WEB_ORIGINS: ["http://localhost:3000"] },
    storage: new FakeStorage(),
    csrf: { protect: (_r: unknown, _p: unknown, done: () => void) => done() },
    getDb: () => ({ sql: fake.sql }),
    jobs: {
      enqueue: (name: string) => {
        enqueued.push(name)
        return Promise.resolve("job-1")
      },
    },
  } as unknown as Container

  const instance = Fastify({ logger: { level: "warn", stream } })
  instance.setErrorHandler(makeErrorHandler())
  instance.setNotFoundHandler(makeNotFoundHandler())
  const allowed = () => () =>
    Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(instance.decorate as (name: string, value: unknown) => void)("createRateLimit", allowed)
  ;(instance.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  instance.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: USER, roles: ["citizen"] }
    done()
  })
  decorate(instance)
  await register(instance, container)
  await instance.ready()
  app = instance
  return { app: instance, logs, enqueued }
}

function auditWarnings(logs: LogLine[]): LogLine[] {
  return logs.filter((line) => line.level === WARN_LEVEL && line.action !== undefined)
}

const EXPORT_ROW = {
  id: EXPORT_ID,
  cleanup_id: EVENT,
  organization_id: null,
  requested_by: USER,
  kind: "roster",
  filters: {},
  status: "queued",
  r2_key: null,
  row_count: null,
  byte_size: null,
  truncated: false,
  error_code: null,
  run_token: null,
  requested_at: new Date("2026-09-01T00:00:00.000Z"),
  started_at: null,
  completed_at: null,
  expires_at: null,
}

const exportInsert: SqlHandler = { match: /INSERT INTO host_exports/, rows: [EXPORT_ROW] }
const auditOk: SqlHandler = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }
const auditDown: SqlHandler = {
  match: /INSERT INTO audit_log/,
  rows: () => {
    throw new Error("audit_log unavailable")
  },
}

function exportServiceOn(sql: FakeSqlControl): HostExportService {
  return makeHostExportService({
    repo: makeDrizzleHostExportRepository(sql.sql as unknown as Sql),
    storage: {
      put: () => Promise.resolve(),
      presignGet: () => Promise.resolve("https://signed.example/x"),
      delete: () => Promise.resolve(),
    },
    config: { maxRows: 10, maxBytes: 1024, ttlHours: 24 },
  })
}

describe("roster export audit rides the export row's transaction", () => {
  it("writes the export row and its audit row inside one transaction", async () => {
    const outer = makeFakeSql()
    const tx = makeFakeSql([exportInsert, auditOk])
    outer.sql.begin = (cb) => cb(tx.sql)
    const repo = makeDrizzleHostExportRepository(outer.sql as unknown as Sql)

    const record = await repo.create(
      {
        cleanupId: EVENT,
        organizationId: null,
        requestedBy: USER,
        kind: "roster",
        filters: {},
      },
      (exportId) => ({
        action: "event.roster_exported",
        actorId: USER,
        target: `cleanup:${EVENT}`,
        meta: { exportId, kind: "roster" },
      }),
    )

    expect(record.id).toBe(EXPORT_ID)
    expect(outer.statements).toEqual([])
    expect(tx.statements.map((s) => /INSERT INTO (\w+)/.exec(s.sql)?.[1])).toEqual([
      "host_exports",
      "audit_log",
    ])
    expect(tx.statements[1]?.values).toEqual([
      USER,
      "event.roster_exported",
      `cleanup:${EVENT}`,
      { exportId: EXPORT_ID, kind: "roster" },
    ])
  })
})

describe("host export request and its audit row", () => {
  it("fails the request and queues nothing when the audit row cannot be written", async () => {
    const repoSql = makeFakeSql([exportInsert, auditDown])
    const h = await build(registerHostExportRoutes, (instance) =>
      instance.decorate("hostExportOverrides", { exports: exportServiceOn(repoSql) }),
    )

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/exports`,
      payload: { kind: "roster" },
    })

    expect(res.statusCode).toBe(500)
    expect(h.enqueued).toHaveLength(0)
  })

  it("audits the export it queued with the export id", async () => {
    const repoSql = makeFakeSql([exportInsert, auditOk])
    const h = await build(registerHostExportRoutes, (instance) =>
      instance.decorate("hostExportOverrides", { exports: exportServiceOn(repoSql) }),
    )

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/exports`,
      payload: { kind: "roster" },
    })

    expect(res.statusCode).toBe(200)
    expect(h.enqueued).toHaveLength(1)
    const audit = repoSql.statements.find((s) => /INSERT INTO audit_log/.test(s.sql))
    expect(audit?.values).toEqual([
      USER,
      "event.roster_exported",
      `cleanup:${EVENT}`,
      { exportId: EXPORT_ID, kind: "roster" },
    ])
  })
})

describe("host broadcast send when the audit write fails", () => {
  it("still answers the send and logs the lost audit row at warn", async () => {
    const sent = {
      id: BROADCAST_ID,
      cleanupId: EVENT,
      segment: { kind: "all_registered" },
      channels: ["email"],
      subject: "Bring gloves",
    } as unknown as BroadcastDTO
    const runtime = {
      broadcasts: { send: () => Promise.resolve(sent) },
    } as unknown as CommsRuntime
    const h = await build(registerHostBroadcastRoutes, (instance) =>
      instance.decorate("broadcastOverrides", { runtime }),
    )

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/broadcasts/${BROADCAST_ID}/send`,
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(auditWarnings(h.logs)).toEqual([
      expect.objectContaining({
        action: "event.broadcast_sent",
        target: `broadcast:${BROADCAST_ID}`,
      }),
    ])
  })
})
