
import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import type { PersonDTO } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { InMemoryChatRepository, InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import { BLOCK_RATE_LIMIT } from "../../src/routes/users.routes.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"

interface Session {
  userId: string
  token: string
}

interface WebSession {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  app: FastifyInstance
  blocks: InMemoryBlocksRepository
  stores: ReturnType<typeof makeInMemoryStores>
  signIn(email: string, name: string): Promise<Session>
  signInWeb(email: string, name: string): Promise<WebSession>
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const blocks = new InMemoryBlocksRepository()
  const dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  const chatOverrides: ChatGatewayOverrides = {
    isMember: () => Promise.resolve(true),
    threadsRepo: new InMemoryThreadsRepository(),
    dmRepo,
    chatRepo: new InMemoryChatRepository(),
    blocksRepo: blocks,
  }
  const app = await buildServer({ env, authServices, chatOverrides })

  async function verify(email: string, name: string, client: "mobile" | "web") {
    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email },
    })
    expect(requested.statusCode).toBe(200)
    const code = mailer.lastOtpFor(email)!
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": client },
      payload: { email, code },
    })
    expect(res.statusCode).toBe(200)
    const userId = res.json().user.id as string
    blocks.registerUser({ id: userId, displayName: name, handle: name.toLowerCase() })
    dmRepo.registerUser({ id: userId, displayName: name, handle: name.toLowerCase() })
    return { res, userId }
  }

  const h: Harness = {
    app,
    blocks,
    stores,
    async signIn(email, name) {
      const { res, userId } = await verify(email, name, "mobile")
      return { userId, token: res.json().token as string }
    },
    async signInWeb(email, name) {
      const { res, userId } = await verify(email, name, "web")
      const setCookie = res.headers["set-cookie"]
      const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
      const cookie = lines.find((l) => l.startsWith("civfix_session="))!.split(";")[0]!
      return { userId, cookie, csrfToken: res.json().csrfToken as string }
    },
  }
  current = h
  return h
}

function bearer(s: Session): Record<string, string> {
  return { authorization: `Bearer ${s.token}`, "x-client": "mobile" }
}

function blockUrl(id: string): string {
  return `/v1/users/${id}/block`
}

const UNKNOWN_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb"

describe("POST /users/:id/block", () => {
  it("200 {blocked:true} and the edge is visible to the shared blocks repo", async () => {
    const h = await makeHarness()
    const me = await h.signIn("blocker@example.com", "Blocker")
    const them = await h.signIn("blocked@example.com", "Blocked")

    expect(await h.blocks.isBlockedEitherWay(me.userId, them.userId)).toBe(false)
    const res = await h.app.inject({
      method: "POST",
      url: blockUrl(them.userId),
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ blocked: true })
    expect(await h.blocks.isBlockedEitherWay(me.userId, them.userId)).toBe(true)
  })

  it("is idempotent: blocking twice stays 200 and does not duplicate the list entry", async () => {
    const h = await makeHarness()
    const me = await h.signIn("dup@example.com", "Dup")
    const them = await h.signIn("target@example.com", "Target")

    for (let i = 0; i < 3; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: blockUrl(them.userId),
        headers: bearer(me),
      })
      expect(res.statusCode, `attempt ${i}`).toBe(200)
      expect(res.json()).toEqual({ blocked: true })
    }
    const list = await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })
    expect(list.json().blocked).toHaveLength(1)
  })

  it("422s blocking yourself (with an `id` field), and writes no edge", async () => {
    const h = await makeHarness()
    const me = await h.signIn("self@example.com", "Self")
    const res = await h.app.inject({
      method: "POST",
      url: blockUrl(me.userId),
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(res.json().fields.id).toMatch(/yourself/i)
    expect(await h.blocks.isBlockedEitherWay(me.userId, me.userId)).toBe(false)
  })

  it("403s blocking the official CivFix account in any letter case, and writes no edge", async () => {
    const h = await makeHarness()
    const me = await h.signIn("resident@example.com", "Resident")
    for (const id of [CIVFIX_OFFICIAL_USER_ID, CIVFIX_OFFICIAL_USER_ID.toUpperCase()]) {
      const res = await h.app.inject({ method: "POST", url: blockUrl(id), headers: bearer(me) })
      expect(res.statusCode, id).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    }
    expect((await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })).json())
      .toEqual({ blocked: [] })
  })

  it("422s a non-uuid :id before any store lookup", async () => {
    const h = await makeHarness()
    const me = await h.signIn("badid@example.com", "BadId")
    const res = await h.app.inject({ method: "POST", url: blockUrl("not-a-uuid"), headers: bearer(me) })
    expect(res.statusCode).toBe(422)
    expect(res.json().fields.id).toBeDefined()
  })

  it("404s a user who does not exist", async () => {
    const h = await makeHarness()
    const me = await h.signIn("ghost@example.com", "Ghost")
    const res = await h.app.inject({ method: "POST", url: blockUrl(UNKNOWN_ID), headers: bearer(me) })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe("NOT_FOUND")
    expect((await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })).json())
      .toEqual({ blocked: [] })
  })

  it("CVX-033: a user who ALREADY BLOCKED you answers exactly like an unknown user, writing no edge", async () => {
    const h = await makeHarness()
    const me = await h.signIn("probe@example.com", "Probe")
    const them = await h.signIn("hidden@example.com", "Hidden")
    await h.blocks.block(them.userId, me.userId)

    const unknown = await h.app.inject({
      method: "POST",
      url: blockUrl(UNKNOWN_ID),
      headers: bearer(me),
    })
    const blockedByThem = await h.app.inject({
      method: "POST",
      url: blockUrl(them.userId),
      headers: bearer(me),
    })

    const body = (res: { json(): { code: string; message: string } }) => {
      const { code, message } = res.json()
      return { code, message }
    }
    expect(blockedByThem.statusCode).toBe(unknown.statusCode)
    expect(body(blockedByThem)).toEqual(body(unknown))
    expect((await h.blocks.blockState(me.userId, them.userId)).blockedByViewer).toBe(false)
    expect((await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })).json())
      .toEqual({ blocked: [] })
  })

  it("still 200s a target the VIEWER blocked (their own edge is idempotent, not an oracle)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("owner@example.com", "Owner")
    const them = await h.signIn("target@example.com", "Target")
    await h.blocks.block(me.userId, them.userId)

    const res = await h.app.inject({
      method: "POST",
      url: blockUrl(them.userId),
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ blocked: true })
  })

  it("MUTUAL block stays 200: a target already on your OWN blocked list must not 404", async () => {
    const h = await makeHarness()
    const me = await h.signIn("mutual-a@example.com", "MutualA")
    const them = await h.signIn("mutual-b@example.com", "MutualB")
    await h.blocks.block(me.userId, them.userId)
    await h.blocks.block(them.userId, me.userId)

    const res = await h.app.inject({
      method: "POST",
      url: blockUrl(them.userId),
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ blocked: true })
    const list = await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })
    expect(list.json().blocked.map((p: PersonDTO) => p.id)).toEqual([them.userId])
  })

  it("404s a SOFT-DELETED user (a tombstoned account is not blockable)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("live@example.com", "Live")
    const gone = await h.signIn("gone@example.com", "Gone")
    await h.stores.users.softDeleteAndAnonymize(gone.userId)

    const res = await h.app.inject({ method: "POST", url: blockUrl(gone.userId), headers: bearer(me) })
    expect(res.statusCode).toBe(404)
  })

  it("401s anonymously and 403s a cookie request with no CSRF token", async () => {
    const h = await makeHarness()
    const web = await h.signInWeb("csrfblock@example.com", "CsrfBlock")
    const them = await h.signIn("victim@example.com", "Victim")

    const anon = await h.app.inject({ method: "POST", url: blockUrl(them.userId) })
    expect(anon.statusCode).toBe(401)

    const noCsrf = await h.app.inject({
      method: "POST",
      url: blockUrl(them.userId),
      headers: { cookie: web.cookie },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json().message).toMatch(/CSRF/i)
    expect(await h.blocks.isBlockedEitherWay(web.userId, them.userId)).toBe(false)

    const withCsrf = await h.app.inject({
      method: "POST",
      url: blockUrl(them.userId),
      headers: { cookie: web.cookie, "x-csrf-token": web.csrfToken },
    })
    expect(withCsrf.statusCode).toBe(200)
    expect(await h.blocks.isBlockedEitherWay(web.userId, them.userId)).toBe(true)
  })
})

describe("DELETE /users/:id/block", () => {
  it("200 {blocked:false} and removes the edge", async () => {
    const h = await makeHarness()
    const me = await h.signIn("un@example.com", "Un")
    const them = await h.signIn("unt@example.com", "Unt")
    await h.app.inject({ method: "POST", url: blockUrl(them.userId), headers: bearer(me) })

    const res = await h.app.inject({
      method: "DELETE",
      url: blockUrl(them.userId),
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ blocked: false })
    expect(await h.blocks.isBlockedEitherWay(me.userId, them.userId)).toBe(false)
  })

  it("is idempotent, and (unlike block) does NOT 404 an unknown user", async () => {
    const h = await makeHarness()
    const me = await h.signIn("idem@example.com", "Idem")
    const them = await h.signIn("idemt@example.com", "IdemT")

    expect(
      (await h.app.inject({ method: "DELETE", url: blockUrl(them.userId), headers: bearer(me) }))
        .statusCode,
    ).toBe(200)
    const unknown = await h.app.inject({
      method: "DELETE",
      url: blockUrl(UNKNOWN_ID),
      headers: bearer(me),
    })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json()).toEqual({ blocked: false })
  })

  it("422s a non-uuid :id, 401s anonymously, 403s a cookie request with no CSRF token", async () => {
    const h = await makeHarness()
    const web = await h.signInWeb("csrfun@example.com", "CsrfUn")
    const them = await h.signIn("unvictim@example.com", "UnVictim")
    await h.blocks.block(web.userId, them.userId)

    expect(
      (await h.app.inject({ method: "DELETE", url: blockUrl("nope"), headers: { cookie: web.cookie, "x-csrf-token": web.csrfToken } }))
        .statusCode,
    ).toBe(422)
    expect((await h.app.inject({ method: "DELETE", url: blockUrl(them.userId) })).statusCode).toBe(401)

    const noCsrf = await h.app.inject({
      method: "DELETE",
      url: blockUrl(them.userId),
      headers: { cookie: web.cookie },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(await h.blocks.isBlockedEitherWay(web.userId, them.userId)).toBe(true)
  })
})

describe("GET /me/blocks", () => {
  it("returns the caller's blocked accounts as PersonDTOs", async () => {
    const h = await makeHarness()
    const me = await h.signIn("lister@example.com", "Lister")
    const one = await h.signIn("one@example.com", "One")
    const two = await h.signIn("two@example.com", "Two")

    expect((await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })).json())
      .toEqual({ blocked: [] })

    await h.app.inject({ method: "POST", url: blockUrl(one.userId), headers: bearer(me) })
    await h.app.inject({ method: "POST", url: blockUrl(two.userId), headers: bearer(me) })

    const res = await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })
    expect(res.statusCode).toBe(200)
    const blocked = res.json().blocked as PersonDTO[]
    expect(blocked.map((p) => p.id).sort()).toEqual([one.userId, two.userId].sort())
    const first = blocked.find((p) => p.id === one.userId)!
    expect(first).toMatchObject({ name: "One", handle: "one" })
    expect(Array.isArray(first.avatar)).toBe(true)

    await h.app.inject({ method: "DELETE", url: blockUrl(one.userId), headers: bearer(me) })
    const after = await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(me) })
    expect((after.json().blocked as PersonDTO[]).map((p) => p.id)).toEqual([two.userId])
  })

  it("is scoped to the caller and DIRECTED (being blocked does not show up in your own list)", async () => {
    const h = await makeHarness()
    const alice = await h.signIn("alice@example.com", "Alice")
    const bob = await h.signIn("bob@example.com", "Bob")
    await h.app.inject({ method: "POST", url: blockUrl(alice.userId), headers: bearer(bob) })

    const bobList = await h.app.inject({ method: "GET", url: "/v1/me/blocks", headers: bearer(bob) })
    expect((bobList.json().blocked as PersonDTO[]).map((p) => p.id)).toEqual([alice.userId])

    const aliceList = await h.app.inject({
      method: "GET",
      url: "/v1/me/blocks",
      headers: bearer(alice),
    })
    expect(aliceList.json()).toEqual({ blocked: [] })
  })

  it("honors the pagination limit query (W-SOCIAL-2 / F014)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("pager@example.com", "Pager")
    const one = await h.signIn("p-one@example.com", "POne")
    const two = await h.signIn("p-two@example.com", "PTwo")
    await h.app.inject({ method: "POST", url: blockUrl(one.userId), headers: bearer(me) })
    await h.app.inject({ method: "POST", url: blockUrl(two.userId), headers: bearer(me) })

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/me/blocks?limit=1",
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    expect((res.json().blocked as PersonDTO[]).length).toBeLessThanOrEqual(1)
  })

  it("422s a bad pagination limit (strict PaginationQuery)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("badpage@example.com", "BadPage")
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/me/blocks?limit=999",
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(422)
  })

  it("401s anonymously", async () => {
    const h = await makeHarness()
    expect((await h.app.inject({ method: "GET", url: "/v1/me/blocks" })).statusCode).toBe(401)
  })
})

describe("block SIDE EFFECT: the DM lane closes both ways", () => {
  it("open -> block -> 403 in BOTH directions -> unblock -> open again", async () => {
    const h = await makeHarness()
    const alice = await h.signIn("dm-a@example.com", "DmA")
    const bob = await h.signIn("dm-b@example.com", "DmB")

    const open = async (from: Session, to: Session) =>
      h.app.inject({ method: "POST", url: "/v1/dm", headers: bearer(from), payload: { userId: to.userId } })

    const before = await open(alice, bob)
    expect(before.statusCode).toBe(200)
    expect(before.json().thread.peer.id).toBe(bob.userId)

    const blocked = await h.app.inject({
      method: "POST",
      url: blockUrl(bob.userId),
      headers: bearer(alice),
    })
    expect(blocked.statusCode).toBe(200)

    const asAlice = await open(alice, bob)
    expect(asAlice.statusCode).toBe(403)
    const asBob = await open(bob, alice)
    expect(asBob.statusCode).toBe(403)
    expect(asBob.json().message).toBe(asAlice.json().message)

    await h.app.inject({ method: "DELETE", url: blockUrl(bob.userId), headers: bearer(alice) })
    expect((await open(alice, bob)).statusCode).toBe(200)
    expect((await open(bob, alice)).statusCode).toBe(200)
  })
})

describe("PUT /me/settings", () => {
  it("round-trips allowDirectMessages and persists it to the session view", async () => {
    const h = await makeHarness()
    const me = await h.signIn("settings@example.com", "Settings")

    const res = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { allowDirectMessages: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: me.userId, allowDirectMessages: false })

    expect((await h.stores.users.findById(me.userId))!.allowDirectMessages).toBe(false)
    const session = await h.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: bearer(me),
    })
    expect(session.json().user.allowDirectMessages).toBe(false)

    const on = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { allowDirectMessages: true },
    })
    expect(on.json().user.allowDirectMessages).toBe(true)
  })

  it("SIDE EFFECT: turning DMs off 403s a NEW inbound thread but keeps an existing one openable", async () => {
    const h = await makeHarness()
    const shy = await h.signIn("shy@example.com", "Shy")
    const keen = await h.signIn("keen@example.com", "Keen")
    const stranger = await h.signIn("stranger@example.com", "Stranger")

    expect(
      (await h.app.inject({
        method: "POST",
        url: "/v1/dm",
        headers: bearer(keen),
        payload: { userId: shy.userId },
      })).statusCode,
    ).toBe(200)

    await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(shy),
      payload: { allowDirectMessages: false },
    })

    const refused = await h.app.inject({
      method: "POST",
      url: "/v1/dm",
      headers: bearer(stranger),
      payload: { userId: shy.userId },
    })
    expect(refused.statusCode).toBe(403)
    const existing = await h.app.inject({
      method: "POST",
      url: "/v1/dm",
      headers: bearer(keen),
      payload: { userId: shy.userId },
    })
    expect(existing.statusCode).toBe(200)
  })

  it("round-trips a supported locale and 422s an unsupported one", async () => {
    const h = await makeHarness()
    const me = await h.signIn("locale@example.com", "Locale")

    const es = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { locale: "es" },
    })
    expect(es.statusCode).toBe(200)
    expect(es.json().user.locale).toBe("es")
    expect((await h.stores.users.findById(me.userId))!.locale).toBe("es")

    const fr = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { locale: "fr" },
    })
    expect(fr.statusCode).toBe(422)
    expect(fr.json().fields.locale).toBeDefined()
    expect((await h.stores.users.findById(me.userId))!.locale).toBe("es")
  })

  it("applies both fields in one call and leaves omitted fields untouched", async () => {
    const h = await makeHarness()
    const me = await h.signIn("both@example.com", "Both")
    const both = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { allowDirectMessages: false, locale: "ko" },
    })
    expect(both.statusCode).toBe(200)
    expect(both.json().user).toMatchObject({ allowDirectMessages: false, locale: "ko" })

    const noop = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: {},
    })
    expect(noop.statusCode).toBe(200)
    expect(noop.json().user).toMatchObject({ allowDirectMessages: false, locale: "ko" })
  })

  it("showVolunteerHours is ABSENT until chosen, then round-trips true and false", async () => {
    const h = await makeHarness()
    const me = await h.signIn("hours@example.com", "Hours")

    const noop = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: {},
    })
    expect(noop.statusCode).toBe(200)
    expect("showVolunteerHours" in noop.json().user).toBe(false)
    expect((await h.stores.users.findById(me.userId))!.showVolunteerHours).toBeNull()
    const before = await h.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: bearer(me),
    })
    expect("showVolunteerHours" in before.json().user).toBe(false)

    const off = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { showVolunteerHours: false },
    })
    expect(off.statusCode).toBe(200)
    expect(off.json().user.showVolunteerHours).toBe(false)
    expect((await h.stores.users.findById(me.userId))!.showVolunteerHours).toBe(false)
    const session = await h.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: bearer(me),
    })
    expect(session.json().user.showVolunteerHours).toBe(false)

    const on = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { showVolunteerHours: true },
    })
    expect(on.statusCode).toBe(200)
    expect(on.json().user.showVolunteerHours).toBe(true)
    expect((await h.stores.users.findById(me.userId))!.showVolunteerHours).toBe(true)
  })

  it("a settings write that omits showVolunteerHours leaves the stored tri-state alone", async () => {
    const h = await makeHarness()
    const me = await h.signIn("hours-keep@example.com", "Keep")

    await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { showVolunteerHours: false },
    })
    const later = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { locale: "de" },
    })
    expect(later.statusCode).toBe(200)
    expect(later.json().user).toMatchObject({ locale: "de", showVolunteerHours: false })
    expect((await h.stores.users.findById(me.userId))!.showVolunteerHours).toBe(false)
  })

  it("422s an unknown key (strict schema) and leaves settings unchanged", async () => {
    const h = await makeHarness()
    const me = await h.signIn("strict@example.com", "Strict")
    const res = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: bearer(me),
      payload: { allowDirectMessages: false, bogus: true },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect((await h.stores.users.findById(me.userId))!.allowDirectMessages).toBe(true)
  })

  it("401s anonymously and 403s a cookie request with no CSRF token", async () => {
    const h = await makeHarness()
    const web = await h.signInWeb("csrfset@example.com", "CsrfSet")

    const anon = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      payload: { allowDirectMessages: false },
    })
    expect(anon.statusCode).toBe(401)

    const noCsrf = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: { cookie: web.cookie },
      payload: { allowDirectMessages: false },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect((await h.stores.users.findById(web.userId))!.allowDirectMessages).toBe(true)

    const withCsrf = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: { cookie: web.cookie, "x-csrf-token": web.csrfToken },
      payload: { allowDirectMessages: false },
    })
    expect(withCsrf.statusCode).toBe(200)
    expect((await h.stores.users.findById(web.userId))!.allowDirectMessages).toBe(false)
  })

  it("403s a settings write whose CSRF token belongs to another session", async () => {
    const h = await makeHarness()
    const me = await h.signInWeb("cross-a@example.com", "CrossA")
    const other = await h.signInWeb("cross-b@example.com", "CrossB")
    const res = await h.app.inject({
      method: "PUT",
      url: "/v1/me/settings",
      headers: { cookie: me.cookie, "x-csrf-token": other.csrfToken },
      payload: { allowDirectMessages: false },
    })
    expect(res.statusCode).toBe(403)
    expect((await h.stores.users.findById(me.userId))!.allowDirectMessages).toBe(true)
  })
})

describe("per-route rate limits", () => {
  it(`429s block churn past the dedicated ${BLOCK_RATE_LIMIT.max}/${BLOCK_RATE_LIMIT.timeWindow} bucket, well below the global ceiling`, async () => {
    const h = await makeHarness()
    const me = await h.signIn("churn@example.com", "Churn")
    const them = await h.signIn("churned@example.com", "Churned")

    let saw429 = false
    let accepted = 0
    for (let i = 0; i < BLOCK_RATE_LIMIT.max + 5; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: blockUrl(them.userId),
        headers: bearer(me),
        remoteAddress: "198.51.100.42",
      })
      if (res.statusCode === 429) {
        saw429 = true
        break
      }
      expect(res.statusCode).toBe(200)
      accepted += 1
    }
    expect(saw429).toBe(true)
    expect(accepted).toBe(BLOCK_RATE_LIMIT.max)
  })
})
