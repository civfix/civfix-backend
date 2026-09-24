import { describe, it, expect, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { OutboundEmail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryOutreachRepository } from "../../src/services/admin/outreach-repository.memory.js"
import {
  makeOutboundMailService,
  OutboundSendDeadlineError,
} from "../../src/services/admin/outbound-mail-service.js"
import {
  makeOutreachService,
  type OutreachService,
} from "../../src/services/admin/outreach-service.js"
import type { OutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import type { OutreachStateRecord } from "../../src/services/admin/mail-repository.js"

const NOW = new Date("2026-06-06T00:00:00.000Z")
const THROTTLE_DAYS = 7
const WINDOW_MS = THROTTLE_DAYS * 24 * 60 * 60 * 1000
const GEOID = "0644000"
const CONTACT = "clerk@lacity.gov"
const FROM_OUTREACH = "outreach@civfix.org"

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

class FlakyMailer extends FakeMailer {
  failures = 0
  override sendOutbound(email: OutboundEmail): Promise<{ messageId: string }> {
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error("OCI mail transient 500"))
    }
    return super.sendOutbound(email)
  }
}

type Claim = (geoid: string, window: { at: Date; windowStart: Date }) => Promise<boolean>

interface Harness {
  outreachRepo: InMemoryOutreachRepository
  mailRepo: InMemoryMailRepository
  mailer: FlakyMailer
  state: Map<string, OutreachStateRecord>
  svc: OutreachService
  claim: Claim
}

function harness(): Harness {
  const state = new Map<string, OutreachStateRecord>()
  const outreachRepo = new InMemoryOutreachRepository(state)
  outreachRepo.seedJurisdiction({ geoid: GEOID, org: "City of LA", defaultEmail: CONTACT })
  outreachRepo.seedReport({ geoid: GEOID, category: "trash" })
  const mailRepo = new InMemoryMailRepository(state)
  const mailer = new FlakyMailer()
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
    now: () => NOW,
  })
  const claim = outreachRepo.claimOutreachWindow
  if (claim === undefined) {
    throw new Error(
      "harness must construct InMemoryOutreachRepository with the shared outreach_state map",
    )
  }
  return { outreachRepo, mailRepo, mailer, state, svc, claim }
}

describe("InMemoryOutreachRepository.claimOutreachWindow mirrors the SQL upsert-claim", () => {
  it("creates the row and WINS when there is no outreach_state yet", async () => {
    const { claim, state } = harness()
    const won = await claim(GEOID, {
      at: NOW,
      windowStart: new Date(NOW.getTime() - WINDOW_MS),
    })
    expect(won).toBe(true)
    expect(state.get(GEOID)).toEqual({ geoid: GEOID, lastOutreachAt: NOW, suppressed: false })
  })

  it("is exclusive: a second claim inside the same window LOSES and does not re-stamp", async () => {
    const { claim, state } = harness()
    const window = { at: NOW, windowStart: new Date(NOW.getTime() - WINDOW_MS) }
    expect(await claim(GEOID, window)).toBe(true)
    const second = await claim(GEOID, {
      at: new Date(NOW.getTime() + 1000),
      windowStart: window.windowStart,
    })
    expect(second).toBe(false)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)
  })

  it("WINS again once the previous send falls outside the window", async () => {
    const { claim, state } = harness()
    state.set(GEOID, {
      geoid: GEOID,
      lastOutreachAt: daysAgo(THROTTLE_DAYS + 1),
      suppressed: false,
    })
    const won = await claim(GEOID, {
      at: NOW,
      windowStart: new Date(NOW.getTime() - WINDOW_MS),
    })
    expect(won).toBe(true)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)
  })

  it("NEVER claims a suppressed jurisdiction, even with no prior send", async () => {
    const { claim, state } = harness()
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: null, suppressed: true })
    const won = await claim(GEOID, {
      at: NOW,
      windowStart: new Date(NOW.getTime() - WINDOW_MS),
    })
    expect(won).toBe(false)
    expect(state.get(GEOID)).toEqual({ geoid: GEOID, lastOutreachAt: null, suppressed: true })
  })
})

describe("outreach digest: the claim is taken before the send and RELEASED when the send fails", () => {
  it("a successful run claims the window and leaves the stamp in place", async () => {
    const { svc, mailer, state } = harness()
    const result = await svc.runForGeoid(GEOID)
    expect(result).toMatchObject({ geoid: GEOID, sent: true, reportCount: 1 })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe(CONTACT)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)

    const again = await svc.runForGeoid(GEOID)
    expect(again).toMatchObject({ sent: false, skipped: "throttled" })
    expect(mailer.sent).toHaveLength(1)
  })

  it("RESTORES lastOutreachAt to null when the mailer throws, so the next tick retries", async () => {
    const { svc, mailer, mailRepo, state } = harness()
    mailer.failures = 1

    await expect(svc.runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
    expect(state.get(GEOID)?.lastOutreachAt).toBeNull()
    expect(mailRepo.events.map((e) => e.type)).toEqual(["failed"])

    const retry = await svc.runForGeoid(GEOID)
    expect(retry).toMatchObject({ sent: true, reportCount: 1 })
    expect(mailer.sent).toHaveLength(1)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)
  })

  it("restores the PRIOR timestamp (not null) when one existed before the claim", async () => {
    const { svc, mailer, state } = harness()
    const prior = daysAgo(THROTTLE_DAYS + 2)
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: prior, suppressed: false })
    mailer.failures = 1

    await expect(svc.runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(prior)
    expect(state.get(GEOID)?.suppressed).toBe(false)
  })

  it("runSweep records the failure as an error result and still leaves the window retryable", async () => {
    const { svc, mailer, state } = harness()
    mailer.failures = 1
    const results = await svc.runSweep()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ geoid: GEOID, sent: false })
    expect(results[0]?.error).toContain("OCI mail transient 500")
    expect(state.get(GEOID)?.lastOutreachAt).toBeNull()

    const second = await svc.runSweep()
    expect(second[0]).toMatchObject({ geoid: GEOID, sent: true })
  })

  it("a concurrent run's fresh stamp short-circuits the next run at the pre-check", async () => {
    const { svc, mailer, state } = harness()
    const stolenAt = new Date(NOW.getTime() - 1000)
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: stolenAt, suppressed: false })

    const result = await svc.runForGeoid(GEOID)
    expect(result).toMatchObject({ sent: false, skipped: "throttled" })
    expect(mailer.sent).toHaveLength(0)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(stolenAt)
  })

  it("does NOT send and does NOT release when the claim is LOST mid-flight", async () => {
    const { outreachRepo, mailRepo, mailer, state } = harness()
    const priorAt = daysAgo(THROTTLE_DAYS + 2)
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: priorAt, suppressed: false })
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    const winnerAt = new Date(NOW.getTime() - 5)
    const svc = makeOutreachService({
      outreachRepo: {
        loadDigest: (g) => outreachRepo.loadDigest(g),
        listCandidateGeoids: () => outreachRepo.listCandidateGeoids(),
        claimOutreachWindow: () => {
          state.set(GEOID, { geoid: GEOID, lastOutreachAt: winnerAt, suppressed: false })
          return Promise.resolve(false)
        },
      },
      mailRepo,
      outboundMail,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
    })

    const result = await svc.runForGeoid(GEOID)
    expect(result).toMatchObject({ geoid: GEOID, sent: false, skipped: "throttled" })
    expect(mailer.sent).toHaveLength(0)
    expect(mailRepo.messages).toHaveLength(0)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(winnerAt)
  })

  it("skips a suppressed jurisdiction without claiming or sending", async () => {
    const { svc, mailer, state } = harness()
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: null, suppressed: true })
    const result = await svc.runForGeoid(GEOID)
    expect(result).toMatchObject({ sent: false, skipped: "suppressed" })
    expect(mailer.sent).toHaveLength(0)
    expect(state.get(GEOID)).toEqual({ geoid: GEOID, lastOutreachAt: null, suppressed: true })
  })
})

describe("outreach digest: a delivered digest is never re-sent (F109)", () => {
  function serviceWith(sendToCity: () => Promise<never>) {
    const { outreachRepo, mailRepo, state } = harness()
    const outboundMail = { sendToCity } as unknown as OutboundMailService
    const svc = makeOutreachService({
      outreachRepo,
      mailRepo,
      outboundMail,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
    })
    return { svc, state }
  }

  it("does NOT release the claim when the send throws AFTER delivery (err.delivered === true)", async () => {
    const delivered = Object.assign(new Error("thread re-read failed after delivery"), {
      delivered: true,
    })
    const { svc, state } = serviceWith(() => Promise.reject(delivered))

    await expect(svc.runForGeoid(GEOID)).rejects.toThrow("thread re-read failed after delivery")
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)
  })

  it("keeps the claim when the send hit its deadline, because the digest may still be delivered", async () => {
    const { svc, state } = serviceWith(() => Promise.reject(new OutboundSendDeadlineError(1000)))

    await expect(svc.runForGeoid(GEOID)).rejects.toMatchObject({ outboundSendDeadline: true })
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)
  })

  it("logs a failed claim release instead of swallowing it, and still surfaces the send error", async () => {
    const { outreachRepo, mailRepo } = harness()
    const warn = vi.fn()
    const releaseFailure = new Error("db down")
    mailRepo.setOutreachState = () => Promise.reject(releaseFailure)
    const svc = makeOutreachService({
      outreachRepo,
      mailRepo,
      outboundMail: {
        sendToCity: () => Promise.reject(new Error("OCI mail transient 500")),
      } as unknown as OutboundMailService,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
      logger: { warn },
    })

    await expect(svc.runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ geoid: GEOID, err: releaseFailure }),
      expect.any(String),
    )
  })

  it("STILL releases the claim on a plain delivery failure (untagged error), so it retries", async () => {
    const { svc, state } = serviceWith(() => Promise.reject(new Error("OCI mail transient 500")))

    await expect(svc.runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
    expect(state.get(GEOID)?.lastOutreachAt).toBeNull()
  })
})

describe("outreach sweep: per-run cap + coverage rotation (F112)", () => {
  function multiHarness() {
    const state = new Map<string, OutreachStateRecord>()
    const outreachRepo = new InMemoryOutreachRepository(state)
    const mailRepo = new InMemoryMailRepository(state)
    const mailer = new FlakyMailer()
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    for (const g of ["a", "b", "c"]) {
      outreachRepo.seedJurisdiction({ geoid: g, defaultEmail: `${g}@city.gov` })
      outreachRepo.seedReport({ geoid: g, category: "trash" })
    }
    state.set("a", { geoid: "a", lastOutreachAt: daysAgo(30), suppressed: false })
    state.set("b", { geoid: "b", lastOutreachAt: daysAgo(20), suppressed: false })
    state.set("c", { geoid: "c", lastOutreachAt: daysAgo(10), suppressed: false })
    const svc = makeOutreachService({
      outreachRepo,
      mailRepo,
      outboundMail,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
      sweepBatchSize: 2,
    })
    return { svc, state }
  }

  it("caps a run at sweepBatchSize, oldest-first, and leaves the rest for the next run", async () => {
    const { svc } = multiHarness()
    expect(svc.sweepBatchSize).toBe(2)

    const first = await svc.runSweep()
    expect(first.map((r) => r.geoid)).toEqual(["a", "b"])
    expect(first.every((r) => r.sent)).toBe(true)

    const second = await svc.runSweep()
    expect(second.map((r) => r.geoid)).toContain("c")
    expect(second.find((r) => r.geoid === "c")?.sent).toBe(true)
    for (const r of second) {
      if (r.geoid !== "c") expect(r.sent).toBe(false)
    }
  })

  it("never claims a suppressed jurisdiction into the sweep page (cap not wasted on it)", async () => {
    const { svc, state } = multiHarness()
    state.set("a", { geoid: "a", lastOutreachAt: null, suppressed: true })
    const results = await svc.runSweep()
    expect(results.map((r) => r.geoid)).toEqual(["b", "c"])
    expect(results.every((r) => r.sent)).toBe(true)
  })
})
