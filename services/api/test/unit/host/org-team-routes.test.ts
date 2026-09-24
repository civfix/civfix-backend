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
import { fakeCleanupReader } from "../../helpers/host-team.js"
import { InMemoryHostTeamRepository } from "../../../src/services/host/host-team-repository.memory.js"
import { hostForbiddenCopy } from "../../../src/services/host/authz.js"
import type { HostStandingResolution } from "../../../src/services/host/host-standing-repository.drizzle.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

interface Harness {
  app: FastifyInstance
  orgs: InMemoryOrganizationRepository
  team: InMemoryHostTeamRepository
  mailer: FakeMailer
  token: string
  userId: string
  cookie: string
  csrf: string
  /** Sign in a second account (OTP) and return its bearer token. */
  signIn(email: string): Promise<string>
}

const INVITE_TOKEN = "org-invite-token-0123456789abcdefghijklmnop"

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
      newToken: () => INVITE_TOKEN,
      mailer,
    },
    hostTeamOverrides: {
      repo: team,
      counters: new InMemoryCounterStore(() => Date.now()),
      loadEvent: fakeCleanupReader(),
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

  async function signIn(otherEmail: string): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: otherEmail },
    })
    const otherCode = mailer.lastOtpFor(otherEmail) as string
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email: otherEmail, code: otherCode },
    })
    const body = res.json() as { token: string; user: { id: string } }
    // The org repo's user table is separate from the auth stores: mirror the account so the invite's
    // email-match rule can see it.
    orgs.seedUser({ id: body.user.id, displayName: otherEmail, email: otherEmail })
    return body.token
  }

  const h: Harness = {
    app,
    orgs,
    team,
    mailer,
    token: bearerBody.token,
    userId: bearerBody.user.id,
    cookie,
    csrf,
    signIn,
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
    expect(bySlug.json()).toMatchObject({
      slug: "ballona-creek-trust",
      verifiedStatus: "unverified",
    })

    const mine = await app.inject({
      method: "GET",
      url: "/v1/me/organizations",
      headers: auth(token),
    })
    expect(mine.json().items).toHaveLength(1)
  })

  it("lowercases the slug at the edge and finds it by any casing", async () => {
    const { app, token, orgs } = await makeHarness()
    const created = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: auth(token),
      payload: { name: "Ballona Creek Trust", slug: "Ballona-Creek-Trust" },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().slug).toBe("ballona-creek-trust")
    expect([...orgs.organizations.values()][0]?.slug).toBe("ballona-creek-trust")

    const bySlug = await app.inject({ method: "GET", url: "/v1/orgs/by-slug/BALLONA-creek-TRUST" })
    expect(bySlug.statusCode).toBe(200)
    expect(bySlug.json().slug).toBe("ballona-creek-trust")
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

describe("organization invites + suspension routes (0.41.0)", () => {
  async function ownedOrg(h: Harness): Promise<string> {
    h.orgs.seedUser({
      id: h.userId,
      displayName: "Host",
      handle: "host",
      email: "host@example.com",
    })
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: auth(h.token),
      payload: { name: "Ballona Creek Trust", slug: "ballona-creek-trust" },
    })
    return (created.json() as { id: string }).id
  }

  it("emails an invite to an address with no account, lists it, and revokes it", async () => {
    const h = await makeHarness()
    const id = await ownedOrg(h)
    const invited = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "newcomer@example.org", role: "member" },
    })
    expect(invited.statusCode).toBe(200)
    const body = invited.json() as {
      member: null
      invited: boolean
      invite: { id: string; status: string }
    }
    expect(body.member).toBeNull()
    expect(body.invited).toBe(true)
    expect(body.invite).toMatchObject({
      status: "pending",
      role: "member",
      email: "newcomer@example.org",
    })
    const mail = h.mailer.sent.find((m) => m.to === "newcomer@example.org")
    expect(mail).toBeDefined()
    expect(JSON.stringify(mail)).toContain(`/manage/org-invites/accept#token=${INVITE_TOKEN}`)
    expect(JSON.stringify(mail)).not.toContain("?token=")

    const listed = await h.app.inject({
      method: "GET",
      url: `/v1/orgs/${id}/invites`,
      headers: auth(h.token),
    })
    expect(listed.statusCode).toBe(200)
    expect((listed.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      body.invite.id,
    ])

    const revoked = await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${id}/invites/${body.invite.id}`,
      headers: auth(h.token),
    })
    expect(revoked.statusCode).toBe(200)
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `/v1/orgs/${id}/invites`,
          headers: auth(h.token),
        })
      ).json().items[0].status,
    ).toBe("revoked")
    const again = await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${id}/invites/${body.invite.id}`,
      headers: auth(h.token),
    })
    expect(again.statusCode).toBe(404)
  })

  it("answers an email with an account and one without in the same shape, with the account masked", async () => {
    const h = await makeHarness()
    const id = await ownedOrg(h)
    // A real signed-in account holds this address (mirrored into the org repo by signIn).
    await h.signIn("known@example.org")
    const known = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "known@example.org", role: "member" },
    })
    const unknown = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "unknown@example.org", role: "member" },
    })
    expect(known.statusCode).toBe(200)
    expect(unknown.statusCode).toBe(200)
    const a = known.json() as { invite: Record<string, unknown> }
    const b = unknown.json() as { invite: Record<string, unknown> }
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
    expect(Object.keys(a.invite).sort()).toEqual(Object.keys(b.invite).sort())
    expect(a.invite).toMatchObject({ user: null, status: "pending" })
    expect(b.invite).toMatchObject({ user: null, status: "pending" })
    // Neither is seated until accept.
    expect(h.orgs.members.filter((m) => m.organizationId === id)).toHaveLength(1)
    // A repeat is the same 200 for both, not a 409 for one of them.
    for (const identifier of ["known@example.org", "unknown@example.org"]) {
      const again = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${id}/members`,
        headers: auth(h.token),
        payload: { identifierKind: "email", identifier, role: "member" },
      })
      expect(again.statusCode, identifier).toBe(200)
      expect((again.json() as { invite: { status: string } }).invite.status).toBe("pending")
    }
  })

  it("404s a revoke whose inviteId belongs to a different org than :id", async () => {
    const h = await makeHarness()
    const first = await ownedOrg(h)
    const other = await h.app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: auth(h.token),
      payload: { name: "Second Org", slug: "second-org" },
    })
    const second = (other.json() as { id: string }).id
    const invited = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${first}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "newcomer@example.org", role: "member" },
    })
    const inviteId = (invited.json() as { invite: { id: string } }).invite.id
    const mismatched = await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${second}/invites/${inviteId}`,
      headers: auth(h.token),
    })
    expect(mismatched.statusCode).toBe(404)
    expect(h.orgs.invites.find((i) => i.id === inviteId)?.status).toBe("pending")
    const matched = await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${first}/invites/${inviteId}`,
      headers: auth(h.token),
    })
    expect(matched.statusCode).toBe(200)
  })

  it("409s an accept while the org is suspended", async () => {
    const h = await makeHarness()
    const id = await ownedOrg(h)
    await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "newcomer@example.org", role: "member" },
    })
    const stored = h.orgs.organizations.get(id)
    if (stored === undefined) throw new Error("org missing")
    stored.suspendedAt = new Date()
    stored.suspendedReason = "impersonation"
    const right = await h.signIn("newcomer@example.org")
    const refused = await h.app.inject({
      method: "POST",
      url: "/v1/org-invites/accept",
      headers: auth(right),
      payload: { token: INVITE_TOKEN },
    })
    expect(refused.statusCode).toBe(409)
    expect(h.orgs.invites[0]?.status).toBe("pending")
  })

  it("accepts an invite with the matching account, rejects the wrong account and a bad token", async () => {
    const h = await makeHarness()
    const id = await ownedOrg(h)
    await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "newcomer@example.org", role: "admin" },
    })
    const wrong = await h.signIn("someone-else@example.org")
    const refused = await h.app.inject({
      method: "POST",
      url: "/v1/org-invites/accept",
      headers: auth(wrong),
      payload: { token: INVITE_TOKEN },
    })
    expect(refused.statusCode).toBe(404)

    const right = await h.signIn("newcomer@example.org")
    const accepted = await h.app.inject({
      method: "POST",
      url: "/v1/org-invites/accept",
      headers: auth(right),
      payload: { token: INVITE_TOKEN },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({
      ok: true,
      role: "admin",
      organization: { id, slug: "ballona-creek-trust", myRole: "admin", suspended: false },
    })
    const reused = await h.app.inject({
      method: "POST",
      url: "/v1/org-invites/accept",
      headers: auth(right),
      payload: { token: INVITE_TOKEN },
    })
    expect(reused.statusCode).toBe(404)
    const tooShort = await h.app.inject({
      method: "POST",
      url: "/v1/org-invites/accept",
      headers: auth(right),
      payload: { token: "short" },
    })
    expect(tooShort.statusCode).toBe(422)
  })

  it("401s the invite routes without a session and 404s a non-member listing invites", async () => {
    const h = await makeHarness()
    const id = await ownedOrg(h)
    for (const [method, url] of [
      ["GET", `/v1/orgs/${id}/invites`],
      ["DELETE", `/v1/orgs/${id}/invites/${randomUUID()}`],
      ["POST", "/v1/org-invites/accept"],
    ] as const) {
      const res = await h.app.inject({
        method,
        url,
        ...(method === "GET" ? {} : { payload: { token: INVITE_TOKEN } }),
      })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
    const stranger = await h.signIn("stranger@example.org")
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/orgs/${id}/invites`,
      headers: auth(stranger),
    })
    expect(res.statusCode).toBe(404)
  })

  it("a suspended org 404s publicly, reads with suspended:true for members, and refuses self-service", async () => {
    const h = await makeHarness()
    const id = await ownedOrg(h)
    const stored = h.orgs.organizations.get(id)
    if (stored === undefined) throw new Error("org missing")
    stored.suspendedAt = new Date()
    stored.suspendedReason = "impersonation"

    const anon = await h.app.inject({ method: "GET", url: "/v1/orgs/by-slug/ballona-creek-trust" })
    expect(anon.statusCode).toBe(404)
    const stranger = await h.signIn("stranger@example.org")
    const other = await h.app.inject({
      method: "GET",
      url: "/v1/orgs/by-slug/ballona-creek-trust",
      headers: auth(stranger),
    })
    expect(other.statusCode).toBe(404)
    const member = await h.app.inject({
      method: "GET",
      url: "/v1/orgs/by-slug/ballona-creek-trust",
      headers: auth(h.token),
    })
    expect(member.statusCode).toBe(200)
    expect(member.json()).toMatchObject({ suspended: true, myRole: "owner" })

    const edit = await h.app.inject({
      method: "PATCH",
      url: `/v1/orgs/${id}`,
      headers: auth(h.token),
      payload: { name: "Renamed" },
    })
    expect(edit.statusCode).toBe(403)
    const invite = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/members`,
      headers: auth(h.token),
      payload: { identifierKind: "email", identifier: "x@example.org", role: "member" },
    })
    expect(invite.statusCode).toBe(403)
    const apply = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${id}/verification`,
      headers: auth(h.token),
      payload: { kind: "community", documents: [] },
    })
    expect(apply.statusCode).toBe(403)
    const mine = await h.app.inject({
      method: "GET",
      url: "/v1/me/organizations",
      headers: auth(h.token),
    })
    expect(mine.json().items[0]).toMatchObject({ suspended: true })
  })
})
