import { describe, it, expect } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeJobs, FakeMailer } from "@civfix/shared/fakes"
import { AppError } from "@civfix/shared"
import type { CreateReportRequest } from "@civfix/shared"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { InMemoryAdminUserRepository } from "../../src/services/admin/admin-user-repository.memory.js"
import {
  makeAdminReportService,
  REPORT_VERIFIED_THRESHOLD,
  type AdminReportService,
} from "../../src/services/admin/admin-report-service.js"
import {
  makeAdminUserService,
  type AdminUserService,
} from "../../src/services/admin/admin-user-service.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import {
  makeOutboundMailService,
  type OutboundMailService,
} from "../../src/services/admin/outbound-mail-service.js"
import { runAutoForwardWith } from "../../src/services/admin/autoforward-jobs.js"
import { makeReportService, REPORT_AUTOFORWARD_JOB } from "../../src/services/report-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"


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
  const svc = makeAdminReportService({ repo, outboundMail, now: () => NOW })
  return { repo, svc }
}


describe("setVerdict (D7) — verdict write + count + flip", () => {
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


describe("setUserReportVerified (D18) — manual override/revoke", () => {
  function userHarness(): { repo: InMemoryAdminUserRepository; svc: AdminUserService } {
    const repo = new InMemoryAdminUserRepository()
    const svc = makeAdminUserService({
      repo,
      sessions: {
        ban: async () => 0,
        clearBan: async () => {},
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
    expect(repo.audits.at(-1)).toMatchObject({ action: "user.report_unverified", target: "user:u1" })

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


describe("createReport auto-forward enqueue gate (D9)", () => {
  const VERIFIED_UID = "11111111-1111-1111-1111-111111111111"
  const UNVERIFIED_UID = "22222222-2222-2222-2222-222222222222"

  function createReq(over: Partial<CreateReportRequest> = {}): CreateReportRequest {
    return {
      idempotencyKey: over.idempotencyKey ?? randomUUID(),
      category: over.category ?? "trash",
      type: over.type ?? "dump",
      lat: over.lat ?? 34.1,
      lng: over.lng ?? -118.35,
      geomSource: over.geomSource ?? "device",
      mediaUploadIds: over.mediaUploadIds ?? [],
    }
  }

  function createHarness(verifiedUserIds: Set<string>) {
    const repo = new InMemoryReportRepository()
    const jobs = new FakeJobs()
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      presignMedia: (r2Key, thumbKey) =>
        Promise.resolve(thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey }),
      jobs,
      isReportVerified: (userId: string) => Promise.resolve(verifiedUserIds.has(userId)),
    })
    return { jobs, service }
  }

  it("enqueues report.autoforward (singletonKey=reportId) for a report_verified reporter", async () => {
    const { jobs, service } = createHarness(new Set([VERIFIED_UID]))
    const dto = await service.createReport(createReq(), { userId: VERIFIED_UID })

    const enqueued = jobs.jobsFor(REPORT_AUTOFORWARD_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toEqual({ reportId: dto.id })
    expect(enqueued[0]?.opts?.singletonKey).toBe(dto.id)
  })

  it("does NOT enqueue for an unverified reporter", async () => {
    const { jobs, service } = createHarness(new Set([VERIFIED_UID]))
    await service.createReport(createReq(), { userId: UNVERIFIED_UID })
    expect(jobs.jobsFor(REPORT_AUTOFORWARD_JOB)).toHaveLength(0)
  })

  it("does NOT enqueue when the gate seam is absent (anon/non-forwarding paths)", async () => {
    const repo = new InMemoryReportRepository()
    const jobs = new FakeJobs()
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      presignMedia: (r2Key) => Promise.resolve({ url: r2Key }),
    })
    await service.createReport(createReq(), { userId: VERIFIED_UID })
    expect(jobs.enqueued).toHaveLength(0)
  })

  it("a gate-read throw is swallowed (the create still succeeds, nothing enqueued)", async () => {
    const repo = new InMemoryReportRepository()
    const jobs = new FakeJobs()
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      presignMedia: (r2Key) => Promise.resolve({ url: r2Key }),
      jobs,
      isReportVerified: () => Promise.reject(new Error("gate read failed")),
      logger: { warn: () => {} },
    })
    const dto = await service.createReport(createReq(), { userId: VERIFIED_UID })
    expect(dto.id).toBeTruthy()
    expect(jobs.jobsFor(REPORT_AUTOFORWARD_JOB)).toHaveLength(0)
  })
})


describe("report.autoforward handler (D9) — runAutoForwardWith", () => {
  function handlerHarness(opts: { sendError?: unknown } = {}) {
    const repo = new InMemoryAdminReportRepository()
    repo.now = NOW
    const mailer = new FakeMailer()
    const mailRepo = new InMemoryMailRepository()
    const realOutbound = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    const outboundMail: OutboundMailService =
      opts.sendError !== undefined
        ? { ...realOutbound, sendReportToJurisdiction: () => Promise.reject(opts.sendError) }
        : realOutbound
    const svc = makeAdminReportService({ repo, outboundMail, now: () => NOW })
    return { repo, mailer, mailRepo, svc }
  }

  it("(a) no routing contact -> completes as a no-op, no send, no throw", async () => {
    const { repo, mailer, svc } = handlerHarness()
    repo.seedReport({
      id: "rep-1",
      reporter: reporter("u-1"),
      routing: { geoid: "0644000", dept: "LA", place: "Los Angeles", contact: null, routed: false },
    })

    await expect(runAutoForwardWith(svc, "rep-1")).resolves.toBeUndefined()
    expect(mailer.sent).toHaveLength(0)
  })

  it("(a') no resolved jurisdiction (geoid null) -> completes as a no-op, no send", async () => {
    const { repo, mailer, svc } = handlerHarness()
    repo.seedReport({
      id: "rep-1",
      reporter: reporter("u-1"),
      routing: { geoid: null, dept: "", place: "", contact: null, routed: false },
    })
    await expect(runAutoForwardWith(svc, "rep-1")).resolves.toBeUndefined()
    expect(mailer.sent).toHaveLength(0)
  })

  it("(b) a report WITH a contact -> invokes the per-report send (mail delivered to the contact)", async () => {
    const { repo, mailer, mailRepo, svc } = handlerHarness()
    repo.seedReport({
      id: "rep-1",
      category: "hazard",
      place: "Los Angeles",
      reporter: reporter("u-1"),
      routing: {
        geoid: "0644000",
        dept: "LA Sanitation",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
    })

    await runAutoForwardWith(svc, "rep-1")

    const sent = mailer.sent.find((m) => m.to === "311@lacity.gov")
    expect(sent).toBeDefined()
    expect(sent?.outbound?.from).toMatch(/^"civfix Reports" <report-[a-z2-7]{12}@civfix\.org>$/)
    expect(sent?.outbound?.replyTo).toBeUndefined()
    const thread = [...mailRepo.threads.values()].find((t) => t.reportId === "rep-1")
    expect(thread).toBeDefined()
  })

  it("(b') idempotency: a report already routed (outreach != not_sent) is left alone, no second send", async () => {
    const { repo, mailer, svc } = handlerHarness()
    repo.seedReport({
      id: "rep-1",
      reporter: reporter("u-1"),
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
      outreach: { threadStatus: "delivered", threadId: "t-1", routedTo: "311@lacity.gov" },
    })

    await runAutoForwardWith(svc, "rep-1")
    expect(mailer.sent).toHaveLength(0)
  })

  it("(c) a TERMINAL send failure (409 sender-not-approved) is swallowed — handler completes, never throws", async () => {
    const { repo, svc } = handlerHarness({ sendError: AppError.conflict("sender not approved") })
    repo.seedReport({
      id: "rep-1",
      reporter: reporter("u-1"),
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
    })

    const warnings: unknown[] = []
    await expect(
      runAutoForwardWith(svc, "rep-1", { info: () => {}, warn: (o) => warnings.push(o) }),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it("(c') a TRANSIENT infra failure re-throws so pg-boss retries the job", async () => {
    const { repo, svc } = handlerHarness({ sendError: new Error("ECONNRESET") })
    repo.seedReport({
      id: "rep-1",
      reporter: reporter("u-1"),
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
    })

    const warnings: unknown[] = []
    await expect(
      runAutoForwardWith(svc, "rep-1", { info: () => {}, warn: (o) => warnings.push(o) }),
    ).rejects.toThrow("ECONNRESET")
    expect(warnings).toHaveLength(1)
  })

  it("a missing report -> completes as a no-op (service.get throws, the handler swallows it)", async () => {
    const { svc } = handlerHarness()
    await expect(runAutoForwardWith(svc, "ghost")).resolves.toBeUndefined()
  })
})
