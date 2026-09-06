import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { AppError } from "@civfix/shared"
import { NO_HOST_STANDING, can } from "@civfix/shared/host"
import { buildServer } from "../../../src/server.js"
import { buildContainer } from "../../../src/di.js"
import { loadEnv } from "../../../src/env.js"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryCacheClient } from "../../../src/auth/cache.js"
import { makeInMemoryStores } from "../../../src/auth/stores.js"
import { buildAuthServices } from "../../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../../helpers/auth.js"
import { InMemoryOrganizationRepository } from "../../../src/services/host/organization-repository.memory.js"
import { InMemoryHostTeamRepository } from "../../../src/services/host/host-team-repository.memory.js"
import { hostForbiddenCopy } from "../../../src/services/host/authz.js"
import type { HostStandingResolution } from "../../../src/services/host/host-standing.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

interface Harness {
  app: FastifyInstance
  orgs: InMemoryOrganizationRepository
  team: InMemoryHostTeamRepository
  token: string
  userId: string
  cookie: string
  csrf: string
}

let current: Harness | undefined

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const orgs = new InMemoryOrganizationRepository()
  const team = new InMemoryHostTeamRepository()

  const container = buildContainer(env)
  const app = await buildServer({
    env,
    container,
    authServices,
    organizationOverrides: {
      repo: orgs,
      counters: new InMemoryCounterStore(() => Date.now()),
    },
    hostTeamOverrides: {
      repo: team,
      counters: new InMemoryCounterStore(() => Date.now()),
      standing: (cleanupId: string, userId: string, capability: Parameters<typeof can>[1]) => {
        const role =
          team.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)?.role ?? null
        const standing = role === null ? NO_HOST_STANDING : { eventRole: role, orgRole: null }
        if (standing === NO_HOST_STANDING) {
          return Promise.reject(AppError.notFound("Cleanup not found"))
        }
        if (!can(standing, capability)) {
          return Promise.reject(AppError.forbidden(hostForbiddenCopy(capability)))
        }
        const resolution: HostStandingResolution = {
          cleanupId,
          standing,
          organizerUserId: userId,
          organizationId: null,
          visibility: "public",
        }
        return Promise.resolve(resolution)
      },
    },
    hostPortfolioOverrides: {
      repo: {
        listHostedEvents: () => Promise.resolve({ items: [], nextCursor: null }),
        kpisFor: () => Promise.resolve({ eventsHosted: 0, upcomingEvents: 0 }),
      },
    },
  })

  const email = "host@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email) as string
  const bearer = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const bearerBody = bearer.json()

  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const cookieCode = mailer.lastOtpFor(email) as string
  const web = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    payload: { email, code: cookieCode },
  })
  const setCookies = web.headers["set-cookie"]
  const cookieList = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? "")]
  const cookie = cookieList.map((c) => c.split(";")[0]).join("; ")
  const csrf = (web.json() as { csrfToken?: string }).csrfToken ?? ""

  const h: Harness = {
    app,
    orgs,
    team,
    token: bearerBody.token,
    userId: bearerBody.user.id,
    cookie,
    csrf,
  }
  current = h
  return h
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

describe("organization routes", () => {
  it("401s every authenticated route without a session", async () => {
    const { app } = await makeHarness()
    for (const [method, url] of [
      ["POST", "/v1/orgs"],
      ["GET", "/v1/me/organizations"],
      ["PATCH", `/v1/orgs/${randomUUID()}`],
      ["GET", `/v1/orgs/${randomUUID()}/members`],
      ["GET", "/v1/me/hosted-events"],
      ["GET", `/v1/cleanups/${EVENT}/team`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        ...(method === "GET" ? {} : { payload: {} }),
      })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })

  it("422s a malformed body rather than reaching the service", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: auth(token),
      payload: { name: "", slug: "Not A Slug" },
    })
    expect(res.statusCode).toBe(422)
  })

  it("creates, reads by slug and lists mine", async () => {
    const { app, token } = await makeHarness()
    const created = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: auth(token),
      payload: { name: "Ballona Creek Trust", slug: "ballona-creek-trust" },
    })
    expect(created.statusCode).toBe(201)

    const bySlug = await app.inject({
      method: "GET",
      url: "/v1/orgs/by-slug/ballona-creek-trust",
    })
    expect(bySlug.statusCode).toBe(200)
    expect(bySlug.json()).toMatchObject({ slug: "ballona-creek-trust", verifiedStatus: "unverified" })

    const mine = await app.inject({
      method: "GET",
      url: "/v1/me/organizations",
      headers: auth(token),
    })
    expect(mine.json().items).toHaveLength(1)
  })

  it("404s an unknown slug", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/orgs/by-slug/nobody-here" })
    expect(res.statusCode).toBe(404)
  })

  it("404s a non-member before it can learn the organization exists", async () => {
    const { app, token, orgs } = await makeHarness()
    const stranger = randomUUID()
    orgs.seedUser({ id: stranger })
    const org = await orgs.createOrganizationTx({
      organizationId: randomUUID(),
      slug: "someone-elses",
      name: "Someone else's",
      description: null,
      websiteUrl: null,
      logoMediaId: null,
      socialLinks: null,
      createdBy: stranger,
      now: new Date(),
    })
    const id = typeof org === "string" ? "" : org.id
    const res = await app.inject({
      method: "GET",
      url: `/v1/orgs/${id}/members`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("rejects a cookie-session mutation with no CSRF token", async () => {
    const { app, cookie } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: { cookie },
      payload: { name: "No CSRF", slug: "no-csrf" },
    })
    expect(res.statusCode).toBe(403)
  })

  it("accepts the same cookie-session mutation with the CSRF token", async () => {
    const { app, cookie, csrf } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { name: "With CSRF", slug: "with-csrf" },
    })
    expect(res.statusCode).toBe(201)
  })
})

describe("event team routes", () => {
  it("404s an event the caller has no standing on, before any 403", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${OTHER_EVENT}/team`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("403s a cohost inviting (manage_team is organizer-only)", async () => {
    const { app, token, team, userId } = await makeHarness()
    team.seedMember(EVENT, userId, "cohost")
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/team/invites`,
      headers: auth(token),
      payload: { identifierKind: "handle", identifier: "someone", role: "staff" },
    })
    expect(res.statusCode).toBe(403)
  })

  it("lists the team for a member and never leaks a full address", async () => {
    const { app, token, team, userId } = await makeHarness()
    team.seedMember(EVENT, userId, "organizer")
    team.seedUser({ id: randomUUID(), handle: "ida", email: "ida@example.org" })
    const invite = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/team/invites`,
      headers: auth(token),
      payload: { identifierKind: "email", identifier: "ida@example.org", role: "staff" },
    })
    expect(invite.statusCode).toBe(201)

    const listed = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${EVENT}/team`,
      headers: auth(token),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain("ida@example.org")
    expect(listed.json().invites).toHaveLength(1)
  })

  it("422s a token that is too short to be an invite token", async () => {
    const { app, token, team, userId } = await makeHarness()
    team.seedMember(EVENT, userId, "member")
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/team/invites/accept`,
      headers: auth(token),
      payload: { token: "short" },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("portfolio route", () => {
  it("returns an empty portfolio with KPIs for a host with no events", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/hosted-events",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      items: [],
      nextCursor: null,
      kpis: { eventsHosted: 0, upcomingEvents: 0, totalRegistrations: 0, totalCheckedIn: 0 },
    })
  })

  it("422s an unknown `when` filter", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/hosted-events?when=whenever",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(422)
  })
})
