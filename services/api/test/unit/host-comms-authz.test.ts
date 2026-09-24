import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { CleanupMemberRole, EventVisibility, OrganizationMemberRole } from "@civfix/shared"
import { endpoints, versionedPath } from "@civfix/shared/client"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import type { HostAnalyticsOverrides } from "../../src/routes/host/analytics.routes.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import type { CommsRuntime } from "../../src/services/host/comms-wiring.js"
import type { HostExportRecord } from "../../src/services/host/export-repository.drizzle.js"
import type { HostExportService } from "../../src/services/host/export-service.js"
import { bearer, makeAuthHarness, type AuthHarness, type SignedIn } from "../helpers/auth.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PRIVATE_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const ORGANIZER_OF_RECORD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const OTHER_REQUESTER = "ffffffff-ffff-4fff-8fff-ffffffffffff"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 20,
  recipientsPerDay: 1000,
  cooldownSec: 0,
  minAccountAgeHours: 0,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 4,
  emailRatePerSec: 10,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

const BROADCAST_BODY = {
  subject: "Bring gloves",
  bodyMd: "See you at the meeting point.",
  segment: { kind: "all_registered" },
  channels: ["email"],
}

interface EventFixture {
  visibility: EventVisibility
  organizationId: string | null
}

// The routes under test call authz.ts over container.getDb().sql directly (no guard seam), so the fake
// SQL answers the two standing lookups (hostStandingOf, orgStandingOf) from this world and the real
// requireCapability / requireOrgCapability / resolveVisibleStanding decide every refusal below.
interface StandingWorld {
  events: Map<string, EventFixture>
  eventRoles: Map<string, CleanupMemberRole>
  orgRoles: Map<string, OrganizationMemberRole>
}

function key(scopeId: string, userId: string): string {
  return `${scopeId}:${userId}`
}

function standingSql(world: StandingWorld) {
  return makeFakeSql([
    {
      match: /FROM cleanups c\s+LEFT JOIN cleanup_members m/,
      rows: (values) => {
        const userId = values[0] as string | null
        const cleanupId = values[2] as string
        const event = world.events.get(cleanupId)
        if (event === undefined) return []
        return [
          {
            cleanup_id: cleanupId,
            organizer_user_id: ORGANIZER_OF_RECORD,
            organization_id: event.organizationId,
            visibility: event.visibility,
            event_role:
              userId === null ? null : (world.eventRoles.get(key(cleanupId, userId)) ?? null),
            org_role:
              userId === null || event.organizationId === null
                ? null
                : (world.orgRoles.get(key(event.organizationId, userId)) ?? null),
          },
        ]
      },
    },
    {
      match: /FROM organization_members om\s+JOIN organizations o/,
      rows: (values) => {
        const role = world.orgRoles.get(key(values[0] as string, values[1] as string))
        return role === undefined ? [] : [{ role }]
      },
    },
  ]).sql
}

function exportRecord(over: Partial<HostExportRecord> & { id: string }): HostExportRecord {
  return {
    cleanupId: EVENT_A,
    organizationId: null,
    requestedBy: OTHER_REQUESTER,
    kind: "roster",
    filters: {},
    status: "ready",
    r2Key: "exports/roster.csv",
    rowCount: 3,
    byteSize: 120,
    truncated: false,
    errorCode: null,
    runToken: null,
    requestedAt: new Date("2026-09-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: new Date("2026-09-01T00:01:00.000Z"),
    expiresAt: new Date("2026-09-08T00:00:00.000Z"),
    ...over,
  }
}

function exportService(records: Map<string, HostExportRecord>): HostExportService {
  return {
    request: () => Promise.reject(new Error("not used")),
    listForEvent: () => Promise.resolve([]),
    listForOrganization: () => Promise.resolve([]),
    get: async (exportId) => {
      const record = records.get(exportId)
      if (record === undefined) {
        const { AppError } = await import("@civfix/shared")
        throw AppError.notFound("Export not found")
      }
      return record
    },
    run: () => Promise.resolve({ status: "ready" as const }),
    downloadUrl: (record) =>
      Promise.resolve({
        url: `https://example.test/${record.id}.csv`,
        expiresAt: "2026-09-01T00:05:00.000Z",
        filename: "roster.csv",
      }),
    reap: () => Promise.resolve({ reaped: 0 }),
  }
}

// Only the methods the routes under test reach; the refusals under test happen before any of them.
function analyticsOverrides(): HostAnalyticsOverrides {
  return {
    analytics: {
      overview: () => Promise.resolve({ stub: "overview" }),
      portfolio: () => Promise.resolve({ stub: "portfolio" }),
      summary: () => Promise.resolve({ stub: "summary" }),
    },
    eventAnalytics: { analytics: () => Promise.resolve({ stub: "analytics" }) },
    insights: { insights: () => Promise.resolve({ stub: "insights" }) },
  } as unknown as HostAnalyticsOverrides
}

interface Harness {
  auth: AuthHarness
  world: StandingWorld
  broadcasts: InMemoryBroadcastRepository
  exports: Map<string, HostExportRecord>
}

let current: AuthHarness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const world: StandingWorld = {
    events: new Map([
      [EVENT_A, { visibility: "public", organizationId: ORG }],
      [EVENT_B, { visibility: "public", organizationId: null }],
      [PRIVATE_EVENT, { visibility: "private", organizationId: null }],
    ]),
    eventRoles: new Map(),
    orgRoles: new Map(),
  }
  const sql = standingSql(world)

  const broadcasts = new InMemoryBroadcastRepository()
  for (const cleanupId of [EVENT_A, EVENT_B, PRIVATE_EVENT]) {
    broadcasts.seedEvent({
      cleanupId,
      title: "Beach Cleanup",
      pageSlug: null,
      scheduledAt: new Date("2027-02-01T17:00:00Z"),
      endsAt: null,
      timezone: "UTC",
      address: null,
      status: "upcoming",
      organizerUserId: ORGANIZER_OF_RECORD,
      replyTo: null,
      replyToVerified: false,
    })
  }
  const service = makeBroadcastService({
    repo: broadcasts,
    counters: new InMemoryCounterStore(),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan: () => Promise.resolve(),
  })
  const exports = new Map<string, HostExportRecord>()

  const container = {
    ...buildContainer(loadEnv({ NODE_ENV: "test" })),
    getDb: () => ({ sql }),
  } as unknown as Container
  const auth = await makeAuthHarness({
    server: {
      container,
      broadcastOverrides: { runtime: { broadcasts: service } as unknown as CommsRuntime },
      hostAnalyticsOverrides: analyticsOverrides(),
      hostExportOverrides: { exports: exportService(exports) },
    },
  })
  current = auth
  return { auth, world, broadcasts, exports }
}

function pathFor(name: keyof typeof endpoints, params: Record<string, string> = {}): string {
  let path = versionedPath(endpoints[name])
  for (const [param, value] of Object.entries(params)) path = path.replace(`:${param}`, value)
  return path
}

async function signInAs(
  h: Harness,
  email: string,
  eventRole: CleanupMemberRole | null,
  cleanupId: string = EVENT_A,
): Promise<SignedIn> {
  const who = await h.auth.signIn(email)
  if (eventRole !== null) h.world.eventRoles.set(key(cleanupId, who.userId), eventRole)
  h.broadcasts.seedHost(who.userId, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  return who
}

async function seedBroadcast(h: Harness, cleanupId: string) {
  return h.broadcasts.create({
    cleanupId,
    createdBy: ORGANIZER_OF_RECORD,
    kind: "host_broadcast",
    subject: "Original subject",
    bodyMd: "Original body",
    segment: { kind: "all_registered" },
    channels: ["email"],
  })
}

describe("host broadcasts are scoped to the event in the path (BE-TEST-037)", () => {
  it("404s the organizer of A reading, editing or cancelling B's broadcast through A's path", async () => {
    const h = await makeHarness()
    const organizer = await signInAs(h, "organizer@example.com", "organizer")
    const ofB = await seedBroadcast(h, EVENT_B)

    const read = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventBroadcast", { id: EVENT_A, broadcastId: ofB.id }),
      headers: bearer(organizer.token),
    })
    expect(read.statusCode).toBe(404)
    expect(read.json()).toMatchObject({ code: "NOT_FOUND", message: "Message not found" })

    const edit = await h.auth.app.inject({
      method: "PATCH",
      url: pathFor("updateEventBroadcast", { id: EVENT_A, broadcastId: ofB.id }),
      headers: bearer(organizer.token),
      payload: { subject: "Hijacked" },
    })
    expect(edit.statusCode).toBe(404)

    const cancel = await h.auth.app.inject({
      method: "POST",
      url: pathFor("cancelEventBroadcast", { id: EVENT_A, broadcastId: ofB.id }),
      headers: bearer(organizer.token),
      payload: {},
    })
    expect(cancel.statusCode).toBe(404)

    const after = await h.broadcasts.findById(ofB.id)
    expect(after?.status).toBe("draft")
    expect(after?.subject).toBe("Original subject")
  })

  it("answers 409 (pinned; not 404) when the organizer of A deletes B's broadcast through A's path", async () => {
    const h = await makeHarness()
    const organizer = await signInAs(h, "organizer@example.com", "organizer")
    const ofB = await seedBroadcast(h, EVENT_B)
    const res = await h.auth.app.inject({
      method: "DELETE",
      url: pathFor("deleteEventBroadcast", { id: EVENT_A, broadcastId: ofB.id }),
      headers: bearer(organizer.token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: "CONFLICT",
      message: "That message can no longer be deleted.",
    })
    expect(await h.broadcasts.findById(ofB.id)).not.toBeNull()
  })

  it("403s the organizer of A on B's own broadcast path, and 404s them on a private event", async () => {
    const h = await makeHarness()
    const organizer = await signInAs(h, "organizer@example.com", "organizer")
    const ofB = await seedBroadcast(h, EVENT_B)
    const onB = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventBroadcast", { id: EVENT_B, broadcastId: ofB.id }),
      headers: bearer(organizer.token),
    })
    expect(onB.statusCode).toBe(403)
    const listPrivate = await h.auth.app.inject({
      method: "GET",
      url: pathFor("listEventBroadcasts", { id: PRIVATE_EVENT }),
      headers: bearer(organizer.token),
    })
    expect(listPrivate.statusCode).toBe(404)
    expect(listPrivate.json()).toMatchObject({ code: "NOT_FOUND", message: "Cleanup not found" })
  })

  it("403s event staff composing a broadcast and creates nothing", async () => {
    const h = await makeHarness()
    const staff = await signInAs(h, "staff@example.com", "staff")
    const res = await h.auth.app.inject({
      method: "POST",
      url: pathFor("createEventBroadcast", { id: EVENT_A }),
      headers: bearer(staff.token),
      payload: BROADCAST_BODY,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "Only the event hosts can send messages to attendees.",
    })
    expect(await h.broadcasts.list({ cleanupId: EVENT_A, cursor: null, limit: 50 })).toEqual([])
  })

  it("403s event staff listing broadcasts, and lets a cohost compose one", async () => {
    const h = await makeHarness()
    const staff = await signInAs(h, "staff@example.com", "staff")
    const cohost = await signInAs(h, "cohost@example.com", "cohost")
    const list = await h.auth.app.inject({
      method: "GET",
      url: pathFor("listEventBroadcasts", { id: EVENT_A }),
      headers: bearer(staff.token),
    })
    expect(list.statusCode).toBe(403)
    const created = await h.auth.app.inject({
      method: "POST",
      url: pathFor("createEventBroadcast", { id: EVENT_A }),
      headers: bearer(cohost.token),
      payload: BROADCAST_BODY,
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json().cleanupId).toBe(EVENT_A)
  })
})

describe("host announcements (BE-TEST-037)", () => {
  it("404s an anonymous read of a private event's announcements", async () => {
    const h = await makeHarness()
    const list = await h.auth.app.inject({
      method: "GET",
      url: pathFor("listEventAnnouncements", { id: PRIVATE_EVENT }),
    })
    expect(list.statusCode).toBe(404)
    expect(list.json()).toMatchObject({ code: "NOT_FOUND", message: "Cleanup not found" })
    const one = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventAnnouncement", { id: PRIVATE_EVENT, announcementId: randomUUID() }),
    })
    expect(one.statusCode).toBe(404)
  })

  it("403s event staff posting an announcement", async () => {
    const h = await makeHarness()
    const staff = await signInAs(h, "staff@example.com", "staff")
    const res = await h.auth.app.inject({
      method: "POST",
      url: pathFor("createEventAnnouncement", { id: EVENT_A }),
      headers: bearer(staff.token),
      payload: { bodyMd: "Parking moved", audience: { kind: "all_registered" } },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("host exports (BE-TEST-037)", () => {
  it("404s the organizer of A reading B's export through A's path", async () => {
    const h = await makeHarness()
    const organizer = await signInAs(h, "organizer@example.com", "organizer")
    const ofB = randomUUID()
    h.exports.set(ofB, exportRecord({ id: ofB, cleanupId: EVENT_B, requestedBy: organizer.userId }))
    const res = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventExport", { id: EVENT_A, exportId: ofB }),
      headers: bearer(organizer.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "NOT_FOUND", message: "Export not found" })
  })

  it("serves A's own export to the organizer of A", async () => {
    const h = await makeHarness()
    const organizer = await signInAs(h, "organizer@example.com", "organizer")
    const ofA = randomUUID()
    h.exports.set(ofA, exportRecord({ id: ofA }))
    const res = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventExport", { id: EVENT_A, exportId: ofA }),
      headers: bearer(organizer.token),
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ id: ofA, cleanupId: EVENT_A })
  })

  it("403s a coordinator (no export capability) listing exports", async () => {
    const h = await makeHarness()
    const coordinator = await signInAs(h, "coordinator@example.com", "coordinator")
    const res = await h.auth.app.inject({
      method: "GET",
      url: pathFor("listEventExports", { id: EVENT_A }),
      headers: bearer(coordinator.token),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      message: "Only the event hosts can export attendee data.",
    })
  })

  it("404s the download for a cohost who did not request the export", async () => {
    const h = await makeHarness()
    const cohost = await signInAs(h, "cohost@example.com", "cohost")
    const exportId = randomUUID()
    h.exports.set(exportId, exportRecord({ id: exportId, requestedBy: OTHER_REQUESTER }))
    const res = await h.auth.app.inject({
      method: "GET",
      url: pathFor("downloadHostExport", { id: exportId }),
      headers: bearer(cohost.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "NOT_FOUND", message: "Export not found" })
  })

  it("serves the download to its requester, and 403s them once they lose the export capability", async () => {
    const h = await makeHarness()
    const requester = await signInAs(h, "cohost@example.com", "cohost")
    const exportId = randomUUID()
    h.exports.set(exportId, exportRecord({ id: exportId, requestedBy: requester.userId }))
    const ok = await h.auth.app.inject({
      method: "GET",
      url: pathFor("downloadHostExport", { id: exportId }),
      headers: bearer(requester.token),
    })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().url).toBe(`https://example.test/${exportId}.csv`)

    h.world.eventRoles.set(key(EVENT_A, requester.userId), "staff")
    const demoted = await h.auth.app.inject({
      method: "GET",
      url: pathFor("downloadHostExport", { id: exportId }),
      headers: bearer(requester.token),
    })
    expect(demoted.statusCode).toBe(403)
  })
})

describe("host analytics and insights (BE-TEST-037)", () => {
  it("403s event staff on insights, the analytics read and the analytics overview", async () => {
    const h = await makeHarness()
    const staff = await signInAs(h, "staff@example.com", "staff")
    for (const url of [
      pathFor("getEventInsights", { id: EVENT_A }),
      pathFor("getEventAnalytics", { id: EVENT_A }),
      pathFor("eventAnalyticsOverview", { id: EVENT_A }),
    ]) {
      const res = await h.auth.app.inject({ method: "GET", url, headers: bearer(staff.token) })
      expect(res.statusCode, url).toBe(403)
      expect(res.json()).toMatchObject({ message: "Only the event hosts can view analytics." })
    }
  })

  it("404s a stranger on a private event's insights and 403s them on a public one", async () => {
    const h = await makeHarness()
    const stranger = await signInAs(h, "stranger@example.com", null)
    const onPrivate = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventInsights", { id: PRIVATE_EVENT }),
      headers: bearer(stranger.token),
    })
    expect(onPrivate.statusCode).toBe(404)
    const onPublic = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventInsights", { id: EVENT_A }),
      headers: bearer(stranger.token),
    })
    expect(onPublic.statusCode).toBe(403)
  })

  it("serves insights to a coordinator (view_analytics + view_roster)", async () => {
    const h = await makeHarness()
    const coordinator = await signInAs(h, "coordinator@example.com", "coordinator")
    const res = await h.auth.app.inject({
      method: "GET",
      url: pathFor("getEventInsights", { id: EVENT_A }),
      headers: bearer(coordinator.token),
    })
    expect(res.statusCode, res.body).toBe(200)
  })

  it("scopes hosted-events analytics by org: member 403, non-member 404, admin 200", async () => {
    const h = await makeHarness()
    const actor = await signInAs(h, "orguser@example.com", null)
    for (const name of ["hostedEventsAnalytics", "hostedEventsAnalyticsSummary"] as const) {
      const url = `${pathFor(name)}?orgId=${ORG}`

      h.world.orgRoles.clear()
      const stranger = await h.auth.app.inject({ method: "GET", url, headers: bearer(actor.token) })
      expect(stranger.statusCode, name).toBe(404)
      expect(stranger.json()).toMatchObject({ message: "Organization not found" })

      h.world.orgRoles.set(key(ORG, actor.userId), "member")
      const member = await h.auth.app.inject({ method: "GET", url, headers: bearer(actor.token) })
      expect(member.statusCode, name).toBe(403)
      expect(member.json()).toMatchObject({ message: "Only the event hosts can view analytics." })

      h.world.orgRoles.set(key(ORG, actor.userId), "admin")
      const admin = await h.auth.app.inject({ method: "GET", url, headers: bearer(actor.token) })
      expect(admin.statusCode, name).toBe(200)
    }
  })
})
