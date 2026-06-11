import { describe, it, expect, afterEach } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import {
  parseTrustProxy,
  DEFAULT_TRUSTED_PROXY_CIDRS,
} from "../../src/plugins/trust-proxy.js"
import { loadEnv } from "../../src/env.js"
import { buildServer } from "../../src/server.js"
import { normalizeIp } from "../../src/abuse/ip-rate-limit.js"
import type { AnonReportRequest } from "@civfix/shared"
import type {
  AnonService,
  AnonSubmitContext,
  AnonSubmitResult,
} from "../../src/services/anon-service.js"

/**
 * P0-1 (security): a client-supplied X-Forwarded-For must NOT be able to spoof request.ip (the per-IP
 * abuse / rate-limit key). Two layers are proven:
 *   1. parseTrustProxy maps TRUST_PROXY to a SAFE Fastify trustProxy value, defaulting to the internal
 *      loopback+private CIDRs (never `true`/trust-all).
 *   2. End-to-end through the real buildServer: a request from an UNTRUSTED (public) peer that sends a
 *      forged X-Forwarded-For is resolved to the real socket peer, and the anon abuse stack receives
 *      that real client IP - not the spoofed value. (The trusted-hop value Caddy sets is honored; the
 *      Caddyfile strips inbound XFF so the client cannot pre-seed even that.)
 */

// ---------------------------------------------------------------------------
// parseTrustProxy (pure)
// ---------------------------------------------------------------------------

describe("parseTrustProxy", () => {
  it("defaults to the internal loopback+private CIDR set (NOT trust-all) when unset or blank", () => {
    expect(parseTrustProxy(undefined)).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy("")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy("   ")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    // The default must never be the unsafe trust-all boolean.
    expect(parseTrustProxy(undefined)).not.toBe(true)
  })

  it("parses a bare non-negative integer as a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1)
    expect(parseTrustProxy("2")).toBe(2)
    expect(parseTrustProxy("0")).toBe(0)
  })

  it("parses true/false literals (case-insensitive)", () => {
    expect(parseTrustProxy("true")).toBe(true)
    expect(parseTrustProxy("TRUE")).toBe(true)
    expect(parseTrustProxy("false")).toBe(false)
    expect(parseTrustProxy("False")).toBe(false)
  })

  it("parses a comma list of CIDRs / IPs, trimming entries", () => {
    expect(parseTrustProxy("10.0.0.0/8, 127.0.0.1 ,192.168.0.0/16")).toEqual([
      "10.0.0.0/8",
      "127.0.0.1",
      "192.168.0.0/16",
    ])
    expect(parseTrustProxy("172.16.0.0/12")).toEqual(["172.16.0.0/12"])
  })

  it("falls back to the safe default for a negative number rather than trusting all", () => {
    expect(parseTrustProxy("-1")).toEqual(["-1"]) // not a bare non-neg int -> treated as a (bogus) list entry, never `true`
    expect(parseTrustProxy("-1")).not.toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fastify request.ip resolution under the default (CIDR) trust config
// ---------------------------------------------------------------------------

describe("Fastify request.ip under TRUST_PROXY default", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it("ignores a spoofed X-Forwarded-For from an UNTRUSTED public peer (uses the real socket peer)", async () => {
    app = Fastify({ trustProxy: parseTrustProxy(undefined) })
    app.get("/ip", (req) => ({ ip: req.ip }))
    await app.ready()

    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "8.8.8.8", // an internet client, NOT in the trusted ranges
      headers: { "x-forwarded-for": "9.9.9.9" }, // forged
    })
    // The spoof is ignored: request.ip is the real peer, so the abuse key is the real client.
    expect(res.json().ip).toBe("8.8.8.8")
    expect(res.json().ip).not.toBe("9.9.9.9")
    expect(normalizeIp(res.json().ip)).toBe("8.8.8.8")
  })

  it("honors the value the TRUSTED proxy (loopback) set, since the proxy strips inbound XFF upstream", async () => {
    app = Fastify({ trustProxy: parseTrustProxy(undefined) })
    app.get("/ip", (req) => ({ ip: req.ip }))
    await app.ready()

    // Caddy (loopback peer) sets a single XFF entry = the real client. We trust it.
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.7" },
    })
    expect(res.json().ip).toBe("203.0.113.7")
  })
})

// ---------------------------------------------------------------------------
// End-to-end: the anon abuse stack receives the REAL client IP, not the spoof
// ---------------------------------------------------------------------------

describe("anon submit abuse key is the real client IP (not a spoofed XFF)", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it("passes the real socket peer (not the forged X-Forwarded-For) to the anon service", async () => {
    const seenIps: (string | null)[] = []
    const captureService: AnonService = {
      submitAnonReport(
        _input: AnonReportRequest,
        ctx: AnonSubmitContext,
      ): Promise<AnonSubmitResult> {
        seenIps.push(ctx.ip)
        return Promise.resolve({
          response: { reportId: "r1", status: "held", claimCode: "c1" },
        })
      },
      anonReportStatus() {
        return Promise.reject(new Error("unused"))
      },
    }

    // Default env -> TRUST_PROXY default (internal CIDRs only).
    app = await buildServer({
      env: loadEnv({ NODE_ENV: "test" }),
      anonOverride: { service: captureService },
    })

    const body = {
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      turnstileToken: "ok",
      category: "trash",
      lat: 34.1,
      lng: -118.35,
      geomSource: "device",
      mediaUploadIds: [],
    }

    const res = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      remoteAddress: "198.51.100.23", // a real internet client
      headers: { "x-forwarded-for": "9.9.9.9" }, // the spoof attempt
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    // The abuse stack saw the REAL peer, not the forged header.
    expect(seenIps).toEqual(["198.51.100.23"])
    expect(seenIps).not.toContain("9.9.9.9")
  })
})
