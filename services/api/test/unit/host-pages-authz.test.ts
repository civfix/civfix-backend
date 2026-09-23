import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type {
  CleanupMemberRole,
  EventVisibility,
  HostCapability,
  OrganizationMemberRole,
} from "@civfix/shared"
import { endpoints, versionedPath } from "@civfix/shared/client"
import { can } from "@civfix/shared/host"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { buildContainer, type Container } from "../../src/di.js"
import type { Queryable } from "../../src/db/client.js"
import { loadEnv } from "../../src/env.js"
import { requireCapability, resolveVisibleStanding } from "../../src/services/host/authz.js"
import { hostStandingOf } from "../../src/services/host/host-standing.js"
import { InMemoryHostRegistrationRepository } from "../../src/services/host/registration-repository.memory.js"
import type { HostGuards } from "../../src/services/host/registration-wiring.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import { bearer, makeAuthHarness, type AuthHarness, type SignedIn } from "../helpers/auth.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PRIVATE_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const ORGANIZER_OF_RECORD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const tokens = makeTicketTokenSigner("host-pages-authz-test-secret-long-enough")

interface EventFixture {
  visibility: EventVisibility
  organizationId: string | null
}

// The standing world the fake SQL answers from. requireCapability / resolveVisibleStanding /
// hostStandingOf run unmodified over it, so the refusals below come from the real authz code and the
// real capability matrix rather than from a hand-written allow/deny stub.
interface StandingWorld {
  events: Map<string, EventFixture>
  eventRoles: Map<string, CleanupMemberRole>
  orgRoles: Map<string, OrganizationMemberRole>
}

function key(scopeId: string, userId: string): string {
  return `${scopeId}:${userId}`
}

function standingSql(world: StandingWorld): Queryable {
  const fake = makeFakeSql([
    {
      match: /FROM cleanups c\s+LEFT JOIN cleanup_members m/,
      rows: (values) => {
        const userId = values[0] as string | null
        const cleanupId = values[2] as string
        const event = world.events.get(cleanupId)
        if (event === undefined) return []
        const orgRole =
          event.organizationId === null || userId === null
            ? null
            : (world.orgRoles.get(key(event.organizationId, userId)) ?? null)
        return [
          {
            cleanup_id: cleanupId,
            organizer_user_id: ORGANIZER_OF_RECORD,
            organization_id: event.organizationId,
            visibility: event.visibility,
            event_role:
              userId === null ? null : (world.eventRoles.get(key(cleanupId, userId)) ?? null),
            org_role: orgRole,
          },
        ]
      },
    },
  ])
  return fake.sql as unknown as Queryable
}

// Same shape as the production branch of makeHostGuards, which the route layer cannot reach once a
// memory repo is injected (a repo override alone yields OPEN_HOST_GUARDS).
function realGuards(sql: Queryable, asked: HostCapability[]): HostGuards {
  return {
    async requireCapability(cleanupId, userId, capability) {
      asked.push(capability)
      return (await requireCapability(sql, cleanupId, userId, capability)).standing
    },
    async canManage(cleanupId, userId, capability) {
      if (userId === null) return false
      const resolution = await hostStandingOf(sql, cleanupId, userId)
      if (resolution === null) return false
      return can(resolution.standing, capability)
    },
    async requireVisible(cleanupId, userId) {
      await resolveVisibleStanding(sql, cleanupId, userId)
    },
  }
}

interface Harness {
  auth: AuthHarness
  repo: InMemoryHostRegistrationRepository
  world: StandingWorld
  asked: HostCapability[]
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
      [EVENT, { visibility: "public", organizationId: ORG }],
      [OTHER_EVENT, { visibility: "public", organizationId: null }],
      [PRIVATE_EVENT, { visibility: "private", organizationId: null }],
    ]),
    eventRoles: new Map(),
    orgRoles: new Map(),
  }
  const sql = standingSql(world)
  const asked: HostCapability[] = []
  const guards = realGuards(sql, asked)

  const repo = new InMemoryHostRegistrationRepository()
  repo.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  for (const cleanupId of [EVENT, OTHER_EVENT, PRIVATE_EVENT]) repo.seedEvent({ cleanupId })

  const counters = new InMemoryCounterStore(() => Date.now())
  const container = {
    ...buildContainer(loadEnv({ NODE_ENV: "test" })),
    getDb: () => ({ sql }),
  } as unknown as Container
  const auth = await makeAuthHarness({
    server: {
      container,
      hostRegistrationOverrides: { repo, tokens, guards, counters },
      hostPageOverrides: {
        repo,
        guards,
        counters,
        standingOf: async (cleanupId, userId) =>
          userId === null
            ? null
            : ((await hostStandingOf(sql, cleanupId, userId))?.standing ?? null),
      },
    },
  })
  current = auth
  return { auth, repo, world, asked }
}

function pathFor(name: keyof typeof endpoints, params: Record<string, string>): string {
  let path = versionedPath(endpoints[name])
  for (const [param, value] of Object.entries(params)) path = path.replace(`:${param}`, value)
  return path
}

const PAGE_BODY = {
  slug: "beach-sweep",
  blocks: [{ id: "b1", kind: "about", body: "Bring gloves." }],
}

interface PageCall {
  name: string
  method: "GET" | "PUT" | "POST"
  url: (cleanupId: string) => string
  payload?: object
}

const PAGE_CALLS: readonly PageCall[] = [
  { name: "getEventPage", method: "GET", url: (id) => pathFor("getEventPage", { id }) },
  {
    name: "saveEventPage",
    method: "PUT",
    url: (id) => pathFor("saveEventPage", { id }),
    payload: PAGE_BODY,
  },
  {
    name: "publishEventPage",
    method: "POST",
    url: (id) => pathFor("publishEventPage", { id }),
    payload: { published: true },
  },
  {
    name: "checkEventPageSlug",
    method: "GET",
    url: (id) => `${pathFor("checkEventPageSlug", { id })}?slug=beach-sweep`,
  },
]

function callPage(h: Harness, who: SignedIn, call: PageCall, cleanupId: string) {
  return h.auth.app.inject({
    method: call.method,
    url: call.url(cleanupId),
    headers: bearer(who.token),
    ...(call.payload !== undefined ? { payload: call.payload } : {}),
  })
}

function standAs(
  h: Harness,
  userId: string,
  standing: { eventRole: CleanupMemberRole | null; orgRole: OrganizationMemberRole | null },
): void {
  h.world.eventRoles.clear()
  h.world.orgRoles.clear()
  if (standing.eventRole !== null) h.world.eventRoles.set(key(EVENT, userId), standing.eventRole)
  if (standing.orgRole !== null) h.world.orgRoles.set(key(ORG, userId), standing.orgRole)
}

describe("event page routes enforce manage_page (BE-TEST-032)", () => {
  it("asks for manage_page, and nothing weaker, on all four page routes", async () => {
    const h = await makeHarness()
    const actor = await h.auth.signIn("organizer@example.com")
    standAs(h, actor.userId, { eventRole: "organizer", orgRole: null })
    for (const call of PAGE_CALLS) {
      h.asked.length = 0
      const res = await callPage(h, actor, call, EVENT)
      expect(res.statusCode, `${call.name}: ${res.body}`).toBe(200)
      expect(h.asked, call.name).toEqual(["manage_page"])
    }
  })

  for (const role of ["staff", "coordinator", "member"] as const) {
    it(`403s an event ${role} on every page route and leaves the page untouched`, async () => {
      const h = await makeHarness()
      const actor = await h.auth.signIn(`${role}@example.com`)
      standAs(h, actor.userId, { eventRole: role, orgRole: null })
      for (const call of PAGE_CALLS) {
        const res = await callPage(h, actor, call, EVENT)
        expect(res.statusCode, call.name).toBe(403)
        expect(res.json()).toMatchObject({
          code: "FORBIDDEN",
          message: "Only the event hosts can edit the event page.",
        })
      }
      expect(h.repo.pages.has(EVENT)).toBe(false)
    })
  }

  it("403s a stranger on a public event and 404s one on a private event", async () => {
    const h = await makeHarness()
    const stranger = await h.auth.signIn("stranger@example.com")
    for (const call of PAGE_CALLS) {
      const onPublic = await callPage(h, stranger, call, EVENT)
      expect(onPublic.statusCode, call.name).toBe(403)
      const onPrivate = await callPage(h, stranger, call, PRIVATE_EVENT)
      expect(onPrivate.statusCode, call.name).toBe(404)
      expect(onPrivate.json()).toMatchObject({ code: "NOT_FOUND", message: "Cleanup not found" })
    }
    expect(h.repo.pages.size).toBe(0)
  })

  it("404s every page route for an event id that does not exist", async () => {
    const h = await makeHarness()
    const actor = await h.auth.signIn("organizer@example.com")
    standAs(h, actor.userId, { eventRole: "organizer", orgRole: null })
    for (const call of PAGE_CALLS) {
      const res = await callPage(h, actor, call, randomUUID())
      expect(res.statusCode, call.name).toBe(404)
    }
  })

  for (const standing of [
    { eventRole: "cohost", orgRole: null },
    { eventRole: "organizer", orgRole: null },
    { eventRole: null, orgRole: "admin" },
    { eventRole: null, orgRole: "owner" },
  ] as const) {
    it(`lets ${standing.eventRole ?? `org ${standing.orgRole}`} read, save, publish and slug-check`, async () => {
      const h = await makeHarness()
      const actor = await h.auth.signIn("host@example.com")
      standAs(h, actor.userId, standing)
      for (const call of PAGE_CALLS) {
        const res = await callPage(h, actor, call, EVENT)
        expect(res.statusCode, `${call.name}: ${res.body}`).toBe(200)
      }
      expect(h.repo.pages.get(EVENT)?.status).toBe("published")
    })
  }

  it("403s an org member (no org capability) on the page routes", async () => {
    const h = await makeHarness()
    const actor = await h.auth.signIn("orgmember@example.com")
    standAs(h, actor.userId, { eventRole: null, orgRole: "member" })
    for (const call of PAGE_CALLS) {
      const res = await callPage(h, actor, call, EVENT)
      expect(res.statusCode, call.name).toBe(403)
    }
  })

  it("403s the organizer of one event writing another event's page, which stays unchanged", async () => {
    const h = await makeHarness()
    const actor = await h.auth.signIn("organizer@example.com")
    standAs(h, actor.userId, { eventRole: "organizer", orgRole: null })
    for (const call of PAGE_CALLS) {
      const res = await callPage(h, actor, call, OTHER_EVENT)
      expect(res.statusCode, call.name).toBe(403)
    }
    expect(h.repo.pages.has(OTHER_EVENT)).toBe(false)
  })
})

describe("cancelEventRegistration self-vs-host branch (BE-TEST-027)", () => {
  async function registered(h: Harness, who: SignedIn): Promise<string> {
    const res = await h.auth.app.inject({
      method: "POST",
      url: pathFor("registerForEvent", { id: EVENT }),
      headers: bearer(who.token),
      payload: { idempotencyKey: `key-${randomUUID()}`, partySize: 1 },
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().registration.id as string
  }

  function cancel(h: Harness, who: SignedIn, registrationId: string) {
    return h.auth.app.inject({
      method: "POST",
      url: pathFor("cancelEventRegistration", { id: EVENT, registrationId }),
      headers: bearer(who.token),
      payload: {},
    })
  }

  it("403s an attendee cancelling another attendee's registration, which stays registered", async () => {
    const h = await makeHarness()
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    const alice = await h.auth.signIn("alice@example.com")
    const bob = await h.auth.signIn("bob@example.com")
    const aliceRegistration = await registered(h, alice)

    const res = await cancel(h, bob, aliceRegistration)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "Only the event hosts can edit this event.",
    })
    const after = await h.repo.findRegistration(EVENT, aliceRegistration)
    expect(after?.status).toBe("registered")
    expect(h.asked).toEqual(["manage_event"])
  })

  it("lets an attendee cancel their own registration without a host capability", async () => {
    const h = await makeHarness()
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    const alice = await h.auth.signIn("alice@example.com")
    const aliceRegistration = await registered(h, alice)

    const res = await cancel(h, alice, aliceRegistration)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().registration.status).toBe("cancelled")
    expect(h.asked).toEqual([])
  })

  it("403s (not 404s) a stranger cancelling an unknown registration id", async () => {
    const h = await makeHarness()
    const bob = await h.auth.signIn("bob@example.com")
    const res = await cancel(h, bob, randomUUID())
    expect(res.statusCode).toBe(403)
    expect(h.asked).toEqual(["manage_event"])
  })

  it("403s an event staff member cancelling someone else's registration", async () => {
    const h = await makeHarness()
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    const alice = await h.auth.signIn("alice@example.com")
    const staff = await h.auth.signIn("staff@example.com")
    h.world.eventRoles.set(key(EVENT, staff.userId), "staff")
    const aliceRegistration = await registered(h, alice)

    const res = await cancel(h, staff, aliceRegistration)
    expect(res.statusCode).toBe(403)
    expect((await h.repo.findRegistration(EVENT, aliceRegistration))?.status).toBe("registered")
  })
})
