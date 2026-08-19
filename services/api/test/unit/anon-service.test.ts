import { describe, it, expect } from "vitest"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import type { AnonReportRequest } from "@civfix/shared"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { abuseH3Cell } from "../../src/abuse/h3-cap.js"
import { ANON_TOKEN_REPORT_CAP, signAnonToken } from "../../src/abuse/anon-token.js"
import {
  makeAnonService,
  ANON_TURNSTILE_ACTION,
  ANON_MAX_MEDIA_UPLOADS,
  type AnonService,
  type AnonServiceDeps,
} from "../../src/services/anon-service.js"
import { InMemoryAnonStore } from "../helpers/anon.js"
import { sha256Hex } from "../../src/auth/crypto.js"


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
    type: over.type ?? "dump",
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


describe("submitAnonReport: held create", () => {
  it("creates a HELD report, issues an anon token, stamps a claim code, bumps report_count", async () => {
    const { store, service } = makeHarness()
    const result = await service.submitAnonReport(req(), ctx)

    expect(result.response.status).toBe("held")
    expect(result.response.reportId).toBe("report-1")
    expect(result.response.claimCode).toBe("claim-1")
    expect(result.issuedAnonToken).toBe(signAnonToken("anontok-1", SIGNING_KEY))

    const stored = store.reports.get("report-1")!
    expect(stored.status).toBe("held")
    expect(stored.visibility).toBe("public")
    expect(stored.publishedAt).toBeNull()
    expect(stored.reporterUserId).toBeNull()
    expect(stored.anonSessionId).toBe("anontok-1")
    expect(stored.jurisdictionGeoid).toBe("0644000")

    const token = store.tokens.get("anontok-1")!
    expect(token.reportCount).toBe(1)
    expect(token.claimCode).toBeNull()
    // F150: only the DIGEST of the per-report code is persisted; the plaintext lives solely in the
    // one-time response above.
    expect(store.reports.get("report-1")!.claimCodeHash).toBe(await sha256Hex("claim-1"))

    const tl = store.timeline.filter((t) => t.reportId === "report-1")
    expect(tl.map((t) => t.status)).toEqual(["submitted", "held"])

    expect(store.idempotency.size).toBe(1)
  })

  it("reuses a presented valid token (no re-issue) and bumps its count", async () => {
    const { store, service } = makeHarness()
    const token = store.seedToken({ id: "anontok-1", reportCount: 0 })
    const signed = signAnonToken(token.id, SIGNING_KEY)

    const result = await service.submitAnonReport(req({ anonToken: signed }), ctx)
    expect(result.issuedAnonToken).toBeUndefined()
    expect(store.tokens.get("anontok-1")!.reportCount).toBe(1)
  })
})


describe("submitAnonReport: Turnstile", () => {
  it("rejects a failed Turnstile FIRST with TURNSTILE_FAILED and creates nothing", async () => {
    const { store, service } = makeHarness()
    await expect(
      service.submitAnonReport(req({ turnstileToken: "fail" }), ctx),
    ).rejects.toMatchObject({ code: "TURNSTILE_FAILED" })
    expect(store.reports.size).toBe(0)
    expect(store.tokens.size).toBe(0)
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
    expect(flags).toEqual([{ subjectType: "anon_token", subjectId: "anontok-1", reason: "honeypot" }])
  })

  it("a whitespace-only honeypot is treated as empty (legitimate)", async () => {
    const { store, service } = makeHarness()
    await service.submitAnonReport(req({ honeypot: "   " }), ctx)
    expect(store.reports.size).toBe(1)
  })

  it("F134: the rejection body does NOT name the honeypot field (trap stays undetectable)", async () => {
    const { service } = makeHarness()
    try {
      await service.submitAnonReport(req({ honeypot: "gotcha" }), ctx)
      throw new Error("expected to throw")
    } catch (err) {
      expect((err as { code?: string }).code).toBe("VALIDATION")
      const fields = (err as { fields?: Record<string, string> }).fields ?? {}
      expect(fields).not.toHaveProperty("honeypot")
    }
  })
})

describe("submitAnonReport: slur filter (F130)", () => {
  it("rejects a slur in the title with VALIDATION and creates nothing", async () => {
    const { store, service } = makeHarness()
    await expect(
      service.submitAnonReport({ ...req(), title: "you faggot" }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(store.reports.size).toBe(0)
  })

  it("rejects a slur in the description and spends NO quota", async () => {
    const { store, service, counters } = makeHarness()
    await expect(
      service.submitAnonReport(req({ description: "go back tranny" }), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(store.reports.size).toBe(0)
    expect(counters.peek("abuse:ip:203.0.113.10")).toBe(0)
  })
})

describe("submitAnonReport: derived category (F060)", () => {
  it("stores the category DERIVED from type, ignoring a mismatched client category", async () => {
    const { store, service } = makeHarness()
    await service.submitAnonReport(req({ type: "pavement", category: "trash" }), ctx)
    expect(store.reports.get("report-1")!.category).toBe("hazard")
  })
})

describe("submitAnonReport: media cap (F161)", () => {
  it("rejects more than the allowed media uploads with VALIDATION, creating nothing", async () => {
    const { store, service } = makeHarness()
    const tooMany = Array.from({ length: ANON_MAX_MEDIA_UPLOADS + 1 }, (_u, i) => uuid(i))
    await expect(
      service.submitAnonReport(req({ mediaUploadIds: tooMany }), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(store.reports.size).toBe(0)
  })
})

describe("submitAnonReport: Turnstile action binding (F128)", () => {
  it("passes the anon-report action expectation to verifyTurnstile", async () => {
    const { service, abuse } = makeHarness()
    await service.submitAnonReport(req(), ctx)
    expect(abuse.lastVerifyExpect).toEqual({ action: ANON_TURNSTILE_ACTION })
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
    const cfGeo = { "cf-iplatitude": "34.1", "cf-iplongitude": "-118.35" }
    await service.submitAnonReport(req({ lat: 35.0, lng: -118.35 }), {
      ip: "203.0.113.10",
      cfGeo,
      cfGeoTrusted: false,
    })
    expect(store.reports.size).toBe(1)
  })

  it("P1-2: an implausible point that WOULD reject if trusted is ignored when the source is untrusted", async () => {
    const { store, service } = makeHarness()
    const cfGeo = { "cf-iplatitude": "10.0", "cf-iplongitude": "10.0" }
    await service.submitAnonReport(req({ lat: 34.2, lng: -118.35 }), {
      ip: "203.0.113.10",
      cfGeo,
      cfGeoTrusted: false,
    })
    expect(store.reports.size).toBe(1)
  })
})


describe("submitAnonReport: idempotency replay", () => {
  it("returns the ORIGINAL AnonReportResponse for a duplicate key, with NO second report", async () => {
    const { store, service } = makeHarness()
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A }), ctx)
    expect(store.reports.size).toBe(1)
    const countAfterFirst = store.tokens.get("anontok-1")!.reportCount

    const second = await service.submitAnonReport(
      req({ idempotencyKey: KEY_A, category: "hazard", anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
      ctx,
    )
    expect(second.response).toEqual(first.response)
    expect(second.issuedAnonToken).toBeUndefined()
    expect(store.reports.size).toBe(1)
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

    const ipKey = "abuse:ip:203.0.113.10"
    const h3Key = `abuse:h3:${abuseH3Cell(34.1, -118.35)}`
    const ipAfterFirst = counters.peek(ipKey)
    const h3AfterFirst = counters.peek(h3Key)
    expect(ipAfterFirst).toBe(1)
    expect(h3AfterFirst).toBe(1)

    for (let i = 0; i < 4; i++) {
      const replay = await service.submitAnonReport(
        req({ idempotencyKey: KEY_A, lat: 34.1, lng: -118.35, anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
        ctx,
      )
      expect(replay.response).toEqual(first.response)
    }
    expect(counters.peek(ipKey)).toBe(ipAfterFirst)
    expect(counters.peek(h3Key)).toBe(h3AfterFirst)
    expect(store.reports.size).toBe(1)
  })
})


describe("submitAnonReport: per-token cap is atomic under concurrency (bugs P0-1)", () => {
  it("fires N concurrent submits on a token with ONE slot left; at most one is created", async () => {
    const { store, service } = makeHarness()
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

    expect(created).toBe(1)
    expect(rejected).toBe(N - 1)
    expect(store.reports.size).toBe(1)
    expect(store.tokens.get("anontok-1")!.reportCount).toBe(ANON_TOKEN_REPORT_CAP)
  })

  it("the atomic cap is enforced in the create tx, not just the pre-check (cap reached -> rollback)", async () => {
    const { store, service } = makeHarness()
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


describe("anonReportStatus", () => {
  it("returns the status for the matching claim code", async () => {
    const { service } = makeHarness()
    const created = await service.submitAnonReport(req(), ctx)
    const status = await service.anonReportStatus(created.response.reportId, created.response.claimCode)
    expect(status.status).toBe("held")
    expect(status.publishedAt).toBeUndefined()
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
    const r = store.reports.get(created.response.reportId)!
    r.status = "published"
    r.publishedAt = new Date("2026-02-01T00:00:00Z")
    const status = await service.anonReportStatus(created.response.reportId, created.response.claimCode)
    expect(status.status).toBe("published")
    expect(status.publishedAt).toBe("2026-02-01T00:00:00.000Z")
  })

  it("P2-5: two reports under ONE token are each status-queryable by their OWN claim code", async () => {
    const { service } = makeHarness()
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A }), ctx)
    const second = await service.submitAnonReport(
      req({ idempotencyKey: KEY_B, anonToken: signAnonToken("anontok-1", SIGNING_KEY) }),
      ctx,
    )
    expect(first.response.reportId).toBe("report-1")
    expect(first.response.claimCode).toBe("claim-1")
    expect(second.response.reportId).toBe("report-2")
    expect(second.response.claimCode).toBe("claim-2")

    const s1 = await service.anonReportStatus("report-1", "claim-1")
    expect(s1.status).toBe("held")
    const s2 = await service.anonReportStatus("report-2", "claim-2")
    expect(s2.status).toBe("held")

    await expect(service.anonReportStatus("report-1", "claim-2")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.anonReportStatus("report-2", "claim-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("claim codes are persisted as a digest only (F150)", () => {
  it("stores sha256(code) - never the plaintext - and the digest matches the returned code", async () => {
    const { store, service } = makeHarness()
    const created = await service.submitAnonReport(req(), ctx)
    const stored = store.reports.get(created.response.reportId)!

    expect(stored.claimCodeHash).toBe(await sha256Hex(created.response.claimCode))
    expect(stored.claimCodeHash).not.toBe(created.response.claimCode)
    expect(JSON.stringify(stored)).not.toContain(created.response.claimCode)
  })

  it("resolves a row that carries ONLY a backfilled digest (a pre-0091 plaintext-era report)", async () => {
    const { store, service } = makeHarness()
    // Exactly what 0091's backfill leaves behind: claim_code_hash = sha256(the old plaintext code).
    store.seedReport({
      id: "legacy-1",
      anonSessionId: "anontok-legacy",
      status: "held",
      claimCodeHash: await sha256Hex("legacy-code"),
    })

    const status = await service.anonReportStatus("legacy-1", "legacy-code")
    expect(status.status).toBe("held")
    await expect(service.anonReportStatus("legacy-1", "legacy-cod3")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s a report whose code was already consumed (digest cleared)", async () => {
    const { store, service } = makeHarness()
    const created = await service.submitAnonReport(req(), ctx)
    store.reports.get(created.response.reportId)!.claimCodeHash = null
    await expect(
      service.anonReportStatus(created.response.reportId, created.response.claimCode),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})


describe("submitAnonReport: idempotency is scoped to the anon session (F028)", () => {
  it("does NOT replay one session's snapshot (or its claim code) to a DIFFERENT session", async () => {
    const { store, service } = makeHarness()
    const squatter = signAnonToken(store.seedToken({ id: "anontok-squatter" }).id, SIGNING_KEY)
    const victim = signAnonToken(store.seedToken({ id: "anontok-victim" }).id, SIGNING_KEY)

    const first = await service.submitAnonReport(
      req({ idempotencyKey: KEY_A, anonToken: squatter }),
      ctx,
    )

    // The squatter owns the key, so the victim gets the retryable conflict the authenticated lane
    // answers - NOT the squatter's reportId + claim code.
    await expect(
      service.submitAnonReport(req({ idempotencyKey: KEY_A, anonToken: victim }), ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    expect(store.reports.size).toBe(1)
    expect(store.reports.get(first.response.reportId)!.anonSessionId).toBe("anontok-squatter")
  })

  it("still replays the original response for the SAME anon session", async () => {
    const { store, service } = makeHarness()
    const signed = signAnonToken(store.seedToken({ id: "anontok-owner" }).id, SIGNING_KEY)
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A, anonToken: signed }), ctx)
    const replay = await service.submitAnonReport(req({ idempotencyKey: KEY_A, anonToken: signed }), ctx)

    expect(replay.response).toEqual(first.response)
    expect(store.reports.size).toBe(1)
  })

  it("a caller presenting NO anon token cannot replay a session-owned snapshot", async () => {
    const { store, service } = makeHarness()
    const signed = signAnonToken(store.seedToken({ id: "anontok-owner" }).id, SIGNING_KEY)
    const first = await service.submitAnonReport(req({ idempotencyKey: KEY_A, anonToken: signed }), ctx)

    await expect(service.submitAnonReport(req({ idempotencyKey: KEY_A }), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(store.reports.size).toBe(1)
    expect(store.reports.get(first.response.reportId)!.anonSessionId).toBe("anontok-owner")
  })
})

function uuid(n: number): string {
  const h = n.toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${h}`
}
