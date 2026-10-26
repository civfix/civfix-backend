import { createRequire } from "node:module"
import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeJobs, FakeMailer } from "@civfix/seams"
import {
  AdminDevOverviewResponseSchema,
  RUNTIME_FLAGS,
  type AdminDevJobsResponse,
  type AdminDevOverviewResponse,
  type RuntimeFlagKey,
  type RuntimeFlagStateDTO,
} from "@civfix/contract"
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
import type { WriteAuditInput } from "../../src/services/admin/audit.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryRuntimeFlagRepository } from "../helpers/admin/runtime-flag-repository.memory.js"
import { InMemoryDevJobsRepository } from "../helpers/admin/dev-jobs-repository.memory.js"
import { ALL_QUEUE_NAMES } from "../../src/lib/queue-names.js"

const OPERATOR_EMAIL = "o@civfix.org"
const SECOND_OPERATOR_EMAIL = "p@civfix.org"
const CITIZEN_EMAIL = "resident@example.com"
const GONE_USER = "99999999-9999-4999-8999-999999999999"
const APP_STORE_URL = "https://apps.apple.com/us/app/civfix/id6000000000"
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=org.civfix.community"
const PUBLIC_CACHE = "public, max-age=60"

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
  // The server itself never connects: a test sets DATABASE_URL or REDIS_URL only to show that the
  // overview never repeats them.
  const app = await makeServer({
    env: { ...env, DATABASE_URL: "", REDIS_URL: "" },
    container,
    authServices: services,
  })
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

function flagSet(h: Harness, from: string | null, to: string | null): WriteAuditInput {
  const meta = { from, to }
  return {
    actorId: h.operator.userId,
    action: "dev.flag_set",
    target: "flag:announcement_text",
    meta,
  }
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
      expectError(await putFlag(h, key, { value }), 422, "VALIDATION")
    }
    expect(stored(h)).toBe(before)
  })

  it("T39: rejects a body without value or with an extra key", async () => {
    const h = await harness()
    const before = stored(h)
    expectError(await putFlag(h, "host_messaging_kill_switch", {}), 422, "VALIDATION")
    expectError(
      await putFlag(h, "host_messaging_kill_switch", { value: true, extra: 1 }),
      422,
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
    expect(h.repo.audits).toEqual([flagSet(h, null, "Hi"), flagSet(h, "Hi", "Bye")])
  })

  it("T42: value null clears the override and audits it", async () => {
    const h = await harness()
    h.repo.seed("announcement_text", "Bye", h.operator.userId)
    const res = await putFlag(h, "announcement_text", { value: null })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ override: null, value: null, fallbackSource: "default" })
    expect(h.repo.rows.has("announcement_text")).toBe(false)
    expect(h.repo.audits).toEqual([flagSet(h, "Bye", null)])
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
    const T21_DEFAULTS = [false, false, false, null, null, null, null, "info"]
    for (const [i, flag] of flags.entries()) {
      const expected = T21_DEFAULTS[i]
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

const OVERVIEW_URL = "/v1/admin/dev/overview"
const JOBS_URL = "/v1/admin/dev/jobs"
const NOW = new Date(Date.UTC(2026, 9, 26, 12, 0, 0, 0))
const BOOSTED_A = "11111111-1111-4111-8111-111111111111"
const BOOSTED_B = "22222222-2222-4222-8222-222222222222"
const REVIEWER_CODE = "reviewer-code-7f3a9c1e5b2d4f6a8c0e"
const DEV_TEST_CODE = "devtest-code-4e6b8d0f2a4c6e8a0b2d"
const WORKER_QUEUES = [
  "media.checks",
  "anon.hold.release",
  "orphan.sweep",
  "chat.partition.maintenance",
  "anon.hold.release.sweep",
  "retention.sweep",
  "media.stuck.sweep",
  "media.upload.reap",
]
const RUNNABLE_QUEUES = [
  "inbound.sweep",
  "event.metrics.rollup",
  "anon.hold.release.sweep",
  "chat.partition.maintenance",
]

interface DevStatus {
  repo: InMemoryDevJobsRepository
  jobs: FakeJobs
  audits: WriteAuditInput[]
}

function devStatus(h: Harness): DevStatus {
  const repo = new InMemoryDevJobsRepository(() => NOW)
  const jobs = new FakeJobs()
  const audits: WriteAuditInput[] = []
  h.app.devStatusOverrides = {
    repo,
    jobs,
    audit: (input) => {
      audits.push(input)
      return Promise.resolve()
    },
    now: () => NOW,
  }
  return { repo, jobs, audits }
}

async function overview(h: Harness): Promise<AdminDevOverviewResponse> {
  const res = await call(h, "GET", OVERVIEW_URL, { as: h.operator })
  expect(res.statusCode).toBe(200)
  return res.json<AdminDevOverviewResponse>()
}

function settingValues(body: AdminDevOverviewResponse): string[] {
  return body.settings.map((s) => s.value)
}

function runJob(h: Harness, name: string, opts: { as?: Session; csrf?: boolean } = {}) {
  return call(h, "POST", `/v1/admin/dev/jobs/${name}/run`, { as: h.operator, ...opts })
}

function jobRun(h: Harness, name: string, enqueued: boolean): WriteAuditInput {
  return {
    actorId: h.operator.userId,
    action: "dev.job_run",
    target: `queue:${name}`,
    meta: { enqueued },
  }
}

describe("GET /v1/admin/dev/overview", () => {
  it("T1: the shape with nothing set", async () => {
    const h = await harness()
    const res = await call(h, "GET", OVERVIEW_URL, { as: h.operator })
    expect(res.statusCode).toBe(200)
    const body = AdminDevOverviewResponseSchema.parse(res.json())
    expect(body.environment).toBe("local")
    expect(body.devToolsEnabled).toBe(false)
    expect(body.api.releaseRef).toBe(null)
    expect(body.api.image).toBe(null)
    expect(body.worker.image).toBe(null)
    expect(body.worker.lastJobCompletedAt).toBe(null)
    expect(body.testAccounts).toEqual([])
  })

  it("T4: empty build refs count as unset", async () => {
    const h = await harness({
      CIVFIX_RELEASE_REF: "",
      CIVFIX_API_IMAGE_REF: "",
      CIVFIX_WORKER_IMAGE_REF: "",
    })
    const body = await overview(h)
    expect(body.api.releaseRef).toBe(null)
    expect(body.api.image).toBe(null)
    expect(body.worker.image).toBe(null)
  })

  it("T5: the contract and node versions, and one process start time", async () => {
    const h = await harness()
    const installed = createRequire(import.meta.url)("@civfix/contract/package.json") as {
      version: string
    }
    const before = Date.now()
    const first = await overview(h)
    const second = await overview(h)
    expect(first.api.contractVersion).toBe(installed.version)
    expect(first.api.nodeVersion).toBe(process.version)
    expect(new Date(first.api.startedAt).toISOString()).toBe(first.api.startedAt)
    expect(Date.parse(first.api.startedAt)).toBeLessThanOrEqual(before)
    expect(second.api.startedAt).toBe(first.api.startedAt)
  })

  it("T7: the seven settings, summarized", async () => {
    const h = await harness({
      SMS_GUEST_ENABLED: "true",
      SMS_DAILY_CAP: "75",
      FEED_AUTHOR_BOOSTS: JSON.stringify({ [BOOSTED_A]: 2, [BOOSTED_B]: 1.5 }),
      REVIEWER_OTP_BYPASS: "true",
      REVIEWER_OTP_CODE: REVIEWER_CODE,
      OAUTH_REQUIRE_NONCE: "true",
      WS_ALLOW_QUERY_TOKEN: "false",
    })
    expect((await overview(h)).settings).toEqual([
      { key: "SMS_GUEST_ENABLED", value: "on" },
      { key: "SMS_DAILY_CAP", value: "75" },
      { key: "FEED_RANKING", value: "Default" },
      { key: "FEED_AUTHOR_BOOSTS", value: "2 accounts" },
      { key: "REVIEWER_OTP_BYPASS", value: "on" },
      { key: "OAUTH_REQUIRE_NONCE", value: "on" },
      { key: "WS_ALLOW_QUERY_TOKEN", value: "off" },
    ])
  })

  it("T8: the settings' defaults", async () => {
    const h = await harness()
    expect(settingValues(await overview(h))).toEqual([
      "off",
      "50",
      "Default",
      "0 accounts",
      "off",
      "off",
      "off",
    ])
  })

  it("T9: a feed ranking that differs from the default is Custom", async () => {
    const h = await harness({ FEED_RANKING: JSON.stringify({ baseWeight: 11 }) })
    const body = await overview(h)
    expect(body.settings.find((s) => s.key === "FEED_RANKING")?.value).toBe("Custom")
  })

  it("T10: never contains a secret, code, key, boosted account or credentialed URL", async () => {
    const secrets: Record<string, string> = {
      REVIEWER_OTP_CODE: REVIEWER_CODE,
      DEV_TEST_OTP_CODE: DEV_TEST_CODE,
      FEED_AUTHOR_BOOSTS: JSON.stringify({ [BOOSTED_A]: 2, [BOOSTED_B]: 1.5 }),
      SESSION_SIGNING_KEY: "session-signing-key-9d1f3b5a7c9e1a3c5e7a9b1d3f5a",
      ANON_TOKEN_SIGNING_KEY: "anon-token-signing-key-2b4d6f8a0c2e4a6c8e0a2b4d6f",
      DATABASE_URL: "postgres://civfix:pg-password-5c7e9a1b3d@db.example:5432/civfix",
      REDIS_URL: "redis://:redis-password-8a0c2e4b6d@redis.example:6379",
      GLITCHTIP_DSN: "https://glitchtip-key-3e5a7c9b1d@glitchtip.example/1",
      VAPID_PRIVATE_KEY: "vapid-private-key-6b8d0f2a4c6e",
      APNS_PRIVATE_KEY: "apns-private-key-1c3e5a7b9d1f",
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ private_key: "fcm-private-key-4d6f8a0c2e4b" }),
      EXPO_ACCESS_TOKEN: "expo-access-token-7e9a1c3b5d7f",
    }
    const h = await harness({
      ...secrets,
      REVIEWER_OTP_BYPASS: "true",
      DEV_TOOLS_ENABLED: "true",
      DEV_TEST_EMAILS: "a@civfix.org",
    })
    const res = await call(h, "GET", OVERVIEW_URL, { as: h.operator })
    expect(res.statusCode).toBe(200)
    const needles = [
      ...Object.values(secrets),
      BOOSTED_A,
      BOOSTED_B,
      "pg-password-5c7e9a1b3d",
      "redis-password-8a0c2e4b6d",
      "glitchtip-key-3e5a7c9b1d",
      "fcm-private-key-4d6f8a0c2e4b",
    ]
    for (const needle of needles) expect(res.body).not.toContain(needle)
    expect(res.json<AdminDevOverviewResponse>().settings.map((s) => s.key)).toEqual([
      "SMS_GUEST_ENABLED",
      "SMS_DAILY_CAP",
      "FEED_RANKING",
      "FEED_AUTHOR_BOOSTS",
      "REVIEWER_OTP_BYPASS",
      "OAUTH_REQUIRE_NONCE",
      "WS_ALLOW_QUERY_TOKEN",
    ])
  })

  it("T11: the test accounts only while dev tools are on", async () => {
    const accounts = {
      DEV_TEST_EMAILS: "A@civfix.org, b@civfix.org",
      DEV_TEST_OTP_CODE: DEV_TEST_CODE,
    }
    const on = await overview(await harness({ ...accounts, DEV_TOOLS_ENABLED: "true" }))
    expect(on.devToolsEnabled).toBe(true)
    expect(on.testAccounts).toEqual(["a@civfix.org", "b@civfix.org"])
    await current?.close()
    const off = await overview(await harness({ ...accounts, DEV_TOOLS_ENABLED: "false" }))
    expect(off.devToolsEnabled).toBe(false)
    expect(off.testAccounts).toEqual([])
  })

  it("T14: needs an operator", async () => {
    const h = await harness()
    expectError(await call(h, "GET", OVERVIEW_URL), 401, "UNAUTHORIZED")
    expectError(await call(h, "GET", OVERVIEW_URL, { as: h.citizen }), 403, "FORBIDDEN")
  })
})

describe("GET /v1/admin/dev/jobs", () => {
  async function jobsView(h: Harness): Promise<AdminDevJobsResponse> {
    const res = await call(h, "GET", JOBS_URL, { as: h.operator })
    expect(res.statusCode).toBe(200)
    return res.json<AdminDevJobsResponse>()
  }

  it("T16: with fake jobs every queue is empty and pg-boss is never read", async () => {
    const h = await harness()
    const { repo } = devStatus(h)
    repo.addJob("inbound.sweep", "created", { startAfter: NOW })
    const { queues } = await jobsView(h)
    expect(queues).toHaveLength(ALL_QUEUE_NAMES.length)
    expect(queues.map((q) => q.name)).toEqual([...ALL_QUEUE_NAMES].sort())
    for (const q of queues) {
      expect(q, q.name).toMatchObject({
        counts: { created: 0, retry: 0, active: 0, failed: 0 },
        failedLast24h: 0,
        oldestPendingSeconds: 0,
        lastCompletedAt: null,
        schedule: null,
      })
    }
    expect(repo.snapshotCalls).toEqual([])
    expect(repo.runStateCalls).toBe(0)
  })

  it("T17: the worker owns exactly its eight queues", async () => {
    const h = await harness()
    const { queues } = await jobsView(h)
    expect(queues.filter((q) => q.owner === "worker").map((q) => q.name)).toEqual(
      [...WORKER_QUEUES].sort(),
    )
    expect(queues.filter((q) => q.owner === "api")).toHaveLength(20)
  })

  it("T18: exactly four queues are runnable", async () => {
    const h = await harness()
    const { queues } = await jobsView(h)
    expect(queues.filter((q) => q.runnable).map((q) => q.name)).toEqual([...RUNNABLE_QUEUES].sort())
  })

  it("T27: needs an operator", async () => {
    const h = await harness()
    expectError(await call(h, "GET", JOBS_URL), 401, "UNAUTHORIZED")
    expectError(await call(h, "GET", JOBS_URL, { as: h.citizen }), 403, "FORBIDDEN")
  })
})

describe("POST /v1/admin/dev/jobs/:name/run", () => {
  const REAL_JOBS = { USE_FAKE_JOBS: "false" }

  it("T31: enqueues one run of a runnable API queue, with no options, and audits it", async () => {
    const h = await harness(REAL_JOBS)
    const { repo, jobs, audits } = devStatus(h)
    repo.queues.add("inbound.sweep")
    const res = await runJob(h, "inbound.sweep")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enqueued: true })
    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]).toStrictEqual({
      id: expect.any(String),
      name: "inbound.sweep",
      data: {},
      state: "created",
    })
    expect(audits).toEqual([jobRun(h, "inbound.sweep", true)])
  })

  it("T32: a worker sweep is enqueued with its cron's singletonKey", async () => {
    const h = await harness(REAL_JOBS)
    const { repo, jobs } = devStatus(h)
    for (const name of ["anon.hold.release.sweep", "chat.partition.maintenance"]) {
      repo.queues.add(name)
      const res = await runJob(h, name)
      expect(res.statusCode, name).toBe(200)
      expect(res.json(), name).toEqual({ enqueued: true })
    }
    expect(jobs.enqueued.map((j) => [j.name, j.data, j.opts])).toEqual([
      ["anon.hold.release.sweep", {}, { singletonKey: "anon.hold.release.sweep" }],
      ["chat.partition.maintenance", {}, { singletonKey: "chat.partition.maintenance" }],
    ])
  })

  it("T33: a queue with a created or retry job waiting enqueues nothing", async () => {
    for (const state of ["created", "retry"] as const) {
      const h = await harness(REAL_JOBS)
      const { repo, jobs, audits } = devStatus(h)
      repo.addJob("event.metrics.rollup", state, { startAfter: NOW })
      const res = await runJob(h, "event.metrics.rollup")
      expect(res.statusCode, state).toBe(200)
      expect(res.json(), state).toEqual({ enqueued: false })
      expect(jobs.enqueued, state).toEqual([])
      expect(audits, state).toEqual([jobRun(h, "event.metrics.rollup", false)])
      await current?.close()
    }
  })

  it("T34: an active run is not waiting", async () => {
    const h = await harness(REAL_JOBS)
    const { repo, jobs } = devStatus(h)
    repo.addJob("inbound.sweep", "active", { startAfter: NOW })
    const res = await runJob(h, "inbound.sweep")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enqueued: true })
    expect(jobs.enqueued).toHaveLength(1)
  })

  it("T35: a queue that is not runnable, or not a queue, is NOT_FOUND", async () => {
    const h = await harness(REAL_JOBS)
    const { repo, jobs, audits } = devStatus(h)
    repo.queues.add("outreach.digest")
    expectError(await runJob(h, "outreach.digest"), 404, "NOT_FOUND")
    expectError(await runJob(h, "nope"), 404, "NOT_FOUND")
    expect(jobs.enqueued).toEqual([])
    expect(audits).toEqual([])
  })

  it("T36: a queue pg-boss has not created is NOT_FOUND", async () => {
    const h = await harness(REAL_JOBS)
    const { jobs, audits } = devStatus(h)
    expectError(await runJob(h, "chat.partition.maintenance"), 404, "NOT_FOUND")
    expect(jobs.enqueued).toEqual([])
    expect(audits).toEqual([])
  })

  it("T37: with fake jobs nothing is enqueued and pg-boss is never read", async () => {
    const h = await harness()
    const { repo, jobs, audits } = devStatus(h)
    repo.queues.add("inbound.sweep")
    const res = await runJob(h, "inbound.sweep")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enqueued: false })
    expect(jobs.enqueued).toEqual([])
    expect(repo.runStateCalls).toBe(0)
    expect(repo.snapshotCalls).toEqual([])
    expect(audits).toEqual([jobRun(h, "inbound.sweep", false)])
    expectError(await runJob(h, "outreach.digest"), 404, "NOT_FOUND")
  })

  it("T38: a cookie session without the CSRF header is FORBIDDEN", async () => {
    const h = await harness(REAL_JOBS)
    const { repo, jobs, audits } = devStatus(h)
    repo.queues.add("inbound.sweep")
    expectError(await runJob(h, "inbound.sweep", { csrf: false }), 403, "FORBIDDEN")
    expect(jobs.enqueued).toEqual([])
    expect(audits).toEqual([])
  })

  it("T39: more than 10 runs a minute per operator is RATE_LIMITED", async () => {
    const h = await harness(REAL_JOBS)
    const { repo } = devStatus(h)
    repo.queues.add("inbound.sweep")
    for (let i = 1; i <= 10; i += 1) {
      expect((await runJob(h, "inbound.sweep")).statusCode, `call ${i}`).toBe(200)
    }
    expectError(await runJob(h, "inbound.sweep"), 429, "RATE_LIMITED")
    expect((await runJob(h, "inbound.sweep", { as: h.secondOperator })).statusCode).toBe(200)
  })

  it("T40: needs an operator", async () => {
    const h = await harness(REAL_JOBS)
    const { jobs, audits } = devStatus(h)
    expectError(await call(h, "POST", "/v1/admin/dev/jobs/inbound.sweep/run"), 401, "UNAUTHORIZED")
    expectError(await runJob(h, "inbound.sweep", { as: h.citizen }), 403, "FORBIDDEN")
    expect(jobs.enqueued).toEqual([])
    expect(audits).toEqual([])
  })
})
