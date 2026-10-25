import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer } from "@civfix/seams"
import { RUNTIME_FLAGS, type RuntimeFlagKey, type RuntimeFlagStateDTO } from "@civfix/contract"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import {
  makeRuntimeFlagService,
  type RuntimeFlagService,
} from "../../src/services/admin/runtime-flag-service.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryRuntimeFlagRepository } from "../helpers/admin/runtime-flag-repository.memory.js"

const OPERATOR_EMAIL = "o@civfix.org"
const SECOND_OPERATOR_EMAIL = "p@civfix.org"
const CITIZEN_EMAIL = "resident@example.com"
const GONE_USER = "99999999-9999-4999-8999-999999999999"
const APP_STORE_URL = "https://apps.apple.com/us/app/civfix/id6000000000"
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=org.civfix.community"
const PUBLIC_CACHE = "public, max-age=60"

const DEFAULTS: Record<RuntimeFlagKey, unknown> = {
  host_messaging_kill_switch: false,
  outreach_digest_enabled: false,
  report_autoforward_enabled: false,
  min_app_version_ios: null,
  min_app_version_android: null,
  app_store_url_ios: null,
  announcement_text: null,
  announcement_level: "info",
}

interface Session {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  app: FastifyInstance
  repo: InMemoryRuntimeFlagRepository
  flags: RuntimeFlagService
  clock: { now: number }
  operator: Session
  secondOperator: Session
  citizen: Session
}

let current: FastifyInstance | undefined

afterEach(async () => {
  await current?.close()
  current = undefined
})

async function harness(extraEnv: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const stores = makeInMemoryStores()
  const services: AuthServices = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({
    NODE_ENV: "test",
    ADMIN_EMAILS: `${OPERATOR_EMAIL},${SECOND_OPERATOR_EMAIL}`,
    ...extraEnv,
  })
  const repo = new InMemoryRuntimeFlagRepository()
  const clock = { now: 0 }
  const flags = makeRuntimeFlagService({
    repo,
    envFallbacks: env.runtimeFlagEnvFallbacks,
    logger: { warn: () => undefined, error: () => undefined },
    now: () => clock.now,
  })
  const container: Container = { ...makeContainer(env), getRuntimeFlags: () => flags }
  const app = await makeServer({ env, container, authServices: services })
  current = app

  async function session(email: string, role: "operator" | "citizen"): Promise<Session> {
    const user = await stores.users.create(email, {
      displayName: email,
      role,
      emailVerified: true,
    })
    repo.emails.set(user.id, email)
    const token = await services.sessions.createSession(user.id, [role])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { userId: user.id, cookie: `civfix_session=${token}`, csrfToken }
  }

  return {
    app,
    repo,
    flags,
    clock,
    operator: await session(OPERATOR_EMAIL, "operator"),
    secondOperator: await session(SECOND_OPERATOR_EMAIL, "operator"),
    citizen: await session(CITIZEN_EMAIL, "citizen"),
  }
}

type Method = "GET" | "PUT" | "POST"

function call(
  h: Harness,
  method: Method,
  url: string,
  opts: { as?: Session; csrf?: boolean; body?: unknown } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {}
  if (opts.as) {
    headers.cookie = opts.as.cookie
    if (opts.csrf ?? true) headers["x-csrf-token"] = opts.as.csrfToken
  }
  return h.app.inject({
    method,
    url,
    headers,
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  })
}

function putFlag(
  h: Harness,
  key: string,
  body: unknown,
  opts: { as?: Session; csrf?: boolean } = {},
): Promise<LightMyRequestResponse> {
  return call(h, "PUT", `/v1/admin/dev/flags/${key}`, { as: h.operator, ...opts, body })
}

async function listFlags(h: Harness): Promise<RuntimeFlagStateDTO[]> {
  const res = await call(h, "GET", "/v1/admin/dev/flags", { as: h.operator })
  expect(res.statusCode).toBe(200)
  return res.json<{ flags: RuntimeFlagStateDTO[] }>().flags
}

function entry(flags: RuntimeFlagStateDTO[], key: RuntimeFlagKey): RuntimeFlagStateDTO {
  const found = flags.find((f) => f.key === key)
  if (found === undefined) throw new Error(`no ${key} in the list`)
  return found
}

function stored(h: Harness): string {
  return JSON.stringify({ rows: [...h.repo.rows], audits: h.repo.audits })
}

function expectError(res: LightMyRequestResponse, status: number, code: string): void {
  expect(res.statusCode).toBe(status)
  expect(res.json<{ code: string }>().code).toBe(code)
}

describe("PUT /v1/admin/dev/flags/:key", () => {
  it("T30: a write refreshes this process's flags at once", async () => {
    const h = await harness()
    expect(await h.flags.get("announcement_text")).toBe(null)
    h.clock.now = 1000
    expect((await putFlag(h, "announcement_text", { value: "Hi" })).statusCode).toBe(200)
    expect(await h.flags.get("announcement_text")).toBe("Hi")
  })

  it("T36: stores the trimmed value", async () => {
    const h = await harness()
    const res = await putFlag(h, "min_app_version_ios", { value: "  1.4.0 " })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ value: "1.4.0", override: "1.4.0" })
    expect(h.repo.rows.get("min_app_version_ios")?.value).toBe("1.4.0")
  })

  it("T37: sets a valid value of every type", async () => {
    const h = await harness()
    const cases: [RuntimeFlagKey, boolean | string][] = [
      ["host_messaging_kill_switch", true],
      ["app_store_url_ios", APP_STORE_URL],
      ["announcement_text", "a".repeat(200)],
      ["announcement_level", "warning"],
    ]
    for (const [key, value] of cases) {
      const res = await putFlag(h, key, { value })
      expect(res.statusCode, key).toBe(200)
      expect(res.json(), key).toMatchObject({ override: value, value })
    }
  })

  it("T38: rejects a value that fails its flag's schema", async () => {
    const h = await harness()
    const before = stored(h)
    const cases: [RuntimeFlagKey, unknown][] = [
      ["min_app_version_ios", "1.4"],
      ["min_app_version_ios", "v1.4.0"],
      ["min_app_version_ios", 140],
      ["app_store_url_ios", "http://apps.apple.com/x"],
      ["app_store_url_ios", "https://example.com/"],
      ["announcement_text", "a".repeat(201)],
      ["announcement_text", "   "],
      ["announcement_text", ""],
      ["announcement_level", "Warning"],
      ["host_messaging_kill_switch", "true"],
    ]
    for (const [key, value] of cases) {
      expectError(await putFlag(h, key, { value }), 400, "VALIDATION")
    }
    expect(stored(h)).toBe(before)
  })

  it("T39: rejects a body without value or with an extra key", async () => {
    const h = await harness()
    const before = stored(h)
    expectError(await putFlag(h, "host_messaging_kill_switch", {}), 400, "VALIDATION")
    expectError(
      await putFlag(h, "host_messaging_kill_switch", { value: true, extra: 1 }),
      400,
      "VALIDATION",
    )
    expect(stored(h)).toBe(before)
  })

  it("T40: an unknown key is NOT_FOUND before any value check", async () => {
    const h = await harness()
    const before = stored(h)
    expectError(await putFlag(h, "nope", { value: true }), 404, "NOT_FOUND")
    expectError(await putFlag(h, "nope", { value: "x".repeat(500) }), 404, "NOT_FOUND")
    expect(stored(h)).toBe(before)
  })

  it("T41: each change writes dev.flag_set with the old and new override", async () => {
    const h = await harness()
    expect((await putFlag(h, "announcement_text", { value: "Hi" })).statusCode).toBe(200)
    expect((await putFlag(h, "announcement_text", { value: "Bye" })).statusCode).toBe(200)
    expect(h.repo.audits).toEqual([
      {
        actorId: h.operator.userId,
        action: "dev.flag_set",
        target: "flag:announcement_text",
        meta: { from: null, to: "Hi" },
      },
      {
        actorId: h.operator.userId,
        action: "dev.flag_set",
        target: "flag:announcement_text",
        meta: { from: "Hi", to: "Bye" },
      },
    ])
  })

  it("T42: value null clears the override and audits it", async () => {
    const h = await harness()
    h.repo.seed("announcement_text", "Bye", h.operator.userId)
    const res = await putFlag(h, "announcement_text", { value: null })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ override: null, value: null, fallbackSource: "default" })
    expect(h.repo.rows.has("announcement_text")).toBe(false)
    expect(h.repo.audits).toEqual([
      {
        actorId: h.operator.userId,
        action: "dev.flag_set",
        target: "flag:announcement_text",
        meta: { from: "Bye", to: null },
      },
    ])
  })

  it("T43: clearing a flag with no override changes nothing", async () => {
    const h = await harness()
    const res = await putFlag(h, "announcement_text", { value: null })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ override: null })
    expect(h.repo.rows.has("announcement_text")).toBe(false)
    expect(h.repo.audits).toEqual([])
  })

  it("T44: value null clears a boolean override too", async () => {
    const h = await harness()
    h.repo.seed("host_messaging_kill_switch", true, h.operator.userId)
    const res = await putFlag(h, "host_messaging_kill_switch", { value: null })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ override: null })
    expect(h.repo.rows.has("host_messaging_kill_switch")).toBe(false)
  })

  it("T46: a cookie session without the CSRF header is FORBIDDEN", async () => {
    const h = await harness()
    const before = stored(h)
    expectError(
      await putFlag(h, "announcement_text", { value: "Hi" }, { csrf: false }),
      403,
      "FORBIDDEN",
    )
    expect(stored(h)).toBe(before)
  })

  it("T47: more than 20 changes a minute per operator is RATE_LIMITED", async () => {
    const h = await harness()
    for (let i = 0; i < 20; i += 1) {
      const res = await putFlag(h, "announcement_text", { value: `Hi ${i}` })
      expect(res.statusCode).toBe(200)
    }
    const before = stored(h)
    expectError(await putFlag(h, "announcement_text", { value: "Hi 20" }), 429, "RATE_LIMITED")
    expect(stored(h)).toBe(before)
    const other = await putFlag(
      h,
      "announcement_text",
      { value: "Other" },
      { as: h.secondOperator },
    )
    expect(other.statusCode).toBe(200)
  })

  it("T48: needs an operator", async () => {
    const h = await harness()
    const before = stored(h)
    expectError(
      await call(h, "PUT", "/v1/admin/dev/flags/announcement_text", { body: { value: "Hi" } }),
      401,
      "UNAUTHORIZED",
    )
    expectError(
      await putFlag(h, "announcement_text", { value: "Hi" }, { as: h.citizen }),
      403,
      "FORBIDDEN",
    )
    expect(stored(h)).toBe(before)
  })
})

describe("GET /v1/admin/dev/flags", () => {
  it("T31: lists every registry flag in order with its fallback on a fresh database", async () => {
    const h = await harness()
    const flags = await listFlags(h)
    expect(flags.map((f) => f.key)).toEqual(RUNTIME_FLAGS.map((f) => f.key))
    for (const flag of flags) {
      const expected = DEFAULTS[flag.key as RuntimeFlagKey]
      expect(flag).toEqual({
        key: flag.key,
        value: expected,
        override: null,
        fallback: expected,
        fallbackSource: "default",
        updatedAt: null,
        updatedBy: null,
      })
    }
  })

  it("T32: shows an env fallback as such", async () => {
    const h = await harness({ HOST_MESSAGING_KILL_SWITCH: "true" })
    expect(entry(await listFlags(h), "host_messaging_kill_switch")).toMatchObject({
      value: true,
      override: null,
      fallback: true,
      fallbackSource: "env",
    })
  })

  it("T33: shows an override with who set it and when", async () => {
    const h = await harness()
    expect((await putFlag(h, "announcement_text", { value: "Hi" })).statusCode).toBe(200)
    const shown = entry(await listFlags(h), "announcement_text")
    expect(shown).toMatchObject({
      value: "Hi",
      override: "Hi",
      fallback: null,
      fallbackSource: "default",
      updatedBy: { id: h.operator.userId, email: OPERATOR_EMAIL },
    })
    expect(new Date(shown.updatedAt!).toISOString()).toBe(shown.updatedAt)
  })

  it("T34: updatedBy is null when the account is gone", async () => {
    const h = await harness()
    h.repo.seed("announcement_text", "Hi", GONE_USER)
    const shown = entry(await listFlags(h), "announcement_text")
    expect(shown.updatedBy).toBe(null)
    expect(shown.override).toBe("Hi")
    expect(shown.updatedAt).not.toBe(null)
  })

  it("T35: needs an operator", async () => {
    const h = await harness()
    expectError(await call(h, "GET", "/v1/admin/dev/flags"), 401, "UNAUTHORIZED")
    expectError(await call(h, "GET", "/v1/admin/dev/flags", { as: h.citizen }), 403, "FORBIDDEN")
  })
})

describe("GET /v1/app/config", () => {
  function seedT50(h: Harness): void {
    h.repo.seed("min_app_version_ios", "2.0.0")
    h.repo.seed("min_app_version_android", "2.1.0")
    h.repo.seed("app_store_url_ios", APP_STORE_URL)
    h.repo.seed("announcement_text", "Maintenance tonight")
  }

  it("T49: the defaults, publicly cacheable", async () => {
    const h = await harness()
    const res = await call(h, "GET", "/v1/app/config")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      minAppVersion: { ios: null, android: null },
      storeUrl: { ios: null, android: PLAY_STORE_URL },
      announcement: null,
    })
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE)
  })

  it("T50: built from the public flags", async () => {
    const h = await harness()
    seedT50(h)
    const res = await call(h, "GET", "/v1/app/config")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      minAppVersion: { ios: "2.0.0", android: "2.1.0" },
      storeUrl: { ios: APP_STORE_URL, android: PLAY_STORE_URL },
      announcement: { text: "Maintenance tonight", level: "info" },
    })
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE)
  })

  it("T51: the announcement takes its level, and is null without text", async () => {
    const h = await harness()
    seedT50(h)
    h.repo.seed("announcement_level", "warning")
    const withText = await call(h, "GET", "/v1/app/config")
    expect(withText.json<{ announcement: { level: string } }>().announcement.level).toBe("warning")
    expect((await putFlag(h, "announcement_text", { value: null })).statusCode).toBe(200)
    const cleared = await call(h, "GET", "/v1/app/config")
    expect(cleared.json<{ announcement: unknown }>().announcement).toBe(null)
  })

  it("T52: the same answer for a guest, a citizen and an operator", async () => {
    const h = await harness()
    seedT50(h)
    const guest = await call(h, "GET", "/v1/app/config")
    const citizen = await call(h, "GET", "/v1/app/config", { as: h.citizen })
    const operator = await call(h, "GET", "/v1/app/config", { as: h.operator })
    for (const res of [guest, citizen, operator]) {
      expect(res.statusCode).toBe(200)
      expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE)
    }
    expect(citizen.body).toBe(guest.body)
    expect(operator.body).toBe(guest.body)
  })
})

describe("developer placeholders", () => {
  const TEST_EMAIL = "a@civfix.org"
  const PLACEHOLDERS: { method: Method; url: string; body?: unknown; mutation: boolean }[] = [
    { method: "GET", url: "/v1/admin/dev/overview", mutation: false },
    { method: "GET", url: "/v1/admin/dev/jobs", mutation: false },
    { method: "POST", url: "/v1/admin/dev/jobs/inbound.sweep/run", mutation: true },
    { method: "GET", url: "/v1/admin/dev/test/force-update", mutation: false },
    {
      method: "PUT",
      url: "/v1/admin/dev/test/force-update",
      body: { email: TEST_EMAIL, enabled: true },
      mutation: true,
    },
    { method: "POST", url: "/v1/admin/dev/test/push", body: { email: TEST_EMAIL }, mutation: true },
    { method: "POST", url: "/v1/admin/dev/test/email", body: {}, mutation: true },
    {
      method: "POST",
      url: "/v1/admin/dev/test/reset-first-run",
      body: { email: TEST_EMAIL },
      mutation: true,
    },
  ]

  it("T56: each answers NOT_FOUND from its own handler for an operator", async () => {
    const h = await harness()
    for (const p of PLACEHOLDERS) {
      const res = await call(h, p.method, p.url, { as: h.operator, body: p.body })
      expectError(res, 404, "NOT_FOUND")
      expect(res.json<{ message: string }>().message.startsWith("Route ")).toBe(false)
    }
  })

  it("T57: each needs an operator", async () => {
    const h = await harness()
    for (const p of PLACEHOLDERS) {
      expectError(await call(h, p.method, p.url, { body: p.body }), 401, "UNAUTHORIZED")
      expectError(await call(h, p.method, p.url, { as: h.citizen, body: p.body }), 403, "FORBIDDEN")
    }
  })

  it("T58: each mutation needs the CSRF header", async () => {
    const h = await harness()
    for (const p of PLACEHOLDERS.filter((p) => p.mutation)) {
      expectError(
        await call(h, p.method, p.url, { as: h.operator, csrf: false, body: p.body }),
        403,
        "FORBIDDEN",
      )
    }
  })
})
