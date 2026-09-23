import { describe, it, expect } from "vitest"
import type { ReportDTO } from "@civfix/shared"
import { signAnonToken } from "../../src/abuse/anon-token.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import { makeClaimService, type ClaimService } from "../../src/services/claim-service.js"
import type { ReportOwner } from "../../src/services/report-service.js"
import { InMemoryAnonStore } from "../helpers/anon.js"

/**
 * The account-claim service: the post-submit nudge and the single-use claim that links a held anon
 * report to a signed-in account.
 *
 * Only sha256(code) is ever stored, so the service hashes a presented code before matching, and the
 * nudge, which cannot read a code back, MINTS a fresh one and stamps its digest onto the pending report.
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
      mediaPending: 0,
      timeline: [],
      linkedEvents: [],
    })
  }
}

function harness(): { store: InMemoryAnonStore; service: ClaimService } {
  const store = new InMemoryAnonStore()
  let minted = 0
  const service = makeClaimService({
    repo: store.claimRepo(),
    anonTokenSigningKey: SIGNING_KEY,
    getReportForOwner: stubGetReport(store),
    newClaimCode: () => `fresh-${++minted}`,
  })
  return { store, service }
}

/**
 * Seed a token + its held anon report carrying the DIGEST of a per-report claim code - which is exactly
 * what a pre-0091 plaintext row looks like after 0091's backfill. The digest lives on the REPORT row,
 * the claim source of truth.
 */
async function seedPending(
  store: InMemoryAnonStore,
  claimCode = "claim-xyz",
): Promise<{ tokenId: string; signed: string; reportId: string }> {
  const token = store.seedToken({ id: "tok-1" })
  const report = store.seedReport({
    id: "rep-1",
    anonSessionId: token.id,
    reporterUserId: null,
    status: "held",
    claimCodeHash: await sha256Hex(claimCode),
  })
  return { tokenId: token.id, signed: signAnonToken(token.id, SIGNING_KEY), reportId: report.id }
}

describe("claimNudge", () => {
  it("mints a FRESH code for the pending report and stores only its digest (F150)", async () => {
    const { store, service } = harness()
    const { signed, reportId } = await seedPending(store, "claim-xyz")

    const nudge = await service.claimNudge(signed)
    expect(nudge).toEqual({ claimCode: "fresh-1", reportId })

    const stored = store.reports.get(reportId)!
    expect(stored.claimCodeHash).toBe(await sha256Hex("fresh-1"))
    expect(JSON.stringify(stored)).not.toContain("fresh-1")
  })

  it("the freshly nudged code claims the report, and the superseded one no longer does", async () => {
    const { store, service } = harness()
    const { signed, reportId } = await seedPending(store, "claim-xyz")
    const nudge = await service.claimNudge(signed)

    await expect(service.claimReport("claim-xyz", "user-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const claimed = await service.claimReport(nudge.claimCode, "user-1")
    expect(claimed.report.id).toBe(reportId)
  })

  it("404s an invalid/unknown token", async () => {
    const { service } = harness()
    await expect(service.claimNudge(signAnonToken("ghost", SIGNING_KEY))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s a valid token with no pending report", async () => {
    const { store, service } = harness()
    store.seedToken({ id: "tok-empty" })
    await expect(service.claimNudge(signAnonToken("tok-empty", SIGNING_KEY))).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    )
  })
})

describe("claimReport", () => {
  it("links the report to the user and returns the ReportDTO (mine=true)", async () => {
    const { store, service } = harness()
    const { reportId } = await seedPending(store, "claim-xyz")

    const res = await service.claimReport("claim-xyz", "user-1")
    expect(res.report.id).toBe(reportId)
    expect(res.report.mine).toBe(true)
    expect(store.reports.get(reportId)!.reporterUserId).toBe("user-1")
  })

  it("is single-use: a second claim with the same code 404s", async () => {
    const { store, service } = harness()
    await seedPending(store, "claim-xyz")
    await service.claimReport("claim-xyz", "user-1")
    // The digest was consumed (cleared) on the first claim.
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
    const { reportId, tokenId } = await seedPending(store, "claim-xyz")
    await service.claimReport("claim-xyz", "user-1")
    expect(store.reports.get(reportId)!.anonSessionId).toBe(tokenId)
  })

  it("P2-5: two reports under ONE token are each independently claimable by their own code", async () => {
    const { store, service } = harness()
    // When the single anon_tokens.claim_code column held only the LATEST code, the first report under
    // a token was unclaimable.
    const token = store.seedToken({ id: "tok-multi" })
    const r1 = store.seedReport({
      id: "rep-a",
      anonSessionId: token.id,
      reporterUserId: null,
      status: "held",
      claimCodeHash: await sha256Hex("code-a"),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    })
    const r2 = store.seedReport({
      id: "rep-b",
      anonSessionId: token.id,
      reporterUserId: null,
      status: "held",
      claimCodeHash: await sha256Hex("code-b"),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)),
    })

    const claimedA = await service.claimReport("code-a", "user-1")
    expect(claimedA.report.id).toBe(r1.id)
    expect(store.reports.get(r1.id)!.reporterUserId).toBe("user-1")
    expect(store.reports.get(r2.id)!.reporterUserId).toBeNull()

    const claimedB = await service.claimReport("code-b", "user-2")
    expect(claimedB.report.id).toBe(r2.id)
    expect(store.reports.get(r2.id)!.reporterUserId).toBe("user-2")

    await expect(service.claimReport("code-a", "user-3")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.claimReport("code-b", "user-3")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})
