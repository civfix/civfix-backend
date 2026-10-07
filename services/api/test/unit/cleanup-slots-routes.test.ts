/**
 * Signup slots, the HTTP surface, through `app.inject` with an injected in-memory repository.
 *
 * The service suites own the rules; this file owns the things that only exist at the route layer and
 * that a service test can never catch:
 *
 *   - `claimEventSlot` is actually REGISTERED at `PUT /v1/cleanups/:id/slot` (the shared registry is
 *     frozen, so the method+path have to match it exactly);
 *   - the `{ ...body, id }` path-param merge: the typed client extracts `id` into the path, so a route
 *     that forgot the merge would 422 on every single call;
 *   - the CSRF preHandler is present on the mutation (a cookie-session browser client is the reason it
 *     exists at all);
 *   - the per-IP rate limit is configured at 30/min;
 *   - the response really is a CleanupDTO carrying the REFRESHED `slots`, so the client needs no
 *     refetch, and `slotCount` (not `slots`) is what the list read carries.
 */

import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { endpoints, versionedPath } from "@civfix/shared/client"
import { makeServer } from "../../src/server.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import type { CleanupServiceOverrides } from "../../src/routes/cleanups.routes.js"

interface Harness {
  app: FastifyInstance
  repo: InMemoryCleanupRepository
  token: string
  userId: string
}

let current: Harness | undefined

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = makeAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const repo = new InMemoryCleanupRepository()
  const cleanupOverrides: CleanupServiceOverrides = { repo }
  const container = makeContainer(env)
  const app = await makeServer({ env, container, authServices, cleanupOverrides })

  const email = "host@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  repo.seedUser({ id: body.user.id, displayName: "Host", handle: "host" })

  const h: Harness = { app, repo, token: body.token, userId: body.user.id }
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

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString()

async function createWithSlots(
  app: FastifyInstance,
  token: string,
  slots: unknown[] = [{ title: "Grill", capacity: 1 }, { title: "Sign-in" }],
): Promise<{ id: string; slots: { id: string; title: string }[] }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cleanups",
    headers: auth(token),
    payload: { title: "Sweep", type: "site", lat: 34, lng: -118.49, scheduledAt: FUTURE, slots },
  })
  expect(res.statusCode).toBe(201)
  const dto = res.json()
  return { id: dto.id, slots: dto.slots }
}

describe("the registry entry", () => {
  it("is mounted at exactly the method and path the frozen contract declares", async () => {
    const { app, token } = await makeHarness()
    const ep = endpoints.claimEventSlot
    expect(ep.method).toBe("PUT")

    const { id, slots } = await createWithSlots(app, token)
    const url = versionedPath(ep).replace(":id", id)
    const res = await app.inject({
      method: ep.method,
      url,
      headers: auth(token),
      payload: { slotId: slots[0]!.id },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe("PUT /cleanups/:id/slot", () => {
  it("claims a slot and returns the CleanupDTO with the REFRESHED board", async () => {
    const { app, token } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)

    const res = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: slots[0]!.id },
    })

    expect(res.statusCode).toBe(200)
    const dto = res.json()
    // The claim reuses GetCleanupResponseSchema precisely so this is possible: the caller updates
    // its cache straight from the mutation response instead of refetching the event.
    expect(dto.id).toBe(id)
    expect(
      dto.slots.map((s: { title: string; claimed: number; mine?: boolean }) => [
        s.title,
        s.claimed,
        s.mine ?? false,
      ]),
    ).toEqual([
      ["Grill", 1, true],
      ["Sign-in", 0, false],
    ])
  })

  it("releases with slotId: null", async () => {
    const { app, token } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)
    await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: slots[0]!.id },
    })

    const res = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: null },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().slots[0].claimed).toBe(0)
    // Releasing does not leave the event.
    expect(res.json().joined).toBe(true)
  })

  it("merges the :id path param into the body before validation", async () => {
    const { app, token } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)

    // The typed client sends ONLY { slotId } as the body (ClaimEventSlotRequestSchema is .strict() and
    // carries `id`, which the client extracts into the path). A route that forgot the merge would 422
    // here on a required-field error, on every single call.
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: slots[1]!.id },
    })
    expect(res.statusCode).toBe(200)
  })

  it("401s an anonymous claim", async () => {
    const { app, token } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      payload: { slotId: slots[0]!.id },
    })
    expect(res.statusCode).toBe(401)
  })

  it("422s a malformed body (slotId missing entirely)", async () => {
    const { app, token } = await makeHarness()
    const { id } = await createWithSlots(app, token)
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("404s an unknown slot id and 409s a full one", async () => {
    const { app, token, repo } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)

    const unknown = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: "00000000-0000-0000-0000-000000000000" },
    })
    expect(unknown.statusCode).toBe(404)

    // Fill the capacity-1 Grill with someone else, then try to take it.
    const other = "55555555-5555-5555-5555-555555555555"
    repo.seedUser({ id: other, displayName: "Other" })
    repo.seedMember(id, other, "member")
    repo.slotClaims.push({ cleanupId: id, userId: other, slotId: slots[0]!.id })

    const full = await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: slots[0]!.id },
    })
    expect(full.statusCode).toBe(409)
  })
})

describe("route configuration", () => {
  it("registers the PUT verb specifically (a POST on the same path is route-missing)", async () => {
    const { app, token } = await makeHarness()
    const { id } = await createWithSlots(app, token)

    // The registry declares PUT. Fastify routes on method+path, so a mis-declared verb would leave the
    // real one unregistered while every other assertion in this file still passed against a POST.
    const printed = app.printRoutes({ commonPrefix: false })
    expect(printed).toContain("/slot (PUT)")

    const wrongVerb = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: null },
    })
    expect(wrongVerb.statusCode).toBe(404)
    expect(wrongVerb.json<{ message?: string }>().message?.startsWith("Route POST ")).toBe(true)
  })

  it("declares the rate limit and CSRF in the source (the two configs a copy-paste route loses)", async () => {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(
      new URL("../../src/routes/cleanups.routes.ts", import.meta.url),
      "utf8",
    )
    // Whitespace-collapsed so the assertions pin the declarations, not the formatter's line breaks.
    const src = raw.replace(/\s+/g, " ")
    // The OUTER, per-IP layer. The inner per-(event, user) budget is asserted behaviorally in
    // cleanup-slots-claim.test.ts; this one would otherwise be untested until production.
    expect(src).toContain(
      'const CLAIM_SLOT_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const',
    )
    const claimRoute = src.slice(src.indexOf('"claimEventSlot",'))
    expect(claimRoute.slice(0, 200)).toContain("preHandler: csrfProtect")
    expect(claimRoute.slice(0, 200)).toContain("rateLimit: CLAIM_SLOT_RATE_LIMIT")
  })
})

describe("the other cleanup reads carry the slot fields", () => {
  it("GET /cleanups/:id hydrates `slots`; GET /cleanups reports `slotCount` with an empty `slots`", async () => {
    const { app, token } = await makeHarness()
    const { id } = await createWithSlots(app, token)

    const detail = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
    })
    expect(detail.json().slots.map((s: { title: string }) => s.title)).toEqual(["Grill", "Sign-in"])

    const list = await app.inject({ method: "GET", url: "/v1/cleanups", headers: auth(token) })
    const card = list.json().items.find((c: { id: string }) => c.id === id)
    // A feed card renders no board, so the list read pays for one aggregate instead of a join, and
    // `slotCount` is what keeps the empty `slots` from being ambiguous.
    expect(card.slots).toEqual([])
    expect(card.slotCount).toBe(2)
  })

  it("PATCH /cleanups/:id reconciles the board and echoes it back", async () => {
    const { app, token } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { slots: [{ id: slots[0]!.id, title: "Grill duty", capacity: 3 }] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().slots).toEqual([
      expect.objectContaining({ id: slots[0]!.id, title: "Grill duty", capacity: 3 }),
    ])
  })

  it("GET /cleanups/:id/attendees carries each attendee's slot", async () => {
    const { app, token, userId } = await makeHarness()
    const { id, slots } = await createWithSlots(app, token)
    await app.inject({
      method: "PUT",
      url: `/v1/cleanups/${id}/slot`,
      headers: auth(token),
      payload: { slotId: slots[1]!.id },
    })

    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/attendees`,
      headers: auth(token),
    })
    const me = res.json().attendees.find((a: { id: string }) => a.id === userId)
    expect(me.slot).toEqual({ id: slots[1]!.id, title: "Sign-in" })
  })

  it("422s a create whose slot titles collide case-insensitively", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Sweep",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE,
        slots: [{ title: "Grill" }, { title: "GRILL" }],
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("slot windows over the wire", () => {
  const START = new Date(Date.parse(FUTURE))
  const at = (hours: number): string =>
    new Date(START.getTime() + hours * 60 * 60 * 1000).toISOString()

  it("accepts startsAt/endsAt on create and echoes them on the board", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Sweep",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE,
        endsAt: at(4),
        slots: [{ title: "Morning sweep", startsAt: at(0), endsAt: at(2) }],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().slots).toEqual([
      expect.objectContaining({ title: "Morning sweep", startsAt: at(0), endsAt: at(2) }),
    ])
  })

  it("422s a lone startsAt against the `endsAt` path, not the whole object", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Sweep",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE,
        endsAt: at(4),
        slots: [{ title: "Morning sweep", startsAt: at(0) }],
      },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json<{ code: string; fields: Record<string, string> }>()
    expect(body.code).toBe("VALIDATION")
    expect(body.fields["slots.0.endsAt"]).toBe("set both a start and an end, or neither")
  })

  it("422s a shift shorter than the contract's minimum before the service ever runs", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Sweep",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE,
        endsAt: at(4),
        slots: [
          {
            title: "Morning sweep",
            startsAt: at(0),
            endsAt: new Date(START.getTime() + 5 * 60 * 1000).toISOString(),
          },
        ],
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json<{ fields: Record<string, string> }>().fields["slots.0.endsAt"]).toBe(
      "must be at least 15 minutes after startsAt",
    )
  })

  it("PATCH accepts the window too (the same schema backs both writes)", async () => {
    const { app, token } = await makeHarness()
    const created = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Sweep",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE,
        endsAt: at(4),
        slots: [{ title: "Morning sweep" }],
      },
    })
    const id = created.json().id as string
    const slotId = created.json().slots[0].id as string

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: {
        slots: [{ id: slotId, title: "Morning sweep", startsAt: at(0), endsAt: at(2) }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().slots).toEqual([
      expect.objectContaining({ id: slotId, startsAt: at(0), endsAt: at(2) }),
    ])
  })
})
