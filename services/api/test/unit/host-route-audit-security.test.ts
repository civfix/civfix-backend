import { Writable } from "node:stream"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import type { BroadcastDTO, HostExportDTO } from "@civfix/shared"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"
import { registerHostExportRoutes } from "../../src/routes/host/exports.routes.js"
import { registerHostBroadcastRoutes } from "../../src/routes/host/broadcasts.routes.js"
import type { HostExportService } from "../../src/services/host/export-service.js"
import type { CommsRuntime } from "../../src/services/host/comms-wiring.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

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

describe("host export request when the audit write fails", () => {
  it("answers the export it already queued instead of a 500, and logs the lost audit row", async () => {
    const exports = {
      request: () => Promise.resolve({ id: EXPORT_ID, kind: "roster" } as HostExportDTO),
    } as unknown as HostExportService
    const h = await build(registerHostExportRoutes, (instance) =>
      instance.decorate("hostExportOverrides", { exports }),
    )

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/exports`,
      payload: { kind: "roster" },
    })

    expect(res.statusCode).toBe(200)
    expect(h.enqueued).toHaveLength(1)
    expect(auditWarnings(h.logs)).toEqual([
      expect.objectContaining({ action: "event.roster_exported", target: `cleanup:${EVENT}` }),
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
