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

/**
 * Offline unit tests for the outreach DIGEST pipeline over the in-memory outreach repo + in-memory mail
 * repo + a FakeMailer-backed OutboundMailService (no DB, no SMTP, no Docker). They prove the contract the
 * outreach.digest job relies on:
 *   - a due jurisdiction's waiting reports aggregate into ONE digest email, sent From outreach, recorded
 *     as an out thread/message + 'sent' event, with outreach_state.last_outreach_at stamped;
 *   - the throttle (outreach_state.last_outreach_at + OUTREACH_THROTTLE_DAYS) and the manual `suppressed`
 *     flag both prevent a re-send inside the window (defense in depth on top of discovery's enqueue);
 *   - the sweep runs every due candidate; the targeted per-geoid run is the same path;
 *   - the pure throttle + digest-copy helpers.
 */

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

/** A timestamp `days` before NOW. */
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
    // Categories with no waiting reports are not listed.
    expect(body).not.toContain("Recycling")
  })
})

describe("outreach digest: aggregation + send", () => {
  it("aggregates a due jurisdiction's waiting reports into one digest, sends it, stamps outreach_state", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", org: "City of LA", defaultEmail: "clerk@lacity.gov" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    outreachRepo.seedReport({ geoid: "0644000", category: "hazard" })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(true)
    expect(result.reportCount).toBe(3)

    // Exactly ONE digest email was sent, From outreach, to the resolved contact.
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("clerk@lacity.gov")
    expect(mailer.sent[0]?.vars?.from).toBe(FROM_OUTREACH)
    expect(String(mailer.sent[0]?.vars?.subject)).toContain("3 reports")

    // An out thread/message + a 'sent' event were recorded on the per-geoid thread.
    expect(mailRepo.threads.size).toBe(1)
    const thread = [...mailRepo.threads.values()][0]!
    expect(thread.jurisdictionGeoid).toBe("0644000")
    const dto = await mailRepo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(mailRepo.events[0]?.type).toBe("sent")

    // outreach_state.last_outreach_at was stamped to NOW (throttle window started).
    const state = await mailRepo.getOutreachState("0644000")
    expect(state?.lastOutreachAt?.getTime()).toBe(NOW.getTime())
  })

  it("does nothing when the jurisdiction has waiting reports but no contact", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", org: "City of LA" }) // no contact
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("nothing-to-send")
    expect(mailer.sent).toHaveLength(0)
    expect(await mailRepo.getOutreachState("0644000")).toBeNull() // not stamped
  })

  it("does nothing when there are no waiting reports", async () => {
    const { outreachRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    // A resolved report does not count as waiting.
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
    // Already sent 1 day ago (inside the 7-day window).
    await mailRepo.setOutreachState("0644000", { lastOutreachAt: daysAgo(1) })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("throttled")
    expect(mailer.sent).toHaveLength(0)
    // The existing last_outreach_at is untouched.
    const state = await mailRepo.getOutreachState("0644000")
    expect(state?.lastOutreachAt?.getTime()).toBe(daysAgo(1).getTime())
  })

  it("re-sends once the throttle window has elapsed", async () => {
    const { outreachRepo, mailRepo, mailer, svc } = harness()
    outreachRepo.seedJurisdiction({ geoid: "0644000", defaultEmail: "clerk@lacity.gov" })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })
    // Last sent 8 days ago (outside the 7-day window).
    await mailRepo.setOutreachState("0644000", { lastOutreachAt: daysAgo(8) })

    const result = await svc.runForGeoid("0644000")
    expect(result.sent).toBe(true)
    expect(mailer.sent).toHaveLength(1)
    expect((await mailRepo.getOutreachState("0644000"))?.lastOutreachAt?.getTime()).toBe(NOW.getTime())
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
    // Due: has a contact + waiting reports + never sent.
    outreachRepo.seedJurisdiction({ geoid: "1", defaultEmail: "a@city.gov" })
    outreachRepo.seedReport({ geoid: "1", category: "trash" })
    // Throttled: sent recently -> a candidate, but skipped by the per-geoid throttle.
    outreachRepo.seedJurisdiction({ geoid: "2", defaultEmail: "b@city.gov" })
    outreachRepo.seedReport({ geoid: "2", category: "hazard" })
    await mailRepo.setOutreachState("2", { lastOutreachAt: daysAgo(1) })
    // Not a candidate: waiting reports but no contact -> never listed.
    outreachRepo.seedJurisdiction({ geoid: "3" })
    outreachRepo.seedReport({ geoid: "3", category: "water" })

    const results = await svc.runSweep()
    const byGeoid = new Map(results.map((r) => [r.geoid, r]))
    // geoid 3 is not even a candidate, so it is not in the results.
    expect(byGeoid.has("3")).toBe(false)
    expect(byGeoid.get("1")?.sent).toBe(true)
    expect(byGeoid.get("2")?.sent).toBe(false)
    expect(byGeoid.get("2")?.skipped).toBe("throttled")
    // Only geoid 1 actually mailed.
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("a@city.gov")
  })
})
