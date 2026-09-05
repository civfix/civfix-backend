import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeJobs, FakeMailer, FakeStorage } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { WriteAuditInput } from "../../src/services/admin/audit.js"
import { InMemoryHomeRepository } from "../../src/services/admin/home-repository.memory.js"
import { InMemoryAnalyticsRepository } from "../../src/services/admin/analytics-repository.memory.js"
import { InMemoryActivityRepository } from "../../src/services/admin/activity-repository.memory.js"
import { InMemoryAuditRepository } from "../../src/services/admin/audit-repository.memory.js"
import { InMemoryDiscoveryRepository } from "../../src/services/admin/discovery-repository.memory.js"
import { InMemoryJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { InMemoryAdminEventRepository } from "../../src/services/admin/admin-event-repository.memory.js"
import { InMemoryAdminUserRepository } from "../../src/services/admin/admin-user-repository.memory.js"
import {
  InMemoryGovClaimsRepository,
  InMemoryUserProvisioner,
} from "../../src/services/admin/gov-claims-repository.memory.js"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"


const OPERATOR = "ops@civfix.org"
const FROM_OUTREACH = "outreach@civfix.org"

const SUBJECT_USER = "11111111-1111-4111-8111-111111111111"
const SUBJECT_REPORT = "22222222-2222-4222-8222-222222222222"
const SUBJECT_EVENT = "33333333-3333-4333-8333-333333333333"
const SUBJECT_MODERATION = "44444444-4444-4444-8444-444444444444"
const SUBJECT_CLAIM = "55555555-5555-4555-8555-555555555555"
const SUBJECT_DISCOVERY = "66666666-6666-4666-8666-666666666666"
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999"

interface Fakes {
  home: InMemoryHomeRepository
  analytics: InMemoryAnalyticsRepository
  activity: InMemoryActivityRepository
  audit: InMemoryAuditRepository
  discovery: InMemoryDiscoveryRepository
  jurisdictions: InMemoryJurisdictionContactsRepository
  reports: InMemoryAdminReportRepository
  events: InMemoryAdminEventRepository
  users: InMemoryAdminUserRepository
  govClaims: InMemoryGovClaimsRepository
  moderation: InMemoryModerationRepository
  mail: InMemoryMailRepository
  inbox: InMemoryInboundRepository
}

interface Harness {
  app: FastifyInstance
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
  fakes: Fakes
  reads: WriteAuditInput[]
  token: string
  operatorId: string
  mailThreadId: string
  inboxId: string
}

function makeFakes(): Fakes {
  const home = new InMemoryHomeRepository()
  home.discoveryValue = { queue: 4, reportsWaiting: 11, overSla: 2 }
  home.livePinsValue = 9
  home.recentPinsValue = [
    {
      refType: "report",
      id: SUBJECT_REPORT,
      lat: 34.05,
      lng: -118.25,
      category: "trash",
      status: "published",
      flagged: false,
      title: "Overflowing bin",
      place: "Los Angeles",
      attendees: null,
      eventKind: null,
    },
  ]

  const analytics = new InMemoryAnalyticsRepository()
  analytics.kpisValue = {
    pins: { current: 120, previous: 100 },
    resolvedRatio: { current: 0.5, previous: 0.47 },
    cleanupsPlanned: { current: 8, previous: 7 },
    events: { current: 5, previous: 9 },
    newUsers: { current: 64, previous: 60 },
  }

  const activity = new InMemoryActivityRepository()
  activity.seedRecord({
    source: "report",
    id: SUBJECT_REPORT,
    ts: new Date("2026-06-15T10:00:00.000Z"),
    who: "Jane Neighbor",
    where: "Los Angeles",
  })

  const audit = new InMemoryAuditRepository()
  audit.seedRow({
    actorId: SUBJECT_USER,
    actorName: "Operator A",
    action: "report.status_changed",
    target: `report:${SUBJECT_REPORT}`,
    createdAt: new Date("2026-06-15T09:00:00.000Z"),
  })

  const discovery = new InMemoryDiscoveryRepository()
  discovery.seedTask({
    id: SUBJECT_DISCOVERY,
    geoid: "0644000",
    place: "Los Angeles",
    perCategory: { trash: 3 },
  })

  const jurisdictions = new InMemoryJurisdictionContactsRepository()
  jurisdictions.seedJurisdiction({
    geoid: "0644000",
    name: "Los Angeles",
    defaultEmails: ["311@lacity.gov"],
  })

  const reports = new InMemoryAdminReportRepository()
  reports.seedReport({ id: SUBJECT_REPORT, title: "Overflowing bin", place: "Los Angeles" })

  const events = new InMemoryAdminEventRepository()
  events.seedEvent({ id: SUBJECT_EVENT, title: "Beach sweep", place: "Santa Monica" })

  const users = new InMemoryAdminUserRepository()
  users.seedUser({ id: SUBJECT_USER, name: "Jane Neighbor", handle: "jane", city: "Los Angeles" })
  users.seedMessage(SUBJECT_USER, {
    id: "msg-1",
    text: "Meeting at the pier",
    thread: "Beach sweep",
    createdAt: new Date("2026-06-14T00:00:00.000Z"),
  })
  users.seedReport(SUBJECT_USER, {
    id: SUBJECT_REPORT,
    title: "Overflowing bin",
    category: "trash",
    status: "published",
    place: "Los Angeles",
    createdAt: new Date("2026-06-13T00:00:00.000Z"),
  })
  users.seedEvent(SUBJECT_USER, {
    id: SUBJECT_EVENT,
    title: "Beach sweep",
    place: "Santa Monica",
    role: "organizer",
    attendees: 12,
    whenAt: new Date("2026-06-20T00:00:00.000Z"),
  })

  const govClaims = new InMemoryGovClaimsRepository()
  govClaims.seedClaim({
    id: SUBJECT_CLAIM,
    name: "Dana Lee",
    org: "City of Los Angeles",
    contactEmail: "dana@lacity.gov",
  })

  const moderation = new InMemoryModerationRepository()
  moderation.seedItem({ id: SUBJECT_MODERATION, flag: "NSFW image", priority: "high" })

  const mail = new InMemoryMailRepository()
  const inbox = new InMemoryInboundRepository()

  return {
    home,
    analytics,
    activity,
    audit,
    discovery,
    jurisdictions,
    reports,
    events,
    users,
    govClaims,
    moderation,
    mail,
    inbox,
  }
}

async function makeHarness(): Promise<Harness> {
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const services = buildAuthServices({
    stores,
    cache,
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR })
  const app = await buildServer({ env, authServices: services })
  const fakes = makeFakes()
  const mailer = new FakeMailer()
  const outboundMail = makeOutboundMailService({
    repo: fakes.mail,
    mailer,
    env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
  })

  app.homeOverrides = { repo: fakes.home, analytics: fakes.analytics }
  app.analyticsOverrides = { repo: fakes.analytics }
  app.activityOverrides = { repo: fakes.activity }
  app.auditOverrides = { repo: fakes.audit }
  app.discoveryOverrides = { repo: fakes.discovery }
  app.jurisdictionOverrides = { repo: fakes.jurisdictions, jobs: new FakeJobs(), throttleDays: 7 }
  app.adminReportOverrides = { repo: fakes.reports, outboundMail }
  app.adminEventOverrides = { repo: fakes.events }
  app.adminUserOverrides = {
    repo: fakes.users,
    sessions: {
      applyStatus: () => Promise.resolve(0),
      revokeAll: () => Promise.resolve(0),
    },
  }
  app.govClaimsOverrides = {
    repo: fakes.govClaims,
    users: new InMemoryUserProvisioner(),
    revokeSessions: () => Promise.resolve(0),
  }
  app.moderationOverrides = { repo: fakes.moderation }
  app.adminMailOverrides = {
    repo: fakes.mail,
    outboundMail,
    storage: new FakeStorage(),
  }
  app.adminInboxOverrides = { repo: fakes.inbox, storage: new FakeStorage() }
  app.systemOverrides = {
    service: {
      health: () =>
        Promise.resolve({ services: [{ name: "Database", status: "ok" as const, val: "12ms" }] }),
    },
  }

  const reads: WriteAuditInput[] = []
  app.adminReadAuditOverrides = {
    sink: (input) => {
      reads.push(input)
      return Promise.resolve()
    },
  }

  const thread = await fakes.mail.createThread({
    subject: "Pothole on 3rd",
    org: "City of LA",
    jurisdictionGeoid: "0644000",
  })
  await fakes.mail.insertMessage({
    threadId: thread.id,
    direction: "out",
    fromAddr: FROM_OUTREACH,
    toAddr: "311@lacity.gov",
    body: "Please review the attached report.",
  })
  const inbound = await fakes.inbox.insertIdempotent({
    messageId: "<inbound-1@lacity.gov>",
    fromAddr: "clerk@lacity.gov",
    toAddr: "support@civfix.org",
    recipient: "support@civfix.org",
    subject: "Re: pothole",
    bodyText: "We received it.",
    bodyHtml: null,
    headers: {},
    attachments: [],
  })

  const user = await stores.users.create(OPERATOR, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const token = await services.sessions.createSession(user.id, ["operator"])
  return {
    app,
    services,
    stores,
    fakes,
    reads,
    token,
    operatorId: user.id,
    mailThreadId: thread.id,
    inboxId: inbound.id,
  }
}

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

function get(url: string): Promise<{ statusCode: number; json: () => unknown }> {
  return h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${h.token}` } })
}

describe("L4: sensitive per-subject READS write an audit row", () => {
  it("GET /admin/users/:id audits user.detail_viewed for the acting operator", async () => {
    const res = await get(`/v1/admin/users/${SUBJECT_USER}`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { name: string }).name).toBe("Jane Neighbor")
    expect(h.reads).toEqual([
      {
        actorId: h.operatorId,
        action: "user.detail_viewed",
        target: `user:${SUBJECT_USER}`,
        meta: null,
      },
    ])
  })

  it("GET /admin/users/:id/messages audits user.messages_viewed with the returned count + cursor", async () => {
    const res = await get(`/v1/admin/users/${SUBJECT_USER}/messages`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { items: { text: string }[] }).items[0]?.text).toBe("Meeting at the pier")
    expect(h.reads).toEqual([
      {
        actorId: h.operatorId,
        action: "user.messages_viewed",
        target: `user:${SUBJECT_USER}`,
        meta: { returned: 1, cursor: null },
      },
    ])
  })

  it("GET /admin/mail/:id audits mail.thread_viewed", async () => {
    const res = await get(`/v1/admin/mail/${h.mailThreadId}`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { subject: string }).subject).toBe("Pothole on 3rd")
    expect(h.reads).toEqual([
      {
        actorId: h.operatorId,
        action: "mail.thread_viewed",
        target: `mail:${h.mailThreadId}`,
        meta: null,
      },
    ])
  })

  it("GET /admin/inbox/:id audits inbox.message_viewed with the attachment count", async () => {
    const res = await get(`/v1/admin/inbox/${h.inboxId}`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { subject: string }).subject).toBe("Re: pothole")
    expect(h.reads).toEqual([
      {
        actorId: h.operatorId,
        action: "inbox.message_viewed",
        target: `inbound_email:${h.inboxId}`,
        meta: { attachments: 0 },
      },
    ])
  })

  it("does NOT audit the public sub-lists or any aggregate/list surface", async () => {
    for (const url of [
      `/v1/admin/users/${SUBJECT_USER}/reports`,
      `/v1/admin/users/${SUBJECT_USER}/events`,
      "/v1/admin/users",
      "/v1/admin/mail",
      "/v1/admin/inbox",
      "/v1/admin/reports",
      `/v1/admin/reports/${SUBJECT_REPORT}`,
      "/v1/admin/moderation",
      `/v1/admin/moderation/${SUBJECT_MODERATION}`,
      "/v1/admin/audit",
      "/v1/admin/home/summary",
    ]) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(200)
    }
    expect(h.reads).toEqual([])
  })

  it("writes NO audit row when the audited read itself fails (404 before the audit)", async () => {
    const missingUser = await get(`/v1/admin/users/${UNKNOWN_ID}`)
    expect(missingUser.statusCode).toBe(404)
    const missingThread = await get(`/v1/admin/mail/${UNKNOWN_ID}`)
    expect(missingThread.statusCode).toBe(404)
    const missingInbound = await get(`/v1/admin/inbox/${UNKNOWN_ID}`)
    expect(missingInbound.statusCode).toBe(404)
    expect(h.reads).toEqual([])
  })

  it("still serves the read when the audit sink REJECTS (best-effort, never fails the request)", async () => {
    h.app.adminReadAuditOverrides = { sink: () => Promise.reject(new Error("audit table down")) }
    const res = await get(`/v1/admin/users/${SUBJECT_USER}/messages`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1)
  })
})

describe("every admin router answers a happy-path read", () => {
  it("home: summary + map project the repo's counts and pins", async () => {
    const summary = await get("/v1/admin/home/summary")
    expect(summary.statusCode).toBe(200)
    const body = summary.json() as {
      discovery: { queue: number; reportsWaiting: number }
      livePins24h: number
    }
    expect(body.discovery.queue).toBe(4)
    expect(body.discovery.reportsWaiting).toBe(11)
    expect(body.livePins24h).toBe(9)

    const map = await get("/v1/admin/home/map")
    expect(map.statusCode).toBe(200)
    const pins = (map.json() as { pins: { id: string; title: string }[] }).pins
    expect(pins).toHaveLength(1)
    expect(pins[0]?.title).toBe("Overflowing bin")
  })

  it("analytics: kpis derive the delta + direction from the repo aggregates", async () => {
    const res = await get("/v1/admin/analytics/kpis")
    expect(res.statusCode).toBe(200)
    const kpis = (res.json() as { kpis: { label: string; num: number; dir: string }[] }).kpis
    const pins = kpis.find((k) => k.label.toLowerCase().includes("pin"))
    expect(pins?.num).toBe(120)
    expect(pins?.dir).toBe("up")
  })

  it("activity: the feed classifies the seeded source row", async () => {
    const res = await get("/v1/admin/activity")
    expect(res.statusCode).toBe(200)
    const items = (res.json() as { items: { id: string; who: string; kind: string }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.who).toBe("Jane Neighbor")
    expect(items[0]?.kind).toBe("pin")
  })

  it("audit: the log lists the seeded row with its actor + target", async () => {
    const res = await get("/v1/admin/audit")
    expect(res.statusCode).toBe(200)
    const items = (res.json() as { items: { action: string; actorName: string; target: string }[] })
      .items
    expect(items).toHaveLength(1)
    expect(items[0]?.action).toBe("report.status_changed")
    expect(items[0]?.actorName).toBe("Operator A")
    expect(items[0]?.target).toBe(`report:${SUBJECT_REPORT}`)
  })

  it("audit: honors the action filter (a query param the route must forward)", async () => {
    h.fakes.audit.seedRow({ action: "user.banned", actorName: "Operator B" })
    expect((await get("/v1/admin/audit")).json()).toMatchObject({ items: expect.any(Array) })
    const filtered = await get("/v1/admin/audit?action=user.banned")
    expect(filtered.statusCode).toBe(200)
    const items = (filtered.json() as { items: { action: string }[] }).items
    expect(items.map((i) => i.action)).toEqual(["user.banned"])
  })

  it("discovery: list + detail project the seeded task", async () => {
    const list = await get("/v1/admin/discovery")
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: { id: string; place: string }[] }).items
    expect(items.map((i) => i.id)).toEqual([SUBJECT_DISCOVERY])
    expect(items[0]?.place).toBe("Los Angeles")

    const detail = await get(`/v1/admin/discovery/${SUBJECT_DISCOVERY}`)
    expect(detail.statusCode).toBe(200)
    expect(detail.json() as { id: string; geoid: string; place: string }).toMatchObject({
      id: SUBJECT_DISCOVERY,
      geoid: "0644000",
      place: "Los Angeles",
    })
  })

  it("jurisdictions: the directory projects the seeded contact + method", async () => {
    const res = await get("/v1/admin/jurisdictions")
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: { geoid: string; org: string; email: string }[] }
    const row = body.items.find((i) => i.geoid === "0644000")
    expect(row?.org).toBe("Los Angeles")
    expect(row?.email).toBe("311@lacity.gov")
  })

  it("reports: list + detail project the seeded report", async () => {
    const list = await get("/v1/admin/reports")
    expect(list.statusCode).toBe(200)
    const body = list.json() as { items: { id: string; title: string }[]; counts: { all: number } }
    expect(body.items.map((i) => i.id)).toEqual([SUBJECT_REPORT])
    expect(body.items[0]?.title).toBe("Overflowing bin")
    expect(body.counts.all).toBe(1)

    const detail = await get(`/v1/admin/reports/${SUBJECT_REPORT}`)
    expect(detail.statusCode).toBe(200)
    expect((detail.json() as { title: string }).title).toBe("Overflowing bin")
  })

  it("reports: forwards the q filter (a search that matches nothing returns an empty page, not everything)", async () => {
    const hit = await get("/v1/admin/reports?q=overflowing")
    expect((hit.json() as { items: unknown[] }).items).toHaveLength(1)
    const miss = await get("/v1/admin/reports?q=zzzz-no-such-report")
    expect(miss.statusCode).toBe(200)
    expect((miss.json() as { items: unknown[]; counts: { all: number } }).items).toHaveLength(0)
  })

  it("events: list + detail project the seeded event", async () => {
    const list = await get("/v1/admin/events")
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: { id: string; title: string }[] }).items
    expect(items.map((i) => i.id)).toEqual([SUBJECT_EVENT])
    expect(items[0]?.title).toBe("Beach sweep")

    const detail = await get(`/v1/admin/events/${SUBJECT_EVENT}`)
    expect(detail.statusCode).toBe(200)
    expect((detail.json() as { title: string }).title).toBe("Beach sweep")
  })

  it("users: list + the three sub-activity tabs project the seeded rows", async () => {
    const list = await get("/v1/admin/users")
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: { id: string; name: string }[] }).items
    expect(items.map((i) => i.id)).toEqual([SUBJECT_USER])
    expect(items[0]?.name).toBe("Jane Neighbor")

    const reports = await get(`/v1/admin/users/${SUBJECT_USER}/reports`)
    expect(reports.statusCode).toBe(200)
    expect((reports.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      SUBJECT_REPORT,
    ])

    const events = await get(`/v1/admin/users/${SUBJECT_USER}/events`)
    expect(events.statusCode).toBe(200)
    expect((events.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      SUBJECT_EVENT,
    ])
  })

  it("gov-claims: list + detail project the seeded pending claim", async () => {
    const list = await get("/v1/admin/gov-claims")
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: { id: string; name: string; org: string }[] }).items
    expect(items.map((i) => i.id)).toEqual([SUBJECT_CLAIM])
    expect(items[0]?.name).toBe("Dana Lee")
    expect(items[0]?.org).toBe("City of Los Angeles")

    const detail = await get(`/v1/admin/gov-claims/${SUBJECT_CLAIM}`)
    expect(detail.statusCode).toBe(200)
    expect((detail.json() as { name: string }).name).toBe("Dana Lee")
  })

  it("moderation: list + detail project the seeded open item", async () => {
    const list = await get("/v1/admin/moderation")
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: { id: string; flag: string; priority: string }[] }).items
    expect(items.map((i) => i.id)).toEqual([SUBJECT_MODERATION])
    expect(items[0]?.flag).toBe("NSFW image")
    expect(items[0]?.priority).toBe("high")

    const detail = await get(`/v1/admin/moderation/${SUBJECT_MODERATION}`)
    expect(detail.statusCode).toBe(200)
    expect((detail.json() as { flag: string }).flag).toBe("NSFW image")
  })

  it("mail: stats + list + thread project the seeded correspondence", async () => {
    const stats = await get("/v1/admin/mail/stats")
    expect(stats.statusCode).toBe(200)
    expect((stats.json() as { threads: number }).threads).toBe(1)

    const list = await get("/v1/admin/mail")
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: { id: string; subject: string }[] }).items
    expect(items.map((i) => i.id)).toEqual([h.mailThreadId])
    expect(items[0]?.subject).toBe("Pothole on 3rd")

    const thread = await get(`/v1/admin/mail/${h.mailThreadId}`)
    expect(thread.statusCode).toBe(200)
    const dto = thread.json() as { messages: { dir: string; body: string }[] }
    expect(dto.messages).toHaveLength(1)
    expect(dto.messages[0]?.dir).toBe("out")
  })

  it("system: health projects the injected probe rows", async () => {
    const res = await get("/v1/admin/system/health")
    expect(res.statusCode).toBe(200)
    expect((res.json() as { services: { name: string; status: string }[] }).services).toEqual([
      { name: "Database", status: "ok", val: "12ms" },
    ])
  })
})

describe("every admin list route rejects a malformed query with 422", () => {
  const LIST_ROUTES = [
    "/v1/admin/activity",
    "/v1/admin/audit",
    "/v1/admin/discovery",
    "/v1/admin/jurisdictions",
    "/v1/admin/reports",
    "/v1/admin/events",
    "/v1/admin/users",
    "/v1/admin/gov-claims",
    "/v1/admin/moderation",
    "/v1/admin/mail",
    "/v1/admin/inbox",
  ] as const

  it("422s a non-numeric limit on every list route", async () => {
    for (const url of LIST_ROUTES) {
      const res = await get(`${url}?limit=abc`)
      expect(res.statusCode, `${url} limit=abc`).toBe(422)
      const body = res.json() as { code: string; fields?: Record<string, string> }
      expect(body.code, url).toBe("VALIDATION")
      expect(body.fields, url).toHaveProperty("limit")
    }
  })

  it("422s an out-of-range limit (0 and >100) on every list route", async () => {
    for (const url of LIST_ROUTES) {
      expect((await get(`${url}?limit=0`)).statusCode, `${url} limit=0`).toBe(422)
      expect((await get(`${url}?limit=101`)).statusCode, `${url} limit=101`).toBe(422)
    }
  })

  it("422s router-specific bad enums (jurisdictions layer, mail dir, inbox status, reports filter)", async () => {
    const layer = await get("/v1/admin/jurisdictions?layer=galaxy")
    expect(layer.statusCode).toBe(422)
    expect((layer.json() as { fields?: Record<string, string> }).fields).toHaveProperty("layer")

    const dir = await get("/v1/admin/mail?dir=sideways")
    expect(dir.statusCode).toBe(422)
    expect((dir.json() as { fields?: Record<string, string> }).fields).toHaveProperty("dir")

    const status = await get("/v1/admin/inbox?status=bogus")
    expect(status.statusCode).toBe(422)
    expect((status.json() as { fields?: Record<string, string> }).fields).toHaveProperty("status")

    const facet = await get("/v1/admin/reports?filter=not-a-facet")
    expect(facet.statusCode).toBe(422)
    expect((facet.json() as { fields?: Record<string, string> }).fields).toHaveProperty("filter")
  })

  it("422s a non-numeric limit on the user sub-lists (their own query schema)", async () => {
    for (const tab of ["reports", "events", "messages"]) {
      const res = await get(`/v1/admin/users/${SUBJECT_USER}/${tab}?limit=abc`)
      expect(res.statusCode, tab).toBe(422)
      expect((res.json() as { fields?: Record<string, string> }).fields, tab).toHaveProperty("limit")
    }
    expect(h.reads).toEqual([])
  })

  it("degrades an unrecognized free-form filter/sort to the default instead of 422ing", async () => {
    const res = await get("/v1/admin/activity?filter=not-a-kind&sort=not-a-sort")
    expect(res.statusCode).toBe(200)
    expect((res.json() as { items: { who: string }[] }).items.map((i) => i.who)).toEqual([
      "Jane Neighbor",
    ])
    const sorted = await get("/v1/admin/reports?sort=not-a-sort")
    expect(sorted.statusCode).toBe(200)
    expect((sorted.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      SUBJECT_REPORT,
    ])
  })
})

describe("F092: GET /admin/mail/:id presigns inbound attachment keys", () => {
  it("returns an absolute presigned URL per attachment, never the raw object key", async () => {
    await h.fakes.mail.insertMessage({
      threadId: h.mailThreadId,
      direction: "in",
      fromAddr: "311@lacity.gov",
      body: "Here is the permit.",
      attachments: [
        { key: `inbound-mail/${h.mailThreadId}/permit.pdf`, filename: "permit.pdf", size: 1024 },
        { key: `inbound-mail/${h.mailThreadId}/photo.jpg`, filename: "photo.jpg", size: 2048 },
      ],
    })

    const res = await get(`/v1/admin/mail/${h.mailThreadId}`)
    expect(res.statusCode).toBe(200)
    const dto = res.json() as {
      messages: { attachments: { key: string; filename: string }[] }[]
    }
    const inbound = dto.messages.at(-1)!
    expect(inbound.attachments.map((a) => a.filename)).toEqual(["permit.pdf", "photo.jpg"])
    for (const att of inbound.attachments) {
      expect(att.key).toBe(`memory://inbound-mail/${h.mailThreadId}/${att.filename}`)
      expect(att.key).not.toMatch(/^inbound-mail\//)
    }
  })

  it("caps the presigned attachments per message so a many-part thread cannot fan out unbounded", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      key: `inbound-mail/${h.mailThreadId}/f${i}.bin`,
      filename: `f${i}.bin`,
      size: 1,
    }))
    await h.fakes.mail.insertMessage({
      threadId: h.mailThreadId,
      direction: "in",
      fromAddr: "311@lacity.gov",
      body: "many parts",
      attachments: many,
    })

    const res = await get(`/v1/admin/mail/${h.mailThreadId}`)
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { messages: { attachments: { key: string }[] }[] }
    const inbound = dto.messages.at(-1)!
    expect(inbound.attachments).toHaveLength(50)
    expect(inbound.attachments.every((a) => a.key.startsWith("memory://"))).toBe(true)
  })
})
