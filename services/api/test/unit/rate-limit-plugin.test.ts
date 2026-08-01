/**
 * plugins/rate-limit.ts — the two-limiter shape.
 *
 * H4: sensitive prefixes must FAIL CLOSED when the store errors, while ordinary traffic keeps its lax,
 * skip-on-error global bucket.
 * M22: the key must prefer the authenticated identity over the IP, which only works if the auth
 * onRequest hook has already run — this file locks that hook ordering down, because a silently-broken
 * key generator would look exactly like a working one.
 * L19: /healthz stays exempt; /readyz does not.
 */

import { describe, it, expect } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
  registerRateLimit,
  rateLimitKey,
  identityRateLimitKey,
  sensitiveRateLimitKey,
  wsUpgradeRateLimitKey,
  isSensitivePath,
  perIdentity,
  HOST_CEILING_MULTIPLIER,
} from "../../src/plugins/rate-limit.js"
import {
  CREATE_GROUP_RATE_LIMIT,
  ADD_GROUP_MEMBERS_RATE_LIMIT,
  JOIN_GROUP_RATE_LIMIT,
  GROUP_MODERATION_RATE_LIMIT,
} from "../../src/routes/chat-groups.routes.js"
import {
  EDIT_MESSAGE_RATE_LIMIT,
  TOGGLE_REACTION_RATE_LIMIT,
  CREATE_POLL_RATE_LIMIT,
  VOTE_POLL_RATE_LIMIT,
  CLOSE_POLL_RATE_LIMIT,
} from "../../src/routes/messages.routes.js"
import {
  DM_OPEN_RATE_LIMIT,
  DM_REACTION_RATE_LIMIT,
  DM_MESSAGE_MUTATION_RATE_LIMIT,
} from "../../src/routes/dm.routes.js"
import { CHAT_REACTION_RATE_LIMIT, CHAT_DELETE_RATE_LIMIT } from "../../src/routes/chat.routes.js"
import {
  REPORT_REACTION_RATE_LIMIT,
  REPORT_DELETE_RATE_LIMIT,
  REPORT_CHAT_MEMBERSHIP_RATE_LIMIT,
} from "../../src/routes/report-chat.routes.js"
import { CONVERSATION_MUTE_RATE_LIMIT } from "../../src/routes/conversations.routes.js"
import {
  CERTIFICATE_ISSUE_RATE_LIMIT,
  CERTIFICATE_REVOKE_RATE_LIMIT,
  CERTIFICATE_VERIFY_RATE_LIMIT,
} from "../../src/routes/service-hours-certificates.routes.js"
import { OTP_REQUEST_RATE_LIMIT, OTP_VERIFY_RATE_LIMIT, OAUTH_RATE_LIMIT } from "../../src/routes/auth.routes.js"
import { HOME_TURF_RATE_LIMIT } from "../../src/routes/forms.routes.js"
import { CREATE_POST_RATE_LIMIT } from "../../src/routes/posts.routes.js"
import { ROUTE_REPORT_RATE_LIMIT } from "../../src/routes/admin/reports.routes.js"
import { ANON_CREATE_RATE_LIMIT } from "../../src/routes/anon.routes.js"
import { MEDIA_WRITE_RATE_LIMIT } from "../../src/routes/media.routes.js"
import { CLAIM_RATE_LIMIT } from "../../src/routes/claim.routes.js"
import { GEOCODER_RATE_LIMIT } from "../../src/routes/map.routes.js"
import { INBOUND_WEBHOOK_RATE_LIMIT } from "../../src/routes/webhooks/inbound-mail.routes.js"
import { registerCors } from "../../src/plugins/cors.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import type { RedisClient } from "../../src/adapters/redis.js"

/** A Redis whose rate-limit script always fails — i.e. the outage the fix is about. */
function brokenRedis(): RedisClient {
  return {
    rateLimit: (
      _key: string,
      _tw: number,
      _max: number,
      _ce: boolean,
      _eb: boolean,
      cb: (err: Error | null, result?: unknown) => void,
    ) => cb(new Error("redis is down")),
  } as unknown as RedisClient
}

async function buildApp(
  opts: Parameters<typeof registerRateLimit>[1] = {},
): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(makeErrorHandler())
  await registerRateLimit(app, opts)
  // Mirror server.ts: the auth context hook is an INSTANCE-level onRequest hook registered AFTER the
  // rate limiter. If Fastify ever ran route-level hooks first, the identity key would silently degrade.
  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"]
    req.auth = {
      userId: typeof header === "string" ? header : null,
      roles: [],
      anon: typeof header !== "string",
    }
  })
  app.get("/v1/auth/otp/request", async () => ({ ok: true }))
  app.get("/v1/reports", async () => ({ ok: true }))
  app.get("/healthz", async () => ({ ok: true }))
  app.post("/v1/groups", { config: { rateLimit: CREATE_GROUP_RATE_LIMIT } }, async () => ({
    ok: true,
  }))
  app.get(
    "/v1/service-hours/verify/:code",
    { config: { rateLimit: CERTIFICATE_VERIFY_RATE_LIMIT } },
    async () => ({ ok: true }),
  )
  await app.ready()
  return app
}

describe("rate limiter: sensitive prefixes fail closed (H4)", () => {
  it("429s a sensitive path when the store errors, but still serves ordinary traffic", async () => {
    const app = await buildApp({ redis: brokenRedis() })
    try {
      const sensitive = await app.inject({ method: "GET", url: "/v1/auth/otp/request" })
      expect(sensitive.statusCode).toBe(429)
      expect(sensitive.json().code).toBe("RATE_LIMITED")

      // The global bucket is deliberately lax: a Redis blip must not take the read product down.
      const ordinary = await app.inject({ method: "GET", url: "/v1/reports" })
      expect(ordinary.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it("classifies exactly the sensitive prefixes", () => {
    for (const p of [
      "/v1/auth",
      "/v1/auth/otp/verify",
      "/v1/admin/auth/login",
      "/v1/anon/reports",
      "/v1/media/presign",
      "/v1/claim/abc",
      "/forms/home-turf",
      // Mints a durable, publicly-verifiable artifact from personal data and returns a capability URL.
      "/v1/me/volunteer-hours/certificates",
      "/v1/me/volunteer-hours/certificates/A1B2C3D4E5F6/revoke",
    ]) {
      expect(isSensitivePath(p)).toBe(true)
    }
    for (const p of [
      "/v1/reports",
      "/healthz",
      "/readyz",
      "/v1/authors",
      "/v1/admin/users",
      // `path === p || startsWith(p + "/")`: the plain hours read must NOT inherit the certificates
      // prefix and land in the fail-closed bucket.
      "/v1/me/volunteer-hours",
      // C3, and this negative is the tripwire: the PUBLIC verification read must stay OUT of the
      // fail-closed bucket. It is a read-only lookup that mints nothing, consumes no one-shot secret and
      // hands out no upload URL — and a Redis blip here would 429 the school registrar holding a printed
      // transcript, who is the one audience this feature exists for.
      "/v1/service-hours/verify/A1B2C3D4E5F6",
    ]) {
      expect(isSensitivePath(p)).toBe(false)
    }
  })
})

describe("rate limiter: identity-first keying (M22)", () => {
  it("the GLOBAL key stays IP-only, so presenting a session cannot escape the per-host ceiling", () => {
    const authed = { auth: { userId: "u-1" }, ip: "203.0.113.9" } as never
    const otherAccount = { auth: { userId: "u-2" }, ip: "203.0.113.9" } as never
    const anon = { auth: { userId: null }, ip: "203.0.113.9" } as never
    // All three share one bucket: N accounts on one host must not buy N x the budget (M22 regression).
    expect(rateLimitKey(authed)).toBe("ip:203.0.113.9")
    expect(rateLimitKey(otherAccount)).toBe("ip:203.0.113.9")
    expect(rateLimitKey(anon)).toBe("ip:203.0.113.9")
  })

  it("the SENSITIVE key uses identity when present, so rotating IPs cannot escape it either", () => {
    const authed = { auth: { userId: "u-1" }, ip: "203.0.113.9" } as never
    const sameUserElsewhere = { auth: { userId: "u-1" }, ip: "198.51.100.4" } as never
    const anon = { auth: { userId: null }, ip: "203.0.113.9" } as never
    expect(sensitiveRateLimitKey(authed)).toBe("sensitive:user:u-1")
    expect(sensitiveRateLimitKey(sameUserElsewhere)).toBe("sensitive:user:u-1")
    expect(sensitiveRateLimitKey(anon)).toBe("sensitive:ip:203.0.113.9")
  })

  it("counts one account as ONE bucket even when it rotates IPs", async () => {
    // No redis => the in-process LocalStore, which is enough to count.
    const app = await buildApp({ sensitiveMax: 3 })
    try {
      const hit = (ip: string) =>
        app.inject({
          method: "GET",
          url: "/v1/auth/otp/request",
          headers: { "x-test-user": "attacker" },
          remoteAddress: ip,
        })
      expect((await hit("203.0.113.1")).statusCode).toBe(200)
      expect((await hit("203.0.113.2")).statusCode).toBe(200)
      expect((await hit("203.0.113.3")).statusCode).toBe(200)
      // Fourth request from a fourth address: the ACCOUNT is over its limit.
      const blocked = await hit("203.0.113.4")
      expect(blocked.statusCode).toBe(429)

      // A different account from a already-used IP is unaffected (the key really is the identity).
      const other = await app.inject({
        method: "GET",
        url: "/v1/auth/otp/request",
        headers: { "x-test-user": "bystander" },
        remoteAddress: "203.0.113.1",
      })
      expect(other.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

function requestShapes(): { label: string; req: never }[] {
  return [
    { label: "authenticated", req: { auth: { userId: "u-1" }, ip: "203.0.113.9" } as never },
    { label: "anonymous", req: { auth: { userId: null }, ip: "203.0.113.9" } as never },
    { label: "no auth context", req: { ip: "203.0.113.9" } as never },
    { label: "no ip", req: { auth: { userId: null } } as never },
  ]
}

const KEY_GENERATORS = {
  global: rateLimitKey,
  identity: identityRateLimitKey,
  sensitive: sensitiveRateLimitKey,
  "ws-upgrade": wsUpgradeRateLimitKey,
}

describe("rate limiter: bucket key shapes (CVX-013)", () => {
  it("never emits a key containing 'undefined', whatever the request carries", () => {
    for (const [name, generate] of Object.entries(KEY_GENERATORS)) {
      for (const { label, req } of requestShapes()) {
        const key = generate(req)
        expect(key, `${name} / ${label}`).not.toContain("undefined")
        expect(key, `${name} / ${label}`).toMatch(/(^|:)(user|ip):[^:]/)
      }
    }
  })

  it("namespaces the two hand-rolled buckets, which share one store prefix, so they cannot collide", () => {
    const req = { auth: { userId: null }, ip: "203.0.113.9" } as never
    expect(sensitiveRateLimitKey(req)).toBe("sensitive:ip:203.0.113.9")
    expect(wsUpgradeRateLimitKey(req)).toBe("ws-upgrade:ip:203.0.113.9")
    expect(sensitiveRateLimitKey(req)).not.toBe(wsUpgradeRateLimitKey(req))
  })

  it("keys the /ws upgrade bucket by IP even for an authenticated request, since the upgrade precedes the session", () => {
    const authed = { auth: { userId: "u-1" }, ip: "203.0.113.9" } as never
    expect(wsUpgradeRateLimitKey(authed)).toBe("ws-upgrade:ip:203.0.113.9")
  })

  it("carries the whole discriminator in the generated key for buckets whose store prefix has no route", async () => {
    const redis = recordingRedis()
    const app = await buildApp({ redis: redis.client, sensitiveMax: 5 })
    try {
      await app.inject({
        method: "GET",
        url: "/v1/auth/otp/request",
        headers: { "x-test-user": "u-1" },
        remoteAddress: "203.0.113.9",
      })
      expect(redis.keys.some((k) => k.endsWith("-sensitive:user:u-1"))).toBe(true)
    } finally {
      await app.close()
    }
  })
})

interface RecordingRedis {
  client: RedisClient
  keys: string[]
}

function recordingRedis(): RecordingRedis {
  const counts = new Map<string, number>()
  const keys: string[] = []
  const client = {
    rateLimit: (
      key: string,
      timeWindow: number,
      _max: number,
      _ce: boolean,
      _eb: boolean,
      cb: (err: Error | null, result?: unknown) => void,
    ) => {
      keys.push(key)
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      cb(null, [next, timeWindow])
    },
  } as unknown as RedisClient
  return { client, keys }
}

const IDENTITY_SCOPED_LIMITS = {
  CREATE_GROUP_RATE_LIMIT,
  ADD_GROUP_MEMBERS_RATE_LIMIT,
  JOIN_GROUP_RATE_LIMIT,
  GROUP_MODERATION_RATE_LIMIT,
  EDIT_MESSAGE_RATE_LIMIT,
  TOGGLE_REACTION_RATE_LIMIT,
  CREATE_POLL_RATE_LIMIT,
  VOTE_POLL_RATE_LIMIT,
  CLOSE_POLL_RATE_LIMIT,
  DM_OPEN_RATE_LIMIT,
  DM_REACTION_RATE_LIMIT,
  DM_MESSAGE_MUTATION_RATE_LIMIT,
  CHAT_REACTION_RATE_LIMIT,
  CHAT_DELETE_RATE_LIMIT,
  REPORT_REACTION_RATE_LIMIT,
  REPORT_DELETE_RATE_LIMIT,
  REPORT_CHAT_MEMBERSHIP_RATE_LIMIT,
  CONVERSATION_MUTE_RATE_LIMIT,
  CERTIFICATE_ISSUE_RATE_LIMIT,
  CERTIFICATE_REVOKE_RATE_LIMIT,
  CREATE_POST_RATE_LIMIT,
  ROUTE_REPORT_RATE_LIMIT,
}

const HOST_SCOPED_LIMITS = {
  CERTIFICATE_VERIFY_RATE_LIMIT,
  OTP_REQUEST_RATE_LIMIT,
  OTP_VERIFY_RATE_LIMIT,
  OAUTH_RATE_LIMIT,
  HOME_TURF_RATE_LIMIT,
  ANON_CREATE_RATE_LIMIT,
  MEDIA_WRITE_RATE_LIMIT,
  CLAIM_RATE_LIMIT,
  GEOCODER_RATE_LIMIT,
  INBOUND_WEBHOOK_RATE_LIMIT,
}

describe("rate limiter: route bucket scoping policy (CVX-012)", () => {
  it("keys every authenticated-only mutation bucket by identity", () => {
    for (const [name, limit] of Object.entries(IDENTITY_SCOPED_LIMITS)) {
      expect((limit as { keyGenerator?: unknown }).keyGenerator, name).toBe(identityRateLimitKey)
    }
  })

  it("leaves the buckets that guard unauthenticated or credential-minting surface on the per-host key", () => {
    for (const [name, limit] of Object.entries(HOST_SCOPED_LIMITS)) {
      expect((limit as { keyGenerator?: unknown }).keyGenerator, name).toBeUndefined()
    }
  })
})

describe("rate limiter: authenticated route buckets key by user (CVX-012)", () => {
  it("gives two accounts behind ONE address independent group-creation buckets", async () => {
    const app = await buildApp()
    try {
      const create = (user: string) =>
        app.inject({
          method: "POST",
          url: "/v1/groups",
          headers: { "x-test-user": user },
          remoteAddress: "203.0.113.9",
        })
      for (let i = 0; i < CREATE_GROUP_RATE_LIMIT.max; i++) {
        expect((await create("noisy-neighbor")).statusCode).toBe(200)
      }
      expect((await create("noisy-neighbor")).statusCode).toBe(429)
      expect((await create("bystander")).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it("writes a store key carrying BOTH the route and the identity", async () => {
    const redis = recordingRedis()
    const app = await buildApp({ redis: redis.client })
    try {
      await app.inject({
        method: "POST",
        url: "/v1/groups",
        headers: { "x-test-user": "u-1" },
        remoteAddress: "203.0.113.9",
      })
      expect(redis.keys).toContain("fastify-rate-limit-POST/v1/groups-user:u-1")
      expect(redis.keys.some((k) => k.endsWith("-host:POST/v1/groups:ip:203.0.113.9"))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it("still bounds one HOST that spreads the same abuse over many accounts", async () => {
    const app = await buildApp()
    try {
      const create = (user: string) =>
        app.inject({
          method: "POST",
          url: "/v1/groups",
          headers: { "x-test-user": user },
          remoteAddress: "203.0.113.9",
        })
      const accounts = HOST_CEILING_MULTIPLIER
      for (let account = 0; account < accounts; account++) {
        for (let i = 0; i < CREATE_GROUP_RATE_LIMIT.max; i++) {
          expect((await create(`sockpuppet-${account}`)).statusCode).toBe(200)
        }
      }
      const blocked = await create("sockpuppet-fresh")
      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers["retry-after"]).toBeDefined()
      expect(blocked.headers["x-ratelimit-reset"]).toBeDefined()
      expect(blocked.headers["x-ratelimit-limit"]).toBe(String(CREATE_GROUP_RATE_LIMIT.max))
      expect(blocked.headers["x-ratelimit-remaining"]).toBe(String(CREATE_GROUP_RATE_LIMIT.max - 1))

      const otherHost = await app.inject({
        method: "POST",
        url: "/v1/groups",
        headers: { "x-test-user": "sockpuppet-fresh" },
        remoteAddress: "198.51.100.4",
      })
      expect(otherHost.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it("lets an expensive route pin its own host budget instead of the multiplier", async () => {
    expect(CERTIFICATE_ISSUE_RATE_LIMIT.hostMax).toBe(CERTIFICATE_ISSUE_RATE_LIMIT.max)

    const app = Fastify()
    app.setErrorHandler(makeErrorHandler())
    await registerRateLimit(app)
    app.addHook("onRequest", async (req) => {
      req.auth = { userId: String(req.headers["x-test-user"]), roles: [], anon: false }
    })
    app.post(
      "/v1/expensive",
      {
        config: {
          rateLimit: perIdentity({ max: 2, timeWindow: "1 minute", hostMax: 3 }),
        },
      },
      async () => ({ ok: true }),
    )
    await app.ready()
    try {
      const call = (user: string) =>
        app.inject({
          method: "POST",
          url: "/v1/expensive",
          headers: { "x-test-user": user },
          remoteAddress: "203.0.113.9",
        })
      expect((await call("u-1")).statusCode).toBe(200)
      expect((await call("u-1")).statusCode).toBe(200)
      expect((await call("u-2")).statusCode).toBe(200)
      expect((await call("u-3")).statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })

  it("refuses to register a hand-rolled keyGenerator, which would silently escape the host ceiling", async () => {
    const app = Fastify()
    await registerRateLimit(app)
    expect(() =>
      app.post(
        "/v1/hand-rolled",
        { config: { rateLimit: { max: 100, timeWindow: "1 minute", keyGenerator: () => "user:x" } } },
        async () => ({ ok: true }),
      ),
    ).toThrow(/perIdentity\(\) or perHost\(\)/)
    expect(() =>
      app.post(
        "/v1/branded-but-overridden",
        {
          config: {
            rateLimit: {
              ...perIdentity({ max: 100, timeWindow: "1 minute" }),
              keyGenerator: () => "user:x",
            },
          },
        },
        async () => ({ ok: true }),
      ),
    ).toThrow(/perIdentity\(\) or perHost\(\)/)
    await app.close()
  })

  it("refuses to register an identity-keyed route whose limit cannot yield a host ceiling", async () => {
    const app = Fastify()
    await registerRateLimit(app)
    expect(() =>
      app.get(
        "/v1/dynamic",
        {
          config: {
            rateLimit: perIdentity({
              max: (() => 10) as unknown as number,
              timeWindow: "1 minute",
            }),
          },
        },
        async () => ({ ok: true }),
      ),
    ).toThrow(/literal max and timeWindow/)
    await app.close()
  })

  it("keys an UNAUTHENTICATED route bucket by IP, so anonymous abuse controls stay per-host", async () => {
    const redis = recordingRedis()
    const app = await buildApp({ redis: redis.client })
    try {
      const verify = (ip: string) =>
        app.inject({ method: "GET", url: "/v1/service-hours/verify/ABC", remoteAddress: ip })
      for (let i = 0; i < CERTIFICATE_VERIFY_RATE_LIMIT.max; i++) {
        expect((await verify("203.0.113.9")).statusCode).toBe(200)
      }
      expect((await verify("203.0.113.9")).statusCode).toBe(429)
      expect((await verify("198.51.100.4")).statusCode).toBe(200)
      expect(redis.keys).toContain(
        "fastify-rate-limit-GET/v1/service-hours/verify/:code-ip:203.0.113.9",
      )
      expect(redis.keys.some((k) => k.includes("host:GET/v1/service-hours"))).toBe(false)
    } finally {
      await app.close()
    }
  })
})

describe("rate limiter: 429s carry the standard back-off headers (CVX-012)", () => {
  it("on a route bucket", async () => {
    const app = await buildApp()
    try {
      const verify = () =>
        app.inject({
          method: "GET",
          url: "/v1/service-hours/verify/ABC",
          remoteAddress: "203.0.113.9",
        })
      for (let i = 0; i < CERTIFICATE_VERIFY_RATE_LIMIT.max; i++) await verify()
      const blocked = await verify()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers["x-ratelimit-limit"]).toBe(String(CERTIFICATE_VERIFY_RATE_LIMIT.max))
      expect(blocked.headers["x-ratelimit-remaining"]).toBe("0")
      expect(blocked.headers["x-ratelimit-reset"]).toBeDefined()
      expect(blocked.headers["retry-after"]).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it("exposes those headers cross-origin, which browsers otherwise hide from JS", async () => {
    const app = Fastify()
    await registerCors(app, ["https://app.example"])
    app.get("/v1/reports", async () => ({ ok: true }))
    await app.ready()
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/reports",
        headers: { origin: "https://app.example" },
      })
      const exposed = String(res.headers["access-control-expose-headers"] ?? "").toLowerCase()
      for (const header of [
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "retry-after",
      ]) {
        expect(exposed).toContain(header)
      }
    } finally {
      await app.close()
    }
  })

  it("on the hand-enforced sensitive bucket, which previously sent prose only", async () => {
    const app = await buildApp({ sensitiveMax: 1 })
    try {
      const hit = () =>
        app.inject({
          method: "GET",
          url: "/v1/auth/otp/request",
          headers: { "x-test-user": "u-1" },
          remoteAddress: "203.0.113.9",
        })
      expect((await hit()).statusCode).toBe(200)
      const blocked = await hit()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().code).toBe("RATE_LIMITED")
      expect(blocked.headers["x-ratelimit-limit"]).toBe("1")
      expect(blocked.headers["x-ratelimit-remaining"]).toBe("0")
      expect(blocked.headers["x-ratelimit-reset"]).toBeDefined()
      expect(blocked.headers["retry-after"]).toBeDefined()
    } finally {
      await app.close()
    }
  })
})

describe("rate limiter: allowlist (L19)", () => {
  it("exempts /healthz only", async () => {
    const app = await buildApp()
    try {
      const live = await app.inject({ method: "GET", url: "/healthz" })
      expect(live.headers["x-ratelimit-limit"]).toBeUndefined()
      const ordinary = await app.inject({ method: "GET", url: "/v1/reports" })
      expect(ordinary.headers["x-ratelimit-limit"]).toBeDefined()
    } finally {
      await app.close()
    }
  })
})
