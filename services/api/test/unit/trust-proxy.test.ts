import { describe, it, expect, afterEach } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { parseTrustProxy, DEFAULT_TRUSTED_PROXY_CIDRS } from "../../src/plugins/trust-proxy.js"
import { loadEnv } from "../../src/env.js"
import { buildServer } from "../../src/server.js"
import { normalizeIp } from "../../src/abuse/ip-rate-limit.js"
import type { AnonReportRequest } from "@civfix/shared"
import type {
  AnonService,
  AnonSubmitContext,
  AnonSubmitResult,
} from "../../src/services/anon-service.js"

describe("parseTrustProxy", () => {
  it("defaults to the internal loopback+private CIDR set (NOT trust-all) when unset or blank", () => {
    expect(parseTrustProxy(undefined)).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy("")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy("   ")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy(undefined)).not.toBe(true)
  })

  it("falls back to the safe default for a bare integer (hop counts are not supported)", () => {
    expect(parseTrustProxy("0")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy("1")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parseTrustProxy("2")).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
  })

  it("never resolves a numeric TRUST_PROXY to a boolean", () => {
    for (const raw of ["0", "1", "2", "10", "0007"]) {
      const parsed = parseTrustProxy(raw)
      expect(parsed).not.toBe(true)
      expect(parsed).not.toBe(false)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    }
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
    expect(parseTrustProxy("-1")).toEqual(["-1"])
    expect(parseTrustProxy("-1")).not.toBe(true)
  })
})

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
      remoteAddress: "8.8.8.8",
      headers: { "x-forwarded-for": "9.9.9.9" },
    })
    expect(res.json().ip).toBe("8.8.8.8")
    expect(res.json().ip).not.toBe("9.9.9.9")
    expect(normalizeIp(res.json().ip)).toBe("8.8.8.8")
  })

  it("honors the value the TRUSTED proxy (loopback) set, since the proxy strips inbound XFF upstream", async () => {
    app = Fastify({ trustProxy: parseTrustProxy(undefined) })
    app.get("/ip", (req) => ({ ip: req.ip }))
    await app.ready()

    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.7" },
    })
    expect(res.json().ip).toBe("203.0.113.7")
  })
})

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

    app = await buildServer({
      env: loadEnv({ NODE_ENV: "test" }),
      anonOverride: { service: captureService },
    })

    const body = {
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      turnstileToken: "ok",
      category: "trash",
      type: "dump",
      lat: 34.1,
      lng: -118.35,
      geomSource: "device",
      mediaUploadIds: [],
    }

    const res = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      remoteAddress: "198.51.100.23",
      headers: { "x-forwarded-for": "9.9.9.9" },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    expect(seenIps).toEqual(["198.51.100.23"])
    expect(seenIps).not.toContain("9.9.9.9")
  })
})
