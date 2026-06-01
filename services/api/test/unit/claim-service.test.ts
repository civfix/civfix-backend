import { describe, it, expect } from "vitest"
import type { ReportDTO } from "@civfix/shared"
import { signAnonToken } from "../../src/abuse/anon-token.js"
import { makeClaimService, type ClaimService } from "../../src/services/claim-service.js"
import type { ReportOwner } from "../../src/services/report-service.js"
import { InMemoryAnonStore } from "../helpers/anon.js"

/**
 * Offline unit tests for the account-claim service: the post-submit nudge and the single-use claim that
 * links a held anon report to a signed-in account. Run against the in-memory anon store; the ReportDTO
 * projection is faked (a tiny stub that echoes the now-owner).
 */

const SIGNING_KEY = "test-anon-signing-key"

/** A stub that renders a minimal ReportDTO for whoever claims it (mine reflects the owner). */
function stubGetReport(store: InMemoryAnonStore) {
  return (reportId: string, owner: ReportOwner): Promise<ReportDTO> => {
    const r = store.reports.get(reportId)
    if (!r) return Promise.reject(new Error("missing"))
    return Promise.resolve({
      id: r.id,
      category: r.category as ReportDTO["category"],
      status: r.status,
      visibility: r.visibility,
      lat: r.lat,
      lng: r.lng,
      geomSource: "device",
      createdAt: r.createdAt.toISOString(),
      mine: r.reporterUserId === owner.userId,
      gov: false,
      following: false,
      media: [],
      timeline: [],
    })
  }
}

function harness(): { store: InMemoryAnonStore; service: ClaimService } {
  const store = new InMemoryAnonStore()
  const service = makeClaimService({
    repo: store.claimRepo(),
    anonTokenSigningKey: SIGNING_KEY,
    getReportForOwner: stubGetReport(store),
  })
  return { store, service }
}

/** Seed a token + its held anon report with a stamped claim code, returning the signed token + ids. */
function seedPending(
  store: InMemoryAnonStore,
  claimCode = "claim-xyz",
): { tokenId: string; signed: string; reportId: string } {
  const token = store.seedToken({ id: "tok-1", claimCode })
  const report = store.seedReport({
    id: "rep-1",
    anonSessionId: token.id,
    reporterUserId: null,
    status: "held",
  })
  return { tokenId: token.id, signed: signAnonToken(token.id, SIGNING_KEY), reportId: report.id }
}

describe("claimNudge", () => {
  it("returns {claimCode, reportId} for the pending report tied to a valid token", async () => {
    const { store, service } = harness()
    const { signed, reportId } = seedPending(store, "claim-xyz")
    const nudge = await service.claimNudge(signed)
    expect(nudge).toEqual({ claimCode: "claim-xyz", reportId })
  })

  it("404s an invalid/unknown token", async () => {
    const { service } = harness()
    await expect(service.claimNudge(signAnonToken("ghost", SIGNING_KEY))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s a valid token with no pending report", async () => {
    const { store, service } = harness()
    store.seedToken({ id: "tok-empty", claimCode: null })
    await expect(
      service.claimNudge(signAnonToken("tok-empty", SIGNING_KEY)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("claimReport", () => {
  it("links the report to the user and returns the ReportDTO (mine=true)", async () => {
    const { store, service } = harness()
    const { reportId } = seedPending(store, "claim-xyz")

    const res = await service.claimReport("claim-xyz", "user-1")
    expect(res.report.id).toBe(reportId)
    expect(res.report.mine).toBe(true)
    // The report is now owned by the user.
    expect(store.reports.get(reportId)!.reporterUserId).toBe("user-1")
  })

  it("is single-use: a second claim with the same code 404s", async () => {
    const { store, service } = harness()
    seedPending(store, "claim-xyz")
    await service.claimReport("claim-xyz", "user-1")
    // The code was consumed (cleared) on the first claim.
    await expect(service.claimReport("claim-xyz", "user-2")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s an unknown claim code", async () => {
    const { service } = harness()
    await expect(service.claimReport("nope", "user-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("keeps anon_session_id as an audit trail after the claim (documented choice)", async () => {
    const { store, service } = harness()
    const { reportId, tokenId } = seedPending(store, "claim-xyz")
    await service.claimReport("claim-xyz", "user-1")
    expect(store.reports.get(reportId)!.anonSessionId).toBe(tokenId)
  })
})
