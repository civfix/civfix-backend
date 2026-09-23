import { describe, it, expect } from "vitest"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { honeypotTripped } from "../../src/abuse/honeypot.js"
import {
  normalizeIp,
  enforceIpRateLimit,
  classifyIpAllowance,
  IP_HARD_LIMIT_PER_HOUR,
} from "../../src/abuse/ip-rate-limit.js"
import {
  abuseH3Cell,
  enforceH3CellCap,
  h3CellCapExempt,
  ABUSE_H3_RES,
  H3_CELL_LIMIT_PER_HOUR,
} from "../../src/abuse/h3-cap.js"
import { parseCfGeo, gpsSanityCheck, cfGeoFromTrustedEdge } from "../../src/abuse/gps-sanity.js"
import {
  signAnonToken,
  verifyAnonTokenSignature,
  issueAnonToken,
  resolveAnonToken,
  resolveOrIssueAnonToken,
  assertUnderReportCap,
  type AnonTokenRecord,
  type AnonTokenStore,
  ANON_TOKEN_REPORT_CAP,
} from "../../src/abuse/anon-token.js"

/**
 * Local, Docker-free unit tests for the API-layer abuse stack. Each control is exercised against an
 * in-memory CounterStore + FakeAbuseChecks + an in-memory token store, with an injectable clock where a
 * window/expiry must be advanced. These are the meaningful tests that prove the abuse logic.
 */

const KEY = "test-anon-signing-key"

// ---------------------------------------------------------------------------
// honeypot (pure)
// ---------------------------------------------------------------------------

describe("honeypotTripped", () => {
  it("trips on real content, not on empty/whitespace/absent", () => {
    expect(honeypotTripped("i-am-a-bot")).toBe(true)
    expect(honeypotTripped("  x  ")).toBe(true)
    expect(honeypotTripped("")).toBe(false)
    expect(honeypotTripped("   ")).toBe(false)
    expect(honeypotTripped(undefined)).toBe(false)
    expect(honeypotTripped(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// IP rate limit
// ---------------------------------------------------------------------------

describe("normalizeIp", () => {
  it("keeps the full IPv4 address as the bucket", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7")
  })

  it("treats an IPv4-mapped IPv6 as the embedded IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  it("reduces an IPv6 address to its /64 prefix", () => {
    // Two addresses sharing a /64 normalize to the SAME bucket; a different /64 does not.
    const a = normalizeIp("2001:db8:abcd:1234:1111:2222:3333:4444")
    const b = normalizeIp("2001:db8:abcd:1234:9999:8888:7777:6666")
    const c = normalizeIp("2001:db8:abcd:5678:1111:2222:3333:4444")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toBe("2001:db8:abcd:1234::/64")
  })

  it("expands a ':: ' compressed IPv6 before taking the /64", () => {
    // 2001:db8::1 -> first four hextets are 2001:db8:0:0
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64")
  })

  it("maps empty/garbage to a stable 'unknown' bucket (still rate-limited)", () => {
    expect(normalizeIp("")).toBe("unknown")
    expect(normalizeIp(undefined)).toBe("unknown")
    expect(normalizeIp(null)).toBe("unknown")
  })
})

describe("enforceIpRateLimit", () => {
  it("allows up to the hard cap, then rejects the (cap+1)-th with RATE_LIMITED", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    const ip = "198.51.100.5"
    // The first IP_HARD_LIMIT_PER_HOUR submissions pass.
    for (let i = 0; i < IP_HARD_LIMIT_PER_HOUR; i++) {
      await expect(enforceIpRateLimit(ip, { counters })).resolves.toMatchObject({
        normalizedIp: ip,
        count: i + 1,
      })
    }
    // The next one is rejected.
    await expect(enforceIpRateLimit(ip, { counters })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("counts the IPv6 /64, so rotating the low 64 bits does not evade the cap", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    const limitFor = (): number => 2 // tighten for a terse test
    const a = "2001:db8:1:2:aaaa::1"
    const b = "2001:db8:1:2:bbbb::2" // same /64
    await enforceIpRateLimit(a, { counters, limitFor })
    await enforceIpRateLimit(b, { counters, limitFor })
    // Third hit on the same /64 (via yet another low-bits value) trips the cap.
    await expect(
      enforceIpRateLimit("2001:db8:1:2:cccc::3", { counters, limitFor }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("rolls over when the hour window expires (TTL anchored to first hit)", async () => {
    let nowMs = 0
    const counters = new InMemoryCounterStore(() => nowMs)
    const ip = "203.0.113.9"
    const limitFor = (): number => 1
    await enforceIpRateLimit(ip, { counters, limitFor })
    await expect(enforceIpRateLimit(ip, { counters, limitFor })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    // Advance past the 1h window: the counter key has expired, so a fresh window starts.
    nowMs += 60 * 60 * 1000 + 1
    await expect(enforceIpRateLimit(ip, { counters, limitFor })).resolves.toMatchObject({
      count: 1,
    })
  })

  it("classifyIpAllowance defaults every IP to the hard cap (no ASN DB shipped)", () => {
    expect(classifyIpAllowance("203.0.113.1")).toBe(IP_HARD_LIMIT_PER_HOUR)
    expect(classifyIpAllowance("2001:db8::/64")).toBe(IP_HARD_LIMIT_PER_HOUR)
  })
})

// ---------------------------------------------------------------------------
// H3 per-cell cap (anon-only)
// ---------------------------------------------------------------------------

describe("abuseH3Cell", () => {
  it("computes a stable cell at the configured resolution", () => {
    const cell = abuseH3Cell(34.1, -118.35)
    expect(typeof cell).toBe("string")
    expect(abuseH3Cell(34.1, -118.35)).toBe(cell)
    expect(ABUSE_H3_RES).toBe(10)
  })
})

describe("h3CellCapExempt", () => {
  it("exempts authenticated callers and applies to anonymous ones", () => {
    expect(h3CellCapExempt({ userId: "u1" })).toBe(true)
    expect(h3CellCapExempt({ userId: null })).toBe(false)
    expect(h3CellCapExempt({ userId: undefined })).toBe(false)
  })
})

describe("enforceH3CellCap", () => {
  it("allows up to the cap per cell, then rejects the (cap+1)-th", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    const limit = 3
    for (let i = 0; i < limit; i++) {
      await expect(enforceH3CellCap(34.1, -118.35, { counters, limit })).resolves.toMatchObject({
        count: i + 1,
      })
    }
    await expect(enforceH3CellCap(34.1, -118.35, { counters, limit })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("counts each cell independently (a far-away point has its own budget)", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    const limit = 1
    await enforceH3CellCap(34.1, -118.35, { counters, limit }) // LA cell
    // A point ~thousands of km away lands in a different cell -> its own fresh budget.
    await expect(enforceH3CellCap(40.71, -74.0, { counters, limit })).resolves.toMatchObject({
      count: 1,
    })
    // But a second LA submission trips the LA cell's cap.
    await expect(enforceH3CellCap(34.1, -118.35, { counters, limit })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("uses the default per-cell cap when none is injected", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    const r = await enforceH3CellCap(34.1, -118.35, { counters })
    expect(r.limit).toBe(H3_CELL_LIMIT_PER_HOUR)
  })
})

// ---------------------------------------------------------------------------
// GPS sanity
// ---------------------------------------------------------------------------

describe("parseCfGeo", () => {
  it("parses CF lat/lng headers into a point", () => {
    expect(parseCfGeo({ "cf-iplatitude": "34.05", "cf-iplongitude": "-118.25" })).toEqual({
      lat: 34.05,
      lng: -118.25,
    })
  })

  it("returns null when only the country (or neither) is present", () => {
    expect(parseCfGeo({ "cf-ipcountry": "US" })).toBeNull()
    expect(parseCfGeo({})).toBeNull()
    expect(parseCfGeo({ "cf-iplatitude": "34.05" })).toBeNull()
  })

  it("rejects out-of-range or non-numeric values", () => {
    expect(parseCfGeo({ "cf-iplatitude": "999", "cf-iplongitude": "0" })).toBeNull()
    expect(parseCfGeo({ "cf-iplatitude": "abc", "cf-iplongitude": "0" })).toBeNull()
  })
})

describe("cfGeoFromTrustedEdge (P1-2)", () => {
  it("is TRUE only when Fastify trusted a forwarding hop (request.ips length > 1)", () => {
    // A trusted proxy forwarded a real client: [proxyPeer, client].
    expect(cfGeoFromTrustedEdge({ ips: ["127.0.0.1", "203.0.113.7"] })).toBe(true)
    expect(cfGeoFromTrustedEdge({ ips: ["10.0.0.5", "8.8.8.8", "1.2.3.4"] })).toBe(true)
  })

  it("is FALSE for an untrusted/direct client (single entry) or no ips", () => {
    // An untrusted public peer's spoofed XFF is not trusted, so ips collapses to the peer alone.
    expect(cfGeoFromTrustedEdge({ ips: ["8.8.8.8"] })).toBe(false)
    expect(cfGeoFromTrustedEdge({ ips: [] })).toBe(false)
    expect(cfGeoFromTrustedEdge({})).toBe(false)
    expect(cfGeoFromTrustedEdge({ ips: undefined })).toBe(false)
  })
})

describe("gpsSanityCheck", () => {
  const abuseChecks = new FakeAbuseChecks()

  it("passes with no IP geo signal (fail-open on missing data) and notes it", async () => {
    const notes: string[] = []
    const res = await gpsSanityCheck(
      { point: { lat: 34.1, lng: -118.35 }, ipGeo: null },
      { abuseChecks, log: (line) => notes.push(line) },
    )
    expect(res).toEqual({ ok: true, reason: "no_signal" })
    expect(notes.some((n) => n.includes("no coarse IP geo"))).toBe(true)
  })

  it("passes a point JUST INSIDE the ~50km threshold of the IP geo", async () => {
    // ~0.4 deg of latitude is ~44.5 km (1 deg lat ~ 111.2 km), comfortably inside 50 km.
    const point = { lat: 34.5, lng: -118.35 }
    const ipGeo = { lat: 34.1, lng: -118.35 }
    const res = await gpsSanityCheck({ point, ipGeo }, { abuseChecks })
    expect(res).toEqual({ ok: true, reason: "plausible" })
  })

  it("fails a point JUST OUTSIDE the ~50km threshold of the IP geo", async () => {
    // ~0.6 deg of latitude is ~66.7 km, outside 50 km.
    const point = { lat: 34.7, lng: -118.35 }
    const ipGeo = { lat: 34.1, lng: -118.35 }
    const res = await gpsSanityCheck({ point, ipGeo }, { abuseChecks })
    expect(res).toEqual({ ok: false, reason: "implausible" })
  })
})

// ---------------------------------------------------------------------------
// anon token
// ---------------------------------------------------------------------------

/** A tiny in-memory AnonTokenStore. */
class MemTokenStore implements AnonTokenStore {
  readonly rows = new Map<string, AnonTokenRecord>()
  insert(row: AnonTokenRecord): Promise<void> {
    this.rows.set(row.id, { ...row })
    return Promise.resolve()
  }
  findById(id: string): Promise<AnonTokenRecord | null> {
    const r = this.rows.get(id)
    return Promise.resolve(r ? { ...r } : null)
  }
}

describe("anon token signing", () => {
  it("round-trips: a signed token verifies back to its id", () => {
    const id = "tok-abc"
    const signed = signAnonToken(id, KEY)
    expect(signed.startsWith(`${id}.`)).toBe(true)
    expect(verifyAnonTokenSignature(signed, KEY)).toBe(id)
  })

  it("rejects a tampered token or a wrong key", () => {
    const signed = signAnonToken("tok-abc", KEY)
    expect(verifyAnonTokenSignature(signed + "x", KEY)).toBeNull()
    expect(verifyAnonTokenSignature(signed, "other-key")).toBeNull()
    expect(verifyAnonTokenSignature("no-separator", KEY)).toBeNull()
    expect(verifyAnonTokenSignature("id.", KEY)).toBeNull()
  })
})

describe("issueAnonToken / resolveAnonToken", () => {
  it("issues a 24h row at report_count 0 and resolves it back", async () => {
    const store = new MemTokenStore()
    const issued = await issueAnonToken({
      store,
      signingKey: KEY,
      newId: () => "tok-1",
      now: () => new Date("2026-01-01T00:00:00Z"),
    })
    expect(issued.record.id).toBe("tok-1")
    expect(issued.record.reportCount).toBe(0)
    expect(issued.record.expiresAt.toISOString()).toBe("2026-01-02T00:00:00.000Z")

    // Resolve at a time within the token's lifetime (the same injected clock origin).
    const resolved = await resolveAnonToken(issued.token, {
      store,
      signingKey: KEY,
      now: () => new Date("2026-01-01T01:00:00Z"),
    })
    expect(resolved?.id).toBe("tok-1")
  })

  it("does not resolve an expired token", async () => {
    const store = new MemTokenStore()
    const issued = await issueAnonToken({
      store,
      signingKey: KEY,
      newId: () => "tok-exp",
      now: () => new Date("2026-01-01T00:00:00Z"),
    })
    // 24h + 1ms later -> expired.
    const resolved = await resolveAnonToken(issued.token, {
      store,
      signingKey: KEY,
      now: () => new Date("2026-01-02T00:00:00.001Z"),
    })
    expect(resolved).toBeNull()
  })

  it("does not resolve an unknown or unsigned token", async () => {
    const store = new MemTokenStore()
    expect(await resolveAnonToken(undefined, { store, signingKey: KEY })).toBeNull()
    expect(
      await resolveAnonToken(signAnonToken("ghost", KEY), { store, signingKey: KEY }),
    ).toBeNull()
  })
})

describe("per-token report cap", () => {
  it("assertUnderReportCap throws once the count reaches the cap", () => {
    const base: AnonTokenRecord = {
      id: "t",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      reportCount: ANON_TOKEN_REPORT_CAP - 1,
      flagged: false,
      claimCode: null,
    }
    // One under the cap is fine (returns remaining 1).
    expect(assertUnderReportCap(base)).toEqual({ remaining: 1 })
    // At the cap -> throws.
    expect(() => assertUnderReportCap({ ...base, reportCount: ANON_TOKEN_REPORT_CAP })).toThrow()
  })

  it("resolveOrIssue issues a fresh token when none presented, then caps the Nth+1 reuse", async () => {
    const store = new MemTokenStore()
    let n = 0
    const deps = { store, signingKey: KEY, newId: () => `tok-${++n}` }

    // No token presented -> a fresh one is issued (and handed back).
    const first = await resolveOrIssueAnonToken(undefined, deps)
    expect(first.issuedToken).toBeTruthy()
    expect(first.record.id).toBe("tok-1")

    // Simulate the create tx bumping report_count up to the cap, reusing the SAME token each time.
    const token = signAnonToken("tok-1", KEY)
    for (let i = 1; i <= ANON_TOKEN_REPORT_CAP; i++) {
      store.rows.get("tok-1")!.reportCount = i - 1
      const r = await resolveOrIssueAnonToken(token, deps)
      expect(r.record.id).toBe("tok-1")
      expect(r.issuedToken).toBeUndefined() // existing token reused -> not re-issued
    }
    // Now at the cap: the next reuse is rejected.
    store.rows.get("tok-1")!.reportCount = ANON_TOKEN_REPORT_CAP
    await expect(resolveOrIssueAnonToken(token, deps)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })
})
