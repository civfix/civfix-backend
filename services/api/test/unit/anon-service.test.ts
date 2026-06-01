import { describe, it, expect } from "vitest"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import type { AnonReportRequest } from "@civfix/shared"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { abuseH3Cell } from "../../src/abuse/h3-cap.js"
import { ANON_TOKEN_REPORT_CAP, signAnonToken } from "../../src/abuse/anon-token.js"
import {
  makeAnonService,
  type AnonService,
  type AnonServiceDeps,
} from "../../src/services/anon-service.js"
import { InMemoryAnonStore } from "../helpers/anon.js"

/**
 * Offline unit tests for the anonymous-report service: the abuse-stack ORDER, the held create in one
 * transaction, idempotency replay, and the claim-code-gated status. All run against the in-memory anon
 * store + FakeAbuseChecks + an in-memory CounterStore - no DB, no Docker. The Drizzle transaction path
 * is covered by the Docker-gated integration suite.
 */

const SIGNING_KEY = "test-anon-signing-key"
const KEY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const KEY_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

interface Harness {
  store: InMemoryAnonStore
  abuse: FakeAbuseChecks
  counters: InMemoryCounterStore
  service: AnonService
  flags: { subjectType: string; subjectId: string; reason: string }[]
}

function makeHarness(over: Partial<AnonServiceDeps> = {}): Harness {
  const store = new InMemoryAnonStore()
  const abuse = new FakeAbuseChecks()
  const counters = new InMemoryCounterStore(() => 0)
  const flags: Harness["flags"] = []
  // Independent per-factory counters so ids are deterministic regardless of call order (the token id is
  // minted before the report id within a single submit). The first submit yields report-1/claim-1 and,
  // when it issues a fresh token, anontok-1.
  let reportN = 0
  let claimN = 0
  let tokenN = 0
  const service = makeAnonService({
    repo: store.anonReportRepo(),
    abuseChecks: abuse,
    counters,
    anonTokenSigningKey: SIGNING_KEY,
    resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
    raiseAbuseFlag: (subjectType, subjectId, reason) => {
      flags.push({ subjectType, subjectId, reason })
      return Promise.resolve()
    },
    newId: () => `report-${++reportN}`,
    newClaimCode: () => `claim-${++claimN}`,
    newAnonTokenId: () => `anontok-${++tokenN}`,
    ...over,
  })
  return { store, abuse, counters, service, flags }
}

function req(over: Partial<AnonReportRequest> = {}): AnonReportRequest {
  return {
    idempotencyKey: over.idempotencyKey ?? KEY_A,
    turnstileToken: over.turnstileToken ?? "ok-token",
    category: over.category ?? "trash",
    lat: over.lat ?? 34.1,
    lng: over.lng ?? -118.35,
    geomSource: over.geomSource ?? "device",
    mediaUploadIds: over.mediaUploadIds ?? [],
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.honeypot !== undefined ? { honeypot: over.honeypot } : {}),
    ...(over.anonToken !== undefined ? { anonToken: over.anonToken } : {}),
  }
}

const ctx = { ip: "203.0.113.10", cfGeo: {} as Record<string, string | string[] | undefined> }

// ---------------------------------------------------------------------------
// Happy path: held create
// ---------------------------------------------------------------------------

describe("submitAnonReport: held create", () => {
  it("creates a HELD report, issues an anon token, stamps a claim code, bumps report_count", async () => {
    const { store, service } = makeHarness()
    const result = await service.submitAnonReport(req(), ctx)

    expect(result.response.status).toBe("held")
    expect(result.response.reportId).toBe("report-1")
    expect(result.response.claimCode).toBe("claim-1")
    // A fresh anon token was issued (no token was presented) and handed back.
    expect(result.issuedAnonToken).toBe(signAnonToken("anontok-1", SIGNING_KEY))

    // The report row is held + public, published_at null, reporter null, anon_session_id = token id.
    const stored = store.reports.get("report-1")!
    expect(stored.status).toBe("held")
    expect(stored.visibility).toBe("public")
    expect(stored.publishedAt).toBeNull()
    expect(stored.reporterUserId).toBeNull()
    expect(stored.anonSessionId).toBe("anontok-1")
    expect(stored.jurisdictionGeoid).toBe("0644000")

    // The token got report_count = 1 (the cap is a token property). The claim code is stored PER REPORT
    // now (0005), so it is on the report row, NOT the token row.
    const token = store.tokens.get("anontok-1")!
    expect(token.reportCount).toBe(1)
    expect(token.claimCode).toBeNull()
    expect(store.reports.get("report-1")!.claimCode).toBe("claim-1")

    // Timeline: submitted + held.
    const tl = store.timeline.filter((t) => t.reportId === "report-1")
    expect(tl.map((t) => t.status)).toEqual(["submitted", "held"])

    // The snapshot was stored under the idempotency key.
    expect(store.idempotency.size).toBe(1)
  })

  it("reuses a presented valid token (no re-issue) and bumps its count", async () => {
    const { store, service } = makeHarness()
    // Seed a valid token and present it.
    const token = store.seedToken({ id: "anontok-1", reportCount: 0 })
    const signed = signAnonToken(token.id, SIGNING_KEY)

    const result = await service.submitAnonReport(req({ anonToken: signed }), ctx)
    expect(result.issuedAnonToken).toBeUndefined() // existing token reused
    expect(store.tokens.get("anontok-1")!.reportCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Abuse stack ordering + individual controls
// ---------------------------------------------------------------------------

describe("submitAnonReport: Turnstile", () => {
  it("rejects a failed Turnstile FIRST with TURNSTILE_FAILED and creates nothing", async () => {
    const { store, service } = makeHarness()
    await expect(
      service.submitAnonReport(req({ turnstileToken: "fail" }), ctx),
    ).rejects.toMatchObject({ code: "TURNSTILE_FAILED" })
    expect(store.reports.size).toBe(0)
    expect(store.tokens.size).toBe(0) // no token issued before Turnstile clears
  })
})

describe("submitAnonReport: honeypot", () => {
  it("rejects a non-empty honeypot with VALIDATION, creates nothing, and flags the token", async () => {
    const { store, service, flags } = makeHarness()
    const token = store.seedToken({ id: "anontok-1" })
    const signed = signAnonToken(token.id, SIGNING_KEY)
    await expect(
      service.submitAnonReport(req({ honeypot: "gotcha", anonToken: signed }), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(store.reports.size).toBe(0)
    // A best-effort abuse_flag was raised against the presented token.
    expect(flags).toEqual([{ subjectType: "anon_token", subjectId: "anontok-1", reason: "honeypot" }])
  })

  it("a whitespace-only honeypot is treated as empty (legitimate)", async () => {
    const { store, service } = makeHarness()
    await service.submitAnonReport(req({ honeypot: "   " }), ctx)
    expect(store.reports.size).toBe(1)
  })
})

describe("submitAnonReport: per-token cap", () => {
  it("rejects once the presented token has reached the cap (RATE_LIMITED)", async () => {
    const { store, service } = makeHarness()
    const token = store.seedToken({ id: "anontok-1", reportCount: ANON_TOKEN_REPORT_CAP })
    const signed = signAnonToken(token.id, SIGNING_KEY)
    await expect(
      service.submitAnonReport(req({ anonToken: signed }), ctx),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(store.reports.size).toBe(0)
  })
})

describe("submitAnonReport: per-IP cap", () => {
  it("rejects after the hard hourly IP cap is exceeded across distinct tokens", async () => {
    // Tighten via a shared CounterStore but rely on the real IP limit (10/hr). Use distinct idempotency
    // keys + fresh tokens each time so only the IP cap can trip.
    const { service, store } = makeHarness()
    for (let i = 0; i < 10; i++) {
      await service.submitAnonReport(req({ idempotencyKey: uuid(i) }), ctx)
    }
    expect(store.reports.size).toBe(10)
    await expect(
      service.submitAnonReport(req({ idempotencyKey: uuid(99) }), ctx),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })
})

describe("submitAnonReport: per-H3-cell cap", () => {
  it("rejects once the cell's hourly cap is exceeded (same point, fresh tokens + keys)", async () => {
    // Make the IP cap effectively unlimited by spreading IPs, so only the H3 cell cap can trip. The
    // H3 default cap is 30; push past it.
    const { service } = makeHarness()
    let i = 0
    const submit = (): Promise<unknown> =>
      service.submitAnonReport(req({ idempotencyKey: uuid(i) }), {
        ip: `10.0.${Math.floor(i / 250)}.${i % 250}`,
        cfGeo: {},
      })
    for (i = 0; i < 30; i++) {
      await submit()
    }
    i = 30
    await expect(submit()).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })
})

describe("submitAnonReport: GPS sanity", () => {
  it("rejects a point implausibly far from the coarse IP geo (GPS_IMPLAUSIBLE), TRUSTED edge", async () => {
    const { store, service } = makeHarness()
    // CF geo near LA; point far north (> 50 km). Headers are trusted (came through the edge).
    const cfGeo = { "cf-iplatitude": "34.1", "cf-iplongitude": "-118.35" }
    await expect(
      service.submitAnonReport(req({ lat: 35.0, lng: -118.35 }), {
        ip: "203.0.113.10",
        cfGeo,
        cfGeoTrusted: true,
      }),
    ).rejects.toMatchObject({ code: "GPS_IMPLAUSIBLE" })
    expect(store.reports.size).toBe(0)
  })

  it("passes when the point is near the coarse IP geo (TRUSTED edge)", async () => {
    const { store, service } = makeHarness()
    const cfGeo = { "cf-iplatitude": "34.1", "cf-iplongitude": "-118.35" }
    await service.submitAnonReport(req({ lat: 34.2, lng: -118.35 }), {
      ip: "203.0.113.10",
      cfGeo,
      cfGeoTrusted: true,
    })
    expect(store.reports.size).toBe(1)
  })

  it("passes when no coarse IP geo is available (fail-open)", async () => {
    const { store, service } = makeHarness()
    await service.submitAnonReport(req(), { ip: "203.0.113.10", cfGeo: {} })
    expect(store.reports.size).toBe(1)
  })

  it("P1-2: IGNORES spoofed CF geo headers from an UNTRUSTED source (does NOT reject)", async () => {
    const { store, service } = makeHarness()
    // An attacker submits a point far from where the (forged) CF headers claim, but the request did NOT
    // come through the trusted edge, so the headers are ignored and the check fails open: the report is
    // created (held) rather than blocked. The point being: the spoofed headers cannot be used to PASS a
    // bogus location check either - they simply are not trusted as a signal at all.
    const cfGeo = { "cf-iplatitude": "34.1", "cf-iplongitude": "-118.35" }
    await service.submitAnonReport(req({ lat: 35.0, lng: -118.35 }), {
      ip: "203.0.113.10",
      cfGeo,
      cfGeoTrusted: false, // untrusted source (the default)
    })
    // No GPS_IMPLAUSIBLE rejection happened (headers ignored) -> the report exists.
    expect(store.reports.size).toBe(1)
  })

  it("P1-2: an implausible point that WOULD reject if trusted is ignored when the source is untrusted", async () => {
    const { store, service } = makeHarness()
    const cfGeo = { "cf-iplatitude": "10.0", "cf-iplongitude": "10.0" } // far from the submitted point
    // Untrusted: ignored -> passes. (Same input WITH cfGeoTrusted:true would be GPS_IMPLAUSIBLE.)
    await service.submitAnonReport(req({ lat: 34.2, lng: -118.35 }), {
      ip: "203.0.113.10",
      cfGeo,
      cfGeoTrusted: false,
    })
    expect(store.reports.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Idempotency replay
// ---------------------------------------------------------------------------

describe("submitAnonReport: idempotency replay", () => {
  it("returns the ORIGINAL AnonReportResponse for a duplicate key, with NO second report", async () => {
    const { store, service } = makeHarness()
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A }), ctx)
    expect(store.reports.size).toBe(1)
    const countAfterFirst = store.tokens.get("anontok-1")!.reportCount

    // Same key again (even with a different category) -> same response, no new row, no extra quota.
    const second = await service.submitAnonReport(
      req({ idempotencyKey: KEY_A, category: "hazard", anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
      ctx,
    )
    expect(second.response).toEqual(first.response)
    expect(second.issuedAnonToken).toBeUndefined()
    expect(store.reports.size).toBe(1)
    // The replay did NOT bump report_count again (it short-circuited before the create tx).
    expect(store.tokens.get("anontok-1")!.reportCount).toBe(countAfterFirst)
  })

  it("a different key creates a second distinct report", async () => {
    const { store, service } = makeHarness()
    await service.submitAnonReport(req({ idempotencyKey: KEY_A }), ctx)
    await service.submitAnonReport(
      req({ idempotencyKey: KEY_B, anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
      ctx,
    )
    expect(store.reports.size).toBe(2)
  })

  it("bugs P1-1: an idempotent replay does NOT burn per-IP or per-H3-cell budget", async () => {
    const { store, service, counters } = makeHarness()
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A, lat: 34.1, lng: -118.35 }), ctx)
    expect(store.reports.size).toBe(1)

    // Snapshot the counters AFTER the genuine first submit (it consumed exactly one IP + one cell slot).
    const ipKey = "abuse:ip:203.0.113.10"
    const h3Key = `abuse:h3:${abuseH3Cell(34.1, -118.35)}`
    const ipAfterFirst = counters.peek(ipKey)
    const h3AfterFirst = counters.peek(h3Key)
    expect(ipAfterFirst).toBe(1)
    expect(h3AfterFirst).toBe(1)

    // Replay the SAME key several times. Each must short-circuit on the idempotency snapshot BEFORE the
    // counter increments, so the budgets do not move (the replay is free, per the documented contract).
    for (let i = 0; i < 4; i++) {
      const replay = await service.submitAnonReport(
        req({ idempotencyKey: KEY_A, lat: 34.1, lng: -118.35, anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
        ctx,
      )
      expect(replay.response).toEqual(first.response)
    }
    expect(counters.peek(ipKey)).toBe(ipAfterFirst) // unchanged
    expect(counters.peek(h3Key)).toBe(h3AfterFirst) // unchanged
    expect(store.reports.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Concurrency: per-token cap is atomic (bugs P0-1)
// ---------------------------------------------------------------------------

describe("submitAnonReport: per-token cap is atomic under concurrency (bugs P0-1)", () => {
  it("fires N concurrent submits on a token with ONE slot left; at most one is created", async () => {
    const { store, service } = makeHarness()
    // Token at cap-1 (one report allowed). Distinct IPs per request so the per-IP cap never trips and
    // only the per-token cap can bound the outcome.
    const signed = signAnonToken(
      store.seedToken({ id: "anontok-1", reportCount: ANON_TOKEN_REPORT_CAP - 1 }).id,
      SIGNING_KEY,
    )
    const N = 6
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_unused, i) =>
        service.submitAnonReport(
          req({ idempotencyKey: uuid(i), anonToken: signed }),
          { ip: `10.1.0.${i}`, cfGeo: {} },
        ),
      ),
    )

    const created = results.filter((r) => r.status === "fulfilled").length
    const rejected = results.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "RATE_LIMITED",
    ).length

    // Exactly the one remaining slot is consumed; every other concurrent submit is rate-limited.
    expect(created).toBe(1)
    expect(rejected).toBe(N - 1)
    expect(store.reports.size).toBe(1)
    // The token never overshoots the cap.
    expect(store.tokens.get("anontok-1")!.reportCount).toBe(ANON_TOKEN_REPORT_CAP)
  })

  it("the atomic cap is enforced in the create tx, not just the pre-check (cap reached -> rollback)", async () => {
    const { store, service } = makeHarness()
    // Token already AT the cap: the tx-level UPDATE ... WHERE report_count < cap matches 0 rows.
    const signed = signAnonToken(
      store.seedToken({ id: "anontok-1", reportCount: ANON_TOKEN_REPORT_CAP }).id,
      SIGNING_KEY,
    )
    await expect(
      service.submitAnonReport(req({ idempotencyKey: uuid(1), anonToken: signed }), ctx),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(store.reports.size).toBe(0)
    expect(store.tokens.get("anontok-1")!.reportCount).toBe(ANON_TOKEN_REPORT_CAP)
  })
})

// ---------------------------------------------------------------------------
// Status (claim-code-gated)
// ---------------------------------------------------------------------------

describe("anonReportStatus", () => {
  it("returns the status for the matching claim code", async () => {
    const { service } = makeHarness()
    const created = await service.submitAnonReport(req(), ctx)
    const status = await service.anonReportStatus(created.response.reportId, created.response.claimCode)
    expect(status.status).toBe("held")
    expect(status.publishedAt).toBeUndefined() // not yet published
  })

  it("404s a WRONG claim code (no enumeration)", async () => {
    const { service } = makeHarness()
    const created = await service.submitAnonReport(req(), ctx)
    await expect(
      service.anonReportStatus(created.response.reportId, "wrong-code"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s an unknown report id", async () => {
    const { service } = makeHarness()
    await expect(service.anonReportStatus("ghost", "x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("reflects publishedAt once the report is published", async () => {
    const { store, service } = makeHarness()
    const created = await service.submitAnonReport(req(), ctx)
    // Simulate a release.
    const r = store.reports.get(created.response.reportId)!
    r.status = "published"
    r.publishedAt = new Date("2026-02-01T00:00:00Z")
    const status = await service.anonReportStatus(created.response.reportId, created.response.claimCode)
    expect(status.status).toBe("published")
    expect(status.publishedAt).toBe("2026-02-01T00:00:00.000Z")
  })

  it("P2-5: two reports under ONE token are each status-queryable by their OWN claim code", async () => {
    const { service } = makeHarness()
    // First submit (issues anontok-1, report-1/claim-1). Second submit on the SAME token presents it.
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A }), ctx)
    const second = await service.submitAnonReport(
      req({ idempotencyKey: KEY_B, anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
      ctx,
    )
    expect(first.response.reportId).toBe("report-1")
    expect(first.response.claimCode).toBe("claim-1")
    expect(second.response.reportId).toBe("report-2")
    expect(second.response.claimCode).toBe("claim-2")

    // The FIRST report's status is still queryable with the FIRST report's code (the bug was that the
    // second submit overwrote the shared token code, 404ing the first). Both resolve independently.
    const s1 = await service.anonReportStatus("report-1", "claim-1")
    expect(s1.status).toBe("held")
    const s2 = await service.anonReportStatus("report-2", "claim-2")
    expect(s2.status).toBe("held")

    // A report cannot be queried with the OTHER report's code.
    await expect(service.anonReportStatus("report-1", "claim-2")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.anonReportStatus("report-2", "claim-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

/** Build a valid-looking UUID for distinct idempotency keys in the rate-limit loops. */
function uuid(n: number): string {
  const h = n.toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${h}`
}
