import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { makeCsrf } from "../../src/auth/csrf.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { WriteAuditInput } from "../../src/services/admin/audit.js"
import { InMemoryAdminUserRepository } from "../../src/services/admin/admin-user-repository.memory.js"
import { InMemoryCertificateRepository } from "../../src/services/certificate-repository.memory.js"
import type { NotificationService } from "../../src/services/notification-service.js"
import { InMemoryVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.memory.js"
import type { CleanupHoursView } from "../../src/services/volunteer-hours-service.js"

const OPERATOR_EMAIL = "ops@civfix.org"
const BOB = "22222222-2222-4222-8222-222222222222"
const EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
const GEOID = "0644000"

const ENDED_EVENT: CleanupHoursView = {
  organizerUserId: "11111111-1111-4111-8111-111111111111",
  status: "done",
  jurisdictionGeoid: GEOID,
  title: "Ocean Beach sweep",
  scheduledAt: new Date("2026-07-04T08:00:00.000Z"),
  endsAt: new Date("2026-07-04T12:00:00.000Z"),
  completedAt: null,
  timezone: null,
}

interface Harness {
  app: FastifyInstance
  hours: InMemoryVolunteerHoursRepository
  reads: WriteAuditInput[]
  notices: (string | undefined)[]
  operatorId: string
  operatorToken: string
  citizenToken: string
}

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

async function makeHarness(): Promise<Harness> {
  const stores = makeInMemoryStores()
  const services = buildAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  app = await buildServer({
    env: loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR_EMAIL }),
    authServices: services,
  })

  const hours = new InMemoryVolunteerHoursRepository()
  hours.seedJurisdiction(GEOID, "Los Angeles")
  hours.seedUser(CIVFIX_OFFICIAL_USER_ID, { name: "CivFix", handle: "civfix", avatarUrl: null })
  hours.seedCleanup(EVENT, {
    title: ENDED_EVENT.title,
    referenceCode: "EV-1",
    scheduledAt: ENDED_EVENT.scheduledAt,
  })
  const accounts = new InMemoryAdminUserRepository()
  accounts.seedUser({ id: BOB, name: "Bob", handle: "bob" })
  const notices: (string | undefined)[] = []
  app.adminUserHoursOverrides = {
    hours,
    certificates: new InMemoryCertificateRepository(),
    accounts,
    events: { load: (id) => Promise.resolve(id === EVENT ? ENDED_EVENT : null) },
    notifier: {
      createNotification: (_userId, input) => {
        notices.push(input.bodyKey)
        return Promise.resolve({} as Awaited<ReturnType<NotificationService["createNotification"]>>)
      },
    },
  }
  const reads: WriteAuditInput[] = []
  app.adminReadAuditOverrides = {
    sink: (input) => {
      reads.push(input)
      return Promise.resolve()
    },
  }

  const operator = await stores.users.create(OPERATOR_EMAIL, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const citizen = await stores.users.create("neighbor@example.com", {
    displayName: "Neighbor",
    role: "citizen",
    emailVerified: true,
  })
  return {
    app,
    hours,
    reads,
    notices,
    operatorId: operator.id,
    operatorToken: await services.sessions.createSession(operator.id, ["operator"]),
    citizenToken: await services.sessions.createSession(citizen.id, ["citizen"]),
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

const MANUAL_BODY = {
  kind: "manual",
  hours: 2,
  serviceDate: "2026-07-05",
  reason: "Tabling at the library fair",
}

describe("admin user hours routes", () => {
  it("credits, reads (audited) and voids through the operator console", async () => {
    const h = await makeHarness()

    const credited = await h.app.inject({
      method: "POST",
      url: `/v1/admin/users/${BOB}/hours`,
      headers: bearer(h.operatorToken),
      payload: { kind: "event", eventId: EVENT, hours: 3, reason: "Signed up at the event" },
    })
    expect(credited.statusCode).toBe(200)
    const { entryId, totalHours } = credited.json() as { entryId: string; totalHours: number }
    expect(totalHours).toBe(3)
    expect(h.notices).toEqual(["notification.hours_logged.body"])
    expect(h.hours.audits).toEqual([
      expect.objectContaining({ actorId: h.operatorId, action: "user.hours_credited" }),
    ])

    const read = await h.app.inject({
      method: "GET",
      url: `/v1/admin/users/${BOB}/hours?limit=10`,
      headers: bearer(h.operatorToken),
    })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({
      items: [{ id: entryId, source: "event", voidable: true, operator: { id: h.operatorId } }],
      totals: { totalHours: 3, liveEntries: 1, voidedEntries: 0 },
    })
    expect(h.reads).toEqual([
      {
        actorId: h.operatorId,
        action: "user.hours_viewed",
        target: `user:${BOB}`,
        meta: { returned: 1, cursor: null },
      },
    ])

    const voided = await h.app.inject({
      method: "POST",
      url: `/v1/admin/users/${BOB}/hours/${entryId}/void`,
      headers: bearer(h.operatorToken),
      payload: { reason: "Wrong person" },
    })
    expect(voided.statusCode).toBe(200)
    expect(voided.json()).toEqual({ ok: true, affectedCertificates: [] })
    expect(h.notices).toHaveLength(1)
  })

  it("addresses the account named in the path, whatever id the body claims", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/users/${BOB}/hours`,
      headers: bearer(h.operatorToken),
      payload: { ...MANUAL_BODY, id: h.operatorId },
    })
    expect(res.statusCode).toBe(200)
    expect(h.hours.audits[0]).toMatchObject({ target: `user:${BOB}` })
  })

  it("422s a body that matches neither credit kind, or carries the other kind's fields", async () => {
    const h = await makeHarness()
    const bad = [
      { ...MANUAL_BODY, kind: "bonus" },
      { ...MANUAL_BODY, eventId: EVENT },
      { kind: "event", hours: 1, reason: "x" },
      { ...MANUAL_BODY, serviceDate: "1999-12-31" },
      { ...MANUAL_BODY, hours: 25 },
      { ...MANUAL_BODY, reason: "   " },
    ]
    for (const payload of bad) {
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/admin/users/${BOB}/hours`,
        headers: bearer(h.operatorToken),
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(422)
    }
    const noReason = await h.app.inject({
      method: "POST",
      url: `/v1/admin/users/${BOB}/hours/${EVENT}/void`,
      headers: bearer(h.operatorToken),
      payload: {},
    })
    expect(noReason.statusCode).toBe(422)
    const badEntry = await h.app.inject({
      method: "POST",
      url: `/v1/admin/users/${BOB}/hours/not-a-uuid/void`,
      headers: bearer(h.operatorToken),
      payload: { reason: "x" },
    })
    expect(badEntry.statusCode).toBe(422)
    expect(h.hours.audits).toEqual([])
  })

  it("is operator-only: 401 anonymous, 403 citizen, on the read and both writes", async () => {
    const h = await makeHarness()
    const calls = [
      { method: "GET" as const, url: `/v1/admin/users/${BOB}/hours` },
      { method: "POST" as const, url: `/v1/admin/users/${BOB}/hours`, payload: MANUAL_BODY },
      {
        method: "POST" as const,
        url: `/v1/admin/users/${BOB}/hours/${EVENT}/void`,
        payload: { reason: "x" },
      },
    ]
    for (const call of calls) {
      expect((await h.app.inject(call)).statusCode, `${call.url} anonymous`).toBe(401)
      const citizen = await h.app.inject({ ...call, headers: bearer(h.citizenToken) })
      expect(citizen.statusCode, `${call.url} citizen`).toBe(403)
    }
    expect(h.hours.audits).toEqual([])
    expect(h.reads).toEqual([])
  })

  it("requires the session-bound CSRF token on a cookie session's writes", async () => {
    const h = await makeHarness()
    const cookie = `civfix_session=${h.operatorToken}`
    for (const call of [
      { url: `/v1/admin/users/${BOB}/hours`, payload: MANUAL_BODY },
      { url: `/v1/admin/users/${BOB}/hours/${EVENT}/void`, payload: { reason: "x" } },
    ]) {
      const res = await h.app.inject({ method: "POST", headers: { cookie }, ...call })
      expect(res.statusCode, call.url).toBe(403)
      expect(res.json()).toMatchObject({ message: "CSRF token missing or invalid." })
    }
    expect(h.hours.audits).toEqual([])

    const csrf = makeCsrf(loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR_EMAIL }))
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/users/${BOB}/hours`,
      headers: { cookie, "x-csrf-token": await csrf.tokenForSession(h.operatorToken) },
      payload: MANUAL_BODY,
    })
    expect(res.statusCode).toBe(200)
  })
})
