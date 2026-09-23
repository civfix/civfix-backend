import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryOutreachRepository } from "../../src/services/admin/outreach-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import {
  makeOutreachService,
  isThrottled,
  digestSubject,
  digestBody,
  type OutreachService,
} from "../../src/services/admin/outreach-service.js"
import type { OutreachRepository } from "../../src/services/admin/outreach-repository.js"

const NOW = new Date("2026-06-06T00:00:00.000Z")
const THROTTLE_DAYS = 7
const FROM_OUTREACH = "outreach@civfix.org"

interface Harness {
  outreachRepo: InMemoryOutreachRepository
  mailRepo: InMemoryMailRepository
  mailer: FakeMailer
  svc: OutreachService
}

function harness(now: Date = NOW): Harness {
  const outreachRepo = new InMemoryOutreachRepository()
  const mailRepo = new InMemoryMailRepository()
  const mailer = new FakeMailer()
  const outboundMail = makeOutboundMailService({
    repo: mailRepo,
    mailer,
    env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
  })
  const svc = makeOutreachService({
    outreachRepo,
    mailRepo,
    outboundMail,
    throttleDays: THROTTLE_DAYS,
    now: () => now,
  })
  return { outreachRepo, mailRepo, mailer, svc }
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

describe("outreach pure helpers", () => {
  it("isThrottled is true only inside the window; a never-sent geoid is not throttled", () => {
    expect(isThrottled(null, NOW, THROTTLE_DAYS)).toBe(false)
    expect(isThrottled(daysAgo(THROTTLE_DAYS - 1), NOW, THROTTLE_DAYS)).toBe(true)
    expect(isThrottled(daysAgo(THROTTLE_DAYS + 1), NOW, THROTTLE_DAYS)).toBe(false)
  })

  it("digestSubject + digestBody summarize the aggregate", () => {
    const digest = {
      geoid: "0644000",
      org: "City of LA",
      toAddr: "clerk@lacity.gov",
      perCategory: { trash: 3, hazard: 1 },
      total: 4,
      oldestWaitingAt: daysAgo(2),
    }
    expect(digestSubject(digest)).toContain("4 reports")
    expect(digestSubject(digest)).toContain("City of LA")
    const body = digestBody(digest)
    expect(body).toContain("Trash: 3")
    expect(body).toContain("Hazard: 1")
    expect(body).not.toContain("Recycling")
  })
})

describe("outreach digest: aggregation + send", () => {
  it("aggregates a due jurisdiction's waiting reports into one digest, sends it, stamps outreach_state", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({
      geoid: "0644000",
      org: "City of LA",
      defaultEmail: "clerk@lacity.gov",
    })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    outreachRepo.seedReport({ geoid: "0644000", category: "hazard" })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(true)
    expect(result.reportCount).toBe(3)

    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("clerk@lacity.gov")
    expect(mailer.sent[0]?.outbound?.from).toMatch(/^"civfix" <reply-[a-z2-7]{12}@civfix\.org>$/)
    expect(String(mailer.sent[0]?.outbound?.subject)).toContain("3 reports")

    expect(mailRepo.threads.size).toBe(1)
    const thread = [...mailRepo.threads.values()][0]!
    expect(thread.jurisdictionGeoid).toBe("0644000")
    const dto = await mailRepo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(mailRepo.events[0]?.type).toBe("sent")

    const state = await mailRepo.getOutreachState("0644000")
    expect(state?.lastOutreachAt?.getTime()).toBe(NOW.getTime())
  })

  it("does nothing when the jurisdiction has waiting reports but no contact", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", org: "City of LA" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("nothing-to-send")
    expect(mailer.sent).toHaveLength(0)
    expect(await mailRepo.getOutreachState("0644000")).toBeNull()
  })

  it("does nothing when there are no waiting reports", async () => {
    const { outreachRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash", status: "resolved" })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("nothing-to-send")
    expect(mailer.sent).toHaveLength(0)
  })
})

describe("outreach digest: throttle (defense in depth)", () => {
  it("does NOT re-send inside the throttle window", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    await mailRepo.setOutreachState("0644000", { lastOutreachAt: daysAgo(1) })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("throttled")
    expect(mailer.sent).toHaveLength(0)
    const state = await mailRepo.getOutreachState("0644000")
    expect(state?.lastOutreachAt?.getTime()).toBe(daysAgo(1).getTime())
  })

  it("re-sends once the throttle window has elapsed", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    await mailRepo.setOutreachState("0644000", { lastOutreachAt: daysAgo(8) })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(true)
    expect(mailer.sent).toHaveLength(1)
    expect((await mailRepo.getOutreachState("0644000"))?.lastOutreachAt?.getTime()).toBe(
      NOW.getTime(),
    )
  })

  it("does NOT send a suppressed jurisdiction", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    await mailRepo.setOutreachState("0644000", { suppressed: true })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("suppressed")
    expect(mailer.sent).toHaveLength(0)
  })
})

describe("outreach digest: sweep", () => {
  it("runs every due candidate jurisdiction and skips the throttled / contactless ones", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "1", defaultEmail: "a@city.gov" })
    outreachRepo.seedReport({ geoid: "1", category: "trash" })
    outreachRepo.seedJurisdiction({ geoid: "2", defaultEmail: "b@city.gov" })
    outreachRepo.seedReport({ geoid: "2", category: "hazard" })
    await mailRepo.setOutreachState("2", { lastOutreachAt: daysAgo(1) })
    outreachRepo.seedJurisdiction({ geoid: "3" })
    outreachRepo.seedReport({ geoid: "3", category: "water" })

    const results = await svc.runSweep()
    const byGeoid = new Map(results.map((r) => [r.geoid, r]))
    expect(byGeoid.has("3")).toBe(false)
    expect(byGeoid.get("1")?.sent).toBe(true)
    expect(byGeoid.get("2")?.sent).toBe(false)
    expect(byGeoid.get("2")?.skipped).toBe("throttled")
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("a@city.gov")
  })
})

describe("outreach digest: atomic send-window claim (F36/F70)", () => {
  function claimHarness(claimResult: boolean) {
    const inner = new InMemoryOutreachRepository()
    inner.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    inner.seedReport({ geoid: "0644000", category: "trash" })
    const mailRepo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    const claimCalls: Array<{ geoid: string }> = []
    const outreachRepo: OutreachRepository = {
      loadDigest: (g) => inner.loadDigest(g),
      listCandidateGeoids: () => inner.listCandidateGeoids(),
      claimOutreachWindow: async (geoid) => {
        claimCalls.push({ geoid })
        return claimResult
      },
    }
    const svc = makeOutreachService({
      outreachRepo,
      mailRepo,
      outboundMail,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
    })
    return { svc, mailer, claimCalls }
  }

  it("sends only after winning the atomic claim", async () => {
    const { svc, mailer, claimCalls } = claimHarness(true)
    const result = await svc.runForGeoid("0644000")
    expect(claimCalls).toHaveLength(1)
    expect(result.sent).toBe(true)
    expect(mailer.sent).toHaveLength(1)
  })

  it("does NOT send when the claim is lost (a concurrent run already claimed the window)", async () => {
    const { svc, mailer, claimCalls } = claimHarness(false)
    const result = await svc.runForGeoid("0644000")
    expect(claimCalls).toHaveLength(1)
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("throttled")
    expect(mailer.sent).toHaveLength(0)
  })
})
