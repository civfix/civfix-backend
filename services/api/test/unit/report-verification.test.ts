import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/seams"
import { InMemoryAdminReportRepository } from "../helpers/admin/admin-report-repository.memory.js"
import { InMemoryAdminUserRepository } from "../helpers/admin/admin-user-repository.memory.js"
import {
  makeAdminReportService,
  REPORT_VERIFIED_THRESHOLD,
  type AdminReportService,
} from "../../src/services/admin/admin-report-service.js"
import {
  makeAdminUserService,
  type AdminUserService,
} from "../../src/services/admin/admin-user-service.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { memoryFilingService } from "../helpers/filings/filing-harness.js"

const NOW = new Date("2026-06-22T00:00:00.000Z")

function reporter(id: string) {
  return {
    id,
    name: "Jane Neighbor",
    handle: "jane",
    emailVerified: true,
    hasOauth: false,
    joinedAt: new Date(Date.UTC(2025, 0, 1)),
  }
}

interface VerdictHarness {
  repo: InMemoryAdminReportRepository
  svc: AdminReportService
}

function verdictHarness(): VerdictHarness {
  const repo = new InMemoryAdminReportRepository()
  repo.now = NOW
  const mailer = new FakeMailer()
  const outboundMail = makeOutboundMailService({
    repo: new InMemoryMailRepository(),
    mailer,
    env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
  })
  const svc = makeAdminReportService({
    repo,
    outboundMail,
    filings: memoryFilingService(repo),
    now: () => NOW,
  })
  return { repo, svc }
}

describe("setVerdict (D7): verdict write + count + flip", () => {
  it("approve-once: records the verdict but leaves report_verified false (count=1 < threshold)", async () => {
    const { repo, svc } = verdictHarness()
    const uid = "user-1"
    repo.seedReport({ id: "r1", reporter: reporter(uid) })

    await svc.setVerdict({ id: "r1", verdict: "approved", actorId: "op-1" })

    const seeded = repo.reports.get("r1")!
    expect(seeded.record.verificationVerdict).toBe("approved")
    expect(seeded.record.verifiedAt).not.toBeNull()
    expect(REPORT_VERIFIED_THRESHOLD).toBe(2)
    expect(repo.reporterReportVerified.get(uid)).not.toBe(true)
    expect(repo.audits.at(-1)).toMatchObject({
      action: "report.verdict_set",
      target: "report:r1",
      meta: { verdict: "approved" },
    })
  })

  it("approve two DIFFERENT reports for the same reporter: the 2nd flips report_verified=true", async () => {
    const { repo, svc } = verdictHarness()
    const uid = "user-2"
    repo.seedReport({ id: "r1", reporter: reporter(uid) })
    repo.seedReport({ id: "r2", reporter: reporter(uid) })

    await svc.setVerdict({ id: "r1", verdict: "approved", actorId: "op-1" })
    expect(repo.reporterReportVerified.get(uid)).not.toBe(true)

    await svc.setVerdict({ id: "r2", verdict: "approved", actorId: "op-1" })
    expect(repo.reporterReportVerified.get(uid)).toBe(true)

    const detail = await svc.get("r1")
    expect(detail.reporterReportVerified).toBe(true)
  })

  it("approve idempotency: approving the SAME report twice keeps count=1 (no false flip)", async () => {
    const { repo, svc } = verdictHarness()
    const uid = "user-3"
    repo.seedReport({ id: "r1", reporter: reporter(uid) })

    await svc.setVerdict({ id: "r1", verdict: "approved", actorId: "op-1" })
    await svc.setVerdict({ id: "r1", verdict: "approved", actorId: "op-1" })

    expect(repo.reporterReportVerified.get(uid)).not.toBe(true)
    expect(repo.reports.get("r1")?.record.verificationVerdict).toBe("approved")
  })

  it("reject: never counts toward the threshold (two rejected reports do not flip)", async () => {
    const { repo, svc } = verdictHarness()
    const uid = "user-4"
    repo.seedReport({ id: "r1", reporter: reporter(uid) })
    repo.seedReport({ id: "r2", reporter: reporter(uid) })

    await svc.setVerdict({ id: "r1", verdict: "rejected", actorId: "op-1" })
    await svc.setVerdict({ id: "r2", verdict: "rejected", actorId: "op-1" })

    expect(repo.reports.get("r1")?.record.verificationVerdict).toBe("rejected")
    expect(repo.reporterReportVerified.get(uid)).not.toBe(true)
  })

  it("reject AFTER a flip does NOT unset an earned report_verified (trust revoked only by D18/suspension)", async () => {
    const { repo, svc } = verdictHarness()
    const uid = "user-5"
    repo.seedReport({ id: "r1", reporter: reporter(uid) })
    repo.seedReport({ id: "r2", reporter: reporter(uid) })
    repo.seedReport({ id: "r3", reporter: reporter(uid) })

    await svc.setVerdict({ id: "r1", verdict: "approved", actorId: "op-1" })
    await svc.setVerdict({ id: "r2", verdict: "approved", actorId: "op-1" })
    expect(repo.reporterReportVerified.get(uid)).toBe(true)

    await svc.setVerdict({ id: "r3", verdict: "rejected", actorId: "op-1" })
    expect(repo.reporterReportVerified.get(uid)).toBe(true)
  })

  it("anonymous report: a verdict is recorded for bookkeeping but never counts/flips any account", async () => {
    const { repo, svc } = verdictHarness()
    repo.seedReport({ id: "anon-1", reporter: null })
    repo.seedReport({ id: "anon-2", reporter: null })

    await svc.setVerdict({ id: "anon-1", verdict: "approved", actorId: "op-1" })
    await svc.setVerdict({ id: "anon-2", verdict: "approved", actorId: "op-1" })

    expect(repo.reports.get("anon-1")?.record.verificationVerdict).toBe("approved")
    expect(repo.reports.get("anon-2")?.record.verificationVerdict).toBe("approved")
    expect(repo.reporterReportVerified.size).toBe(0)
  })

  it("two reporters' approvals are independent (one reporter's count cannot flip another)", async () => {
    const { repo, svc } = verdictHarness()
    repo.seedReport({ id: "a1", reporter: reporter("alice") })
    repo.seedReport({ id: "a2", reporter: reporter("alice") })
    repo.seedReport({ id: "b1", reporter: reporter("bob") })

    await svc.setVerdict({ id: "a1", verdict: "approved", actorId: "op-1" })
    await svc.setVerdict({ id: "a2", verdict: "approved", actorId: "op-1" })
    await svc.setVerdict({ id: "b1", verdict: "approved", actorId: "op-1" })

    expect(repo.reporterReportVerified.get("alice")).toBe(true)
    expect(repo.reporterReportVerified.get("bob")).not.toBe(true)
  })

  it("setVerdict on a missing report throws notFound (404)", async () => {
    const { svc } = verdictHarness()
    await expect(
      svc.setVerdict({ id: "nope", verdict: "approved", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("setUserReportVerified (D18): manual override/revoke", () => {
  function userHarness(): { repo: InMemoryAdminUserRepository; svc: AdminUserService } {
    const repo = new InMemoryAdminUserRepository()
    const svc = makeAdminUserService({
      repo,
      sessions: {
        applyStatus: async () => 0,
        revokeAll: async () => 0,
      },
      now: () => NOW,
    })
    return { repo, svc }
  }

  it("true then false round-trips report_verified, auditing each transition", async () => {
    const { repo, svc } = userHarness()
    repo.seedUser({ id: "u1", reportVerified: false })

    await svc.setReportVerified("u1", { value: true, actorId: "op-1" })
    expect(repo.users.get("u1")?.reportVerified).toBe(true)
    expect(repo.audits.at(-1)).toMatchObject({ action: "user.report_verified", target: "user:u1" })

    await svc.setReportVerified("u1", { value: false, actorId: "op-1" })
    expect(repo.users.get("u1")?.reportVerified).toBe(false)
    expect(repo.audits.at(-1)).toMatchObject({
      action: "user.report_unverified",
      target: "user:u1",
    })

    const dto = await svc.get("u1")
    expect(dto.reportVerified).toBe(false)
  })

  it("throws notFound (404) for a missing user", async () => {
    const { svc } = userHarness()
    await expect(
      svc.setReportVerified("ghost", { value: true, actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })
})
