import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer, FakePushSender } from "@civfix/seams"
import type { AdminDevForceUpdateAccount } from "@civfix/contract"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { makeRuntimeFlagService } from "../../src/services/admin/runtime-flag-service.js"
import {
  FORCE_UPDATE_INDEX_KEY,
  forceUpdateOverrideKey,
  makeDevTestTools,
  type DevTestTools,
} from "../../src/services/admin/dev-test-tools.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryRuntimeFlagRepository } from "../helpers/admin/runtime-flag-repository.memory.js"
import { InMemoryDevTestRepository } from "../helpers/admin/dev-test-repository.memory.js"

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0, 0)
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const CODE = "Qm7vT2xRk9LpW4sZc8NbY3hD"
const OPERATOR_EMAIL = "o@civfix.org"
const SECOND_OPERATOR_EMAIL = "p@civfix.org"
const TESTER_EMAIL = "tester@civfix.org"
const NEW_TESTER_EMAIL = "new.tester@civfix.org"
const UNLISTED_EMAIL = "someone@civfix.org"
const MAIL_FROM = "noreply@staging.test"
const APP_STORE_URL = "https://apps.apple.com/us/app/civfix/id6000000000"
const DEFAULT_PUSH = {
  title: "Test notification",
  body: "Sent from the civfix developer console.",
}

const DEV_TOOLS_ON_ENV = {
  NODE_ENV: "test",
  CIVFIX_ENV: "staging",
  DEV_TOOLS_ENABLED: "true",
  ADMIN_EMAILS: `${OPERATOR_EMAIL},${SECOND_OPERATOR_EMAIL}`,
  DEV_TEST_EMAILS: "Tester@civfix.org,new.tester@civfix.org",
  DEV_TEST_OTP_CODE: CODE,
  MAIL_FROM_NOREPLY: MAIL_FROM,
}

interface Session {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  app: FastifyInstance
  stores: ReturnType<typeof makeInMemoryStores>
  repo: InMemoryDevTestRepository
  cache: InMemoryCacheClient
  push: FakePushSender
  mailer: FakeMailer
  tools: DevTestTools
  flags: InMemoryRuntimeFlagRepository
  clock: { now: number }
  operator: Session
  secondOperator: Session
  tester: Session
  someone: Session
  session(email: string, role: "operator" | "citizen"): Promise<Session>
}

let current: FastifyInstance | undefined

afterEach(async () => {
  await current?.close()
  current = undefined
})

async function harness(
  opts: { devTools?: boolean; extraTestEmails?: readonly string[] } = {},
): Promise<Harness> {
  const { DEV_TOOLS_ENABLED: _on, ...offEnv } = DEV_TOOLS_ON_ENV
  const base = (opts.devTools ?? true) ? DEV_TOOLS_ON_ENV : offEnv
  const env = loadEnv({
    ...base,
    DEV_TEST_EMAILS: [base.DEV_TEST_EMAILS, ...(opts.extraTestEmails ?? [])].join(","),
  })
  const stores = makeInMemoryStores()
  const services = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const clock = { now: T0 }
  const cache = new InMemoryCacheClient(() => clock.now)
  const repo = new InMemoryDevTestRepository(stores.users)
  const push = new FakePushSender()
  const mailer = new FakeMailer()
  const tools = makeDevTestTools({
    repo,
    cache,
    pushSender: push,
    mailer,
    mailFrom: env.MAIL_FROM_NOREPLY,
    testEmails: env.DEV_TEST_EMAILS,
    now: () => clock.now,
  })
  const flags = new InMemoryRuntimeFlagRepository()
  const runtimeFlags = makeRuntimeFlagService({
    repo: flags,
    envFallbacks: env.runtimeFlagEnvFallbacks,
    logger: { warn: () => undefined, error: () => undefined },
  })
  const container: Container = {
    ...makeContainer(env),
    getRuntimeFlags: () => runtimeFlags,
    getDevTestTools: () => tools,
  }
  const app = await makeServer({ env, container, authServices: services })
  current = app

  async function session(email: string, role: "operator" | "citizen"): Promise<Session> {
    const user = await stores.users.create(email, {
      displayName: email,
      role,
      emailVerified: true,
      profileComplete: true,
    })
    const token = await services.sessions.createSession(user.id, [role])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { userId: user.id, cookie: `civfix_session=${token}`, csrfToken }
  }

  return {
    app,
    stores,
    repo,
    cache,
    push,
    mailer,
    tools,
    flags,
    clock,
    operator: await session(OPERATOR_EMAIL, "operator"),
    secondOperator: await session(SECOND_OPERATOR_EMAIL, "operator"),
    tester: await session(TESTER_EMAIL, "citizen"),
    someone: await session(UNLISTED_EMAIL, "citizen"),
    session,
  }
}

type Method = "GET" | "PUT" | "POST"

interface Call {
  method: Method
  url: string
  body?: unknown
}

const FORCE_UPDATE_URL = "/v1/admin/dev/test/force-update"
const PUSH_URL = "/v1/admin/dev/test/push"
const EMAIL_URL = "/v1/admin/dev/test/email"
const RESET_URL = "/v1/admin/dev/test/reset-first-run"

const LIST_FORCE_UPDATE: Call = { method: "GET", url: FORCE_UPDATE_URL }
const SET_FORCE_UPDATE: Call = {
  method: "PUT",
  url: FORCE_UPDATE_URL,
  body: { email: TESTER_EMAIL, enabled: true },
}
const TEST_PUSH: Call = { method: "POST", url: PUSH_URL, body: { email: TESTER_EMAIL } }
const TEST_EMAIL: Call = { method: "POST", url: EMAIL_URL, body: {} }
const RESET_FIRST_RUN: Call = { method: "POST", url: RESET_URL, body: { email: TESTER_EMAIL } }

const FIVE_ROUTES: readonly Call[] = [
  LIST_FORCE_UPDATE,
  SET_FORCE_UPDATE,
  TEST_PUSH,
  TEST_EMAIL,
  RESET_FIRST_RUN,
]
const MUTATIONS: readonly Call[] = [SET_FORCE_UPDATE, TEST_PUSH, TEST_EMAIL, RESET_FIRST_RUN]

/** The three tools that name a test account, as a call for a given address. */
const TARGETED: readonly { name: string; call: (email: string) => Call }[] = [
  {
    name: "force update",
    call: (email) => ({ method: "PUT", url: FORCE_UPDATE_URL, body: { email, enabled: true } }),
  },
  { name: "push", call: (email) => ({ method: "POST", url: PUSH_URL, body: { email } }) },
  { name: "reset", call: (email) => ({ method: "POST", url: RESET_URL, body: { email } }) },
]

function send(
  h: Harness,
  c: Call,
  opts: { as?: Session | null; csrf?: boolean } = {},
): Promise<LightMyRequestResponse> {
  const as = opts.as === undefined ? h.operator : opts.as
  const headers: Record<string, string> = {}
  if (as !== null) {
    headers.cookie = as.cookie
    if (opts.csrf ?? true) headers["x-csrf-token"] = as.csrfToken
  }
  return h.app.inject({
    method: c.method,
    url: c.url,
    headers,
    ...(c.body !== undefined ? { payload: c.body as object } : {}),
  })
}

function expectError(res: LightMyRequestResponse, status: number, code: string, label = ""): void {
  expect(res.statusCode, `${label} ${res.body}`).toBe(status)
  expect(res.json<{ code: string }>().code, label).toBe(code)
}

function label(c: Call): string {
  return `${c.method} ${c.url}`
}

/** Everything a test tool could change, to compare before and after a refused call. */
async function state(h: Harness): Promise<string> {
  const users = await Promise.all(
    [h.tester, h.someone, h.operator].map((s) => h.stores.users.findById(s.userId)),
  )
  return JSON.stringify({
    audits: h.repo.audits,
    pushes: h.push.sent,
    mail: h.mailer.sent,
    override: await h.cache.get(forceUpdateOverrideKey(h.tester.userId)),
    index: await h.cache.smembers(FORCE_UPDATE_INDEX_KEY),
    profiles: users.map((u) => u?.profileComplete),
  })
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

async function listAccounts(h: Harness): Promise<AdminDevForceUpdateAccount[]> {
  const res = await send(h, LIST_FORCE_UPDATE)
  expect(res.statusCode).toBe(200)
  return res.json<{ accounts: AdminDevForceUpdateAccount[] }>().accounts
}

function setForceUpdate(
  h: Harness,
  email: string,
  enabled: boolean,
): Promise<LightMyRequestResponse> {
  return send(h, { method: "PUT", url: FORCE_UPDATE_URL, body: { email, enabled } })
}

describe("test tools: the shared rules", () => {
  it("T1: every route is NOT_FOUND and does nothing when dev tools are off", async () => {
    const h = await harness({ devTools: false })
    const before = await state(h)
    for (const c of FIVE_ROUTES) {
      const res = await send(h, c)
      expectError(res, 404, "NOT_FOUND", label(c))
      expect(res.json<{ message: string }>().message.startsWith("Route ")).toBe(false)
    }
    expect(await state(h)).toBe(before)
  })

  it("T2: dev tools off answers NOT_FOUND before reading the body", async () => {
    const h = await harness({ devTools: false })
    const invalid: Call[] = [
      { method: "PUT", url: FORCE_UPDATE_URL, body: { email: "x", extra: 1 } },
      { method: "POST", url: PUSH_URL, body: { email: "x", extra: 1 } },
      { method: "POST", url: EMAIL_URL, body: { to: "a@civfix.org" } },
      { method: "POST", url: RESET_URL, body: { email: "x", extra: 1 } },
    ]
    for (const c of invalid) expectError(await send(h, c), 404, "NOT_FOUND", label(c))
  })

  it("T3: every route needs an operator", async () => {
    const h = await harness()
    const before = await state(h)
    for (const c of FIVE_ROUTES) {
      expectError(await send(h, c, { as: null }), 401, "UNAUTHORIZED", label(c))
      expectError(await send(h, c, { as: h.someone }), 403, "FORBIDDEN", label(c))
    }
    expect(await state(h)).toBe(before)
  })

  it("T4: every mutation needs the CSRF header", async () => {
    const h = await harness()
    const before = await state(h)
    for (const c of MUTATIONS) {
      expectError(await send(h, c, { csrf: false }), 403, "FORBIDDEN", label(c))
    }
    expect(await state(h)).toBe(before)
  })

  it("T5: each route allows 10 calls a minute per operator", async () => {
    for (const c of FIVE_ROUTES) {
      const h = await harness()
      for (let i = 1; i <= 10; i += 1) {
        expect((await send(h, c)).statusCode, `${label(c)} call ${i}`).not.toBe(429)
      }
      expectError(await send(h, c), 429, "RATE_LIMITED", label(c))
      const other = c === LIST_FORCE_UPDATE ? TEST_PUSH : LIST_FORCE_UPDATE
      expect((await send(h, other)).statusCode, label(c)).not.toBe(429)
      expect((await send(h, c, { as: h.secondOperator })).statusCode, label(c)).not.toBe(429)
      await h.app.close()
      current = undefined
    }
  })

  it("T6: each mutation writes its audit action with no email in it", async () => {
    const h = await harness()
    for (const c of MUTATIONS) expect((await send(h, c)).statusCode, label(c)).toBe(200)
    expect(h.repo.audits).toEqual([
      {
        actorId: h.operator.userId,
        action: "dev.force_update_set",
        target: `user:${h.tester.userId}`,
        meta: { enabled: true },
      },
      {
        actorId: h.operator.userId,
        action: "dev.test_push",
        target: `user:${h.tester.userId}`,
        meta: { devices: 0 },
      },
      {
        actorId: h.operator.userId,
        action: "dev.test_email",
        target: `user:${h.operator.userId}`,
        meta: null,
      },
      {
        actorId: h.operator.userId,
        action: "dev.reset_first_run",
        target: `user:${h.tester.userId}`,
        meta: null,
      },
    ])
    for (const row of h.repo.audits) expect(JSON.stringify(row.meta ?? null)).not.toContain("@")
  })
})

describe("test tools: targets", () => {
  it("T7: an address that is not a test account is FORBIDDEN", async () => {
    const h = await harness()
    const before = await state(h)
    for (const t of TARGETED) {
      for (const email of [UNLISTED_EMAIL, "resident@example.com"]) {
        expectError(await send(h, t.call(email)), 403, "FORBIDDEN", `${t.name} ${email}`)
      }
    }
    expect(await state(h)).toBe(before)
  })

  it("T8: a listed address with no account is NOT_FOUND", async () => {
    const h = await harness()
    const before = await state(h)
    for (const t of TARGETED) {
      expectError(await send(h, t.call(NEW_TESTER_EMAIL)), 404, "NOT_FOUND", t.name)
    }
    expect(await state(h)).toBe(before)
  })

  it("T9: the address matches case-insensitively and trimmed", async () => {
    const h = await harness()
    const email = " TESTER@CIVFIX.ORG "
    const forced = await send(h, TARGETED[0]!.call(email))
    expect(forced.statusCode).toBe(200)
    expect(forced.json()).toEqual({
      accounts: [{ userId: h.tester.userId, email: TESTER_EMAIL, expiresAt: iso(T0 + DAY_MS) }],
    })
    const pushed = await send(h, TARGETED[1]!.call(email))
    expect(pushed.statusCode).toBe(200)
    expect(h.push.sent.map((p) => p.userId)).toEqual([h.tester.userId])
    const reset = await send(h, TARGETED[2]!.call(email))
    expect(reset.statusCode).toBe(200)
    expect(reset.json()).toEqual({ userId: h.tester.userId })
  })

  it("T10: an invalid address or an extra key is VALIDATION", async () => {
    const h = await harness()
    const before = await state(h)
    const bodies: [string, unknown][] = [
      [FORCE_UPDATE_URL, { email: "not-an-email", enabled: true }],
      [FORCE_UPDATE_URL, { email: TESTER_EMAIL, enabled: true, extra: 1 }],
      [PUSH_URL, { email: "not-an-email" }],
      [PUSH_URL, { email: TESTER_EMAIL, extra: 1 }],
      [RESET_URL, { email: "not-an-email" }],
      [RESET_URL, { email: TESTER_EMAIL, extra: 1 }],
    ]
    for (const [url, body] of bodies) {
      const method = url === FORCE_UPDATE_URL ? "PUT" : "POST"
      expectError(await send(h, { method, url, body }), 422, "VALIDATION", url)
    }
    expect(await state(h)).toBe(before)
  })
})

describe("test tools: force update", () => {
  it("T11: enabling stores a 24-hour override and answers the list", async () => {
    const h = await harness()
    const res = await setForceUpdate(h, TESTER_EMAIL, true)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      accounts: [{ userId: h.tester.userId, email: TESTER_EMAIL, expiresAt: iso(T0 + DAY_MS) }],
    })
    expect(h.cache.expiryOf(forceUpdateOverrideKey(h.tester.userId))).toBe(T0 + 86_400 * 1000)
  })

  it("T12: disabling removes it", async () => {
    const h = await harness()
    expect((await setForceUpdate(h, TESTER_EMAIL, true)).statusCode).toBe(200)
    const res = await setForceUpdate(h, TESTER_EMAIL, false)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accounts: [] })
    expect(await h.cache.get(forceUpdateOverrideKey(h.tester.userId))).toBe(null)
    expect(await listAccounts(h)).toEqual([])
  })

  it("T13: disabling an account without an override answers the list unchanged, audited", async () => {
    const h = await harness()
    const other = await h.session(NEW_TESTER_EMAIL, "citizen")
    expect((await setForceUpdate(h, NEW_TESTER_EMAIL, true)).statusCode).toBe(200)
    const list = await listAccounts(h)
    const audited = h.repo.audits.length
    const res = await setForceUpdate(h, TESTER_EMAIL, false)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accounts: list })
    expect(list.map((a) => a.userId)).toEqual([other.userId])
    expect(h.repo.audits.slice(audited)).toEqual([
      {
        actorId: h.operator.userId,
        action: "dev.force_update_set",
        target: `user:${h.tester.userId}`,
        meta: { enabled: false },
      },
    ])
  })

  it("T14: enabling again renews the 24 hours", async () => {
    const h = await harness()
    expect((await setForceUpdate(h, TESTER_EMAIL, true)).statusCode).toBe(200)
    h.clock.now = T0 + HOUR_MS
    const res = await setForceUpdate(h, TESTER_EMAIL, true)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      accounts: [
        { userId: h.tester.userId, email: TESTER_EMAIL, expiresAt: iso(T0 + HOUR_MS + DAY_MS) },
      ],
    })
  })

  it("T15: an expired override leaves the list and its index", async () => {
    const h = await harness()
    expect((await setForceUpdate(h, TESTER_EMAIL, true)).statusCode).toBe(200)
    h.clock.now = T0 + DAY_MS
    expect(await listAccounts(h)).toEqual([])
    expect(await h.cache.smembers(FORCE_UPDATE_INDEX_KEY)).not.toContain(h.tester.userId)
  })

  it("T16: lists every live override", async () => {
    const h = await harness()
    const other = await h.session(NEW_TESTER_EMAIL, "citizen")
    expect((await setForceUpdate(h, TESTER_EMAIL, true)).statusCode).toBe(200)
    h.clock.now = T0 + HOUR_MS
    expect((await setForceUpdate(h, NEW_TESTER_EMAIL, true)).statusCode).toBe(200)
    const accounts = await listAccounts(h)
    expect(accounts).toHaveLength(2)
    expect(accounts).toEqual(
      expect.arrayContaining([
        { userId: h.tester.userId, email: TESTER_EMAIL, expiresAt: iso(T0 + DAY_MS) },
        { userId: other.userId, email: NEW_TESTER_EMAIL, expiresAt: iso(T0 + HOUR_MS + DAY_MS) },
      ]),
    )
  })

  it("T17: at most 20 overrides at once", async () => {
    const emails = Array.from({ length: 21 }, (_, i) => `t${i + 1}@civfix.org`)
    const h = await harness({ extraTestEmails: emails })
    for (const email of emails) await h.session(email, "citizen")
    await h.tools.setForceUpdate(h.operator.userId, emails[0]!, true)
    h.clock.now = T0 + HOUR_MS
    for (const email of emails.slice(1, 20)) {
      await h.tools.setForceUpdate(h.operator.userId, email, true)
    }
    const list = await listAccounts(h)
    expect(list).toHaveLength(20)
    const audited = h.repo.audits.length

    expectError(await setForceUpdate(h, emails[20]!, true), 409, "CONFLICT")
    expect(await listAccounts(h)).toEqual(list)
    expect(h.repo.audits).toHaveLength(audited)

    expect((await setForceUpdate(h, emails[5]!, true)).statusCode).toBe(200)

    h.clock.now = T0 + DAY_MS
    const res = await setForceUpdate(h, emails[20]!, true)
    expect(res.statusCode).toBe(200)
    const emailsListed = res.json<{ accounts: AdminDevForceUpdateAccount[] }>().accounts
    expect(emailsListed).toHaveLength(20)
    expect(emailsListed.map((a) => a.email)).toContain(emails[20])
    expect(emailsListed.map((a) => a.email)).not.toContain(emails[0])
  })
})

describe("GET /v1/app/config with dev tools", () => {
  function seedFlags(h: Harness): void {
    h.flags.seed("min_app_version_ios", "2.0.0")
    h.flags.seed("min_app_version_android", "2.1.0")
    h.flags.seed("app_store_url_ios", APP_STORE_URL)
    h.flags.seed("announcement_text", "Maintenance tonight")
  }

  function config(h: Harness, as: Session | null): Promise<LightMyRequestResponse> {
    return send(h, { method: "GET", url: "/v1/app/config" }, { as })
  }

  it("T18: a guest gets the flags' answer, never stored", async () => {
    const h = await harness()
    seedFlags(h)
    const res = await config(h, null)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      minAppVersion: { ios: "2.0.0", android: "2.1.0" },
      storeUrl: {
        ios: APP_STORE_URL,
        android: "https://play.google.com/store/apps/details?id=org.civfix.community",
      },
      announcement: { text: "Maintenance tonight", level: "info" },
    })
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("T19: an account with a live override must update", async () => {
    const h = await harness()
    seedFlags(h)
    await h.tools.setForceUpdate(h.operator.userId, TESTER_EMAIL, true)
    const guest = (await config(h, null)).json<Record<string, unknown>>()
    const res = await config(h, h.tester)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      minAppVersion: { ios: "999.0.0", android: "999.0.0" },
      storeUrl: guest.storeUrl,
      announcement: guest.announcement,
    })
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("T20: without an override, or once it expired, the guest's answer", async () => {
    const h = await harness()
    seedFlags(h)
    const guest = await config(h, null)
    const without = await config(h, h.tester)
    expect(without.statusCode).toBe(200)
    expect(without.body).toBe(guest.body)
    expect(without.headers["cache-control"]).toBe("no-store")

    await h.tools.setForceUpdate(h.operator.userId, TESTER_EMAIL, true)
    h.clock.now = T0 + DAY_MS
    const expired = await config(h, h.tester)
    expect(expired.statusCode).toBe(200)
    expect(expired.body).toBe(guest.body)
    expect(expired.headers["cache-control"]).toBe("no-store")
  })

  it("T21: dev tools off ignores any override", async () => {
    const h = await harness({ devTools: false })
    seedFlags(h)
    await h.cache.set(
      forceUpdateOverrideKey(h.tester.userId),
      JSON.stringify({ email: TESTER_EMAIL, expiresAt: iso(T0 + DAY_MS) }),
      86_400,
    )
    const guest = await config(h, null)
    const res = await config(h, h.tester)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(guest.body)
    expect(res.headers["cache-control"]).toBe("public, max-age=60")
  })
})

describe("test tools: test push", () => {
  it("T22: sends the default title and body", async () => {
    const h = await harness()
    const res = await send(h, TEST_PUSH)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ devices: 0 })
    expect(h.push.sent).toEqual([{ userId: h.tester.userId, payload: DEFAULT_PUSH }])
  })

  it("T23: sends the given title and body", async () => {
    const h = await harness()
    const body = { email: TESTER_EMAIL, title: "Hello", body: "World" }
    expect((await send(h, { method: "POST", url: PUSH_URL, body })).statusCode).toBe(200)
    expect(h.push.sent).toEqual([
      { userId: h.tester.userId, payload: { title: "Hello", body: "World" } },
    ])
  })

  it("T24: title up to 80 characters, body up to 200", async () => {
    const h = await harness()
    const push = (extra: Record<string, string>): Call => ({
      method: "POST",
      url: PUSH_URL,
      body: { email: TESTER_EMAIL, ...extra },
    })
    expectError(await send(h, push({ title: "a".repeat(81) })), 422, "VALIDATION")
    expect(h.push.sent).toEqual([])
    expectError(await send(h, push({ body: "b".repeat(201) })), 422, "VALIDATION")
    expect(h.push.sent).toEqual([])
    const ok = await send(h, push({ title: "a".repeat(80), body: "b".repeat(200) }))
    expect(ok.statusCode).toBe(200)
    expect(h.push.sent).toHaveLength(1)
  })

  it("T25: answers the account's active devices, 0 included", async () => {
    const h = await harness()
    h.repo.pushTokens.push(
      { userId: h.tester.userId, revoked: false },
      { userId: h.tester.userId, revoked: false },
      { userId: h.tester.userId, revoked: true },
    )
    const res = await send(h, TEST_PUSH)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ devices: 2 })

    const other = await h.session(NEW_TESTER_EMAIL, "citizen")
    h.push.reset()
    const none = await send(h, { method: "POST", url: PUSH_URL, body: { email: NEW_TESTER_EMAIL } })
    expect(none.statusCode).toBe(200)
    expect(none.json()).toEqual({ devices: 0 })
    expect(h.push.sent).toEqual([{ userId: other.userId, payload: DEFAULT_PUSH }])
  })
})

describe("test tools: test email", () => {
  it("T27: mails the operator's own address through the mailer seam only", async () => {
    const h = await harness()
    const res = await send(h, TEST_EMAIL)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ to: OPERATOR_EMAIL })
    expect(h.mailer.sent.map((m) => m.outbound)).toEqual([
      {
        from: MAIL_FROM,
        to: OPERATOR_EMAIL,
        subject: "civfix test email",
        text: "Sent from the civfix developer console.",
      },
    ])
    expect(h.repo.audits.filter((a) => a.action.startsWith("mail."))).toEqual([])
  })

  it("T28: the request cannot name a recipient", async () => {
    const h = await harness()
    expectError(
      await send(h, { method: "POST", url: EMAIL_URL, body: { to: "x@civfix.org" } }),
      422,
      "VALIDATION",
    )
    expect(h.mailer.sent).toEqual([])
  })
})

describe("test tools: reset first run", () => {
  it("T29: clears the account's profile_complete and nothing else", async () => {
    const h = await harness()
    const before = await h.stores.users.findById(h.tester.userId)
    expect(before?.profileComplete).toBe(true)
    const res = await send(h, RESET_FIRST_RUN)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: h.tester.userId })
    const after = await h.stores.users.findById(h.tester.userId)
    expect(after?.profileComplete).toBe(false)
    expect(after?.handle).toBe(before?.handle)
    expect(after?.displayName).toBe(before?.displayName)
  })

  it("T30: an account already in first run stays there", async () => {
    const h = await harness()
    const tester = await h.stores.users.findById(h.tester.userId)
    h.stores.users.seed(TESTER_EMAIL, { ...tester!, profileComplete: false })
    const res = await send(h, RESET_FIRST_RUN)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: h.tester.userId })
    expect((await h.stores.users.findById(h.tester.userId))?.profileComplete).toBe(false)
  })
})
