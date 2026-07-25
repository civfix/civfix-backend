import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { OutboundEmail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryOutreachRepository } from "../../src/services/admin/outreach-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import {
  makeOutreachService,
  type OutreachService,
} from "../../src/services/admin/outreach-service.js"
import type { OutreachStateRecord } from "../../src/services/admin/mail-repository.js"

/**
 * The outreach digest's ATOMIC SEND-WINDOW CLAIM and — the part that had no coverage at all — its RELEASE.
 *
 * The claim stamps `outreach_state.last_outreach_at` BEFORE sendDigest, because that stamp IS the
 * concurrency guard. The consequence was that a transient mailer outage burned the whole throttle window:
 * the jurisdiction got no digest for `throttleDays` and nothing retried. The service now restores the prior
 * timestamp when the send throws, so the next cron tick tries again.
 *
 * Neither half was testable offline: `InMemoryOutreachRepository` did not implement claimOutreachWindow, so
 * the claim branch had NO offline binding and every test that reached it had to hand-roll a stub. The fake
 * now implements it against the same `outreach_state` map the mail repo reads (production has one table), so
 * these tests exercise the real claim/release interaction. The stub-based cases below pin the ORDERING
 * (claim before send) and the throwing-mailer path, which a shared-state fake cannot observe on its own.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")
const THROTTLE_DAYS = 7
const WINDOW_MS = THROTTLE_DAYS * 24 * 60 * 60 * 1000
const GEOID = "0644000"
const CONTACT = "clerk@lacity.gov"
const FROM_OUTREACH = "outreach@civfix.org"

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

/** A Mailer that rejects its first `failures` outbound sends, then behaves like FakeMailer. */
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

/** The claim, narrowed to non-optional (the seam member is optional; the harness always supplies it). */
type Claim = (geoid: string, window: { at: Date; windowStart: Date }) => Promise<boolean>

interface Harness {
  outreachRepo: InMemoryOutreachRepository
  mailRepo: InMemoryMailRepository
  mailer: FlakyMailer
  /** The single shared outreach_state store both repos read/write, as in production. */
  state: Map<string, OutreachStateRecord>
  svc: OutreachService
  claim: Claim
}

/** Both repos over ONE outreach_state map, with a waiting report + a routing contact seeded. */
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
  // The fake exposes claimOutreachWindow only when built with the shared store, which harness() always
  // does; narrow it once here so the tests below are not littered with optional-call guards.
  const claim = outreachRepo.claimOutreachWindow
  if (claim === undefined) {
    throw new Error("harness must construct InMemoryOutreachRepository with the shared outreach_state map")
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
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW) // the winner's stamp stands
  })

  it("WINS again once the previous send falls outside the window", async () => {
    const { claim, state } = harness()
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: daysAgo(THROTTLE_DAYS + 1), suppressed: false })
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

    // …and the window now blocks a second run in the same tick.
    const again = await svc.runForGeoid(GEOID)
    expect(again).toMatchObject({ sent: false, skipped: "throttled" })
    expect(mailer.sent).toHaveLength(1)
  })

  it("RESTORES lastOutreachAt to null when the mailer throws, so the next tick retries", async () => {
    const { svc, mailer, mailRepo, state } = harness()
    mailer.failures = 1

    await expect(svc.runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
    // The claim was taken (it must be, or the guard is not a guard) and then RELEASED: without the release
    // this reads NOW and the jurisdiction is silent for the full 7-day window.
    expect(state.get(GEOID)?.lastOutreachAt).toBeNull()
    // The failed attempt is still on the record (a 'failed' mail_events row), so nothing is hidden.
    expect(mailRepo.events.map((e) => e.type)).toEqual(["failed"])

    // The retry actually goes out — the whole point of releasing the claim.
    const retry = await svc.runForGeoid(GEOID)
    expect(retry).toMatchObject({ sent: true, reportCount: 1 })
    expect(mailer.sent).toHaveLength(1)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(NOW)
  })

  it("restores the PRIOR timestamp (not null) when one existed before the claim", async () => {
    const { svc, mailer, state } = harness()
    const prior = daysAgo(THROTTLE_DAYS + 2) // outside the window, so the run is allowed
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
    // A concurrent tick claimed the window a second ago, so the service's own isThrottled pre-check (which
    // reads the same outreach_state through mailRepo) stops this run before the claim is even attempted.
    const stolenAt = new Date(NOW.getTime() - 1000)
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: stolenAt, suppressed: false })

    const result = await svc.runForGeoid(GEOID)
    expect(result).toMatchObject({ sent: false, skipped: "throttled" })
    expect(mailer.sent).toHaveLength(0)
    expect(state.get(GEOID)?.lastOutreachAt).toEqual(stolenAt)
  })

  /**
   * The REAL race the claim exists for: the pre-check passed (the stored stamp is outside the window) and
   * the competing run committed its claim in between. The loser must not send AND must not "release" — the
   * release restores the timestamp the claim replaced, so running it on a lost claim would hand the winner's
   * window back and let a second digest go out. Needs a stub, because a single shared map cannot represent
   * "stale pre-check read, fresh row at claim time".
   */
  it("does NOT send and does NOT release when the claim is LOST mid-flight", async () => {
    const { outreachRepo, mailRepo, mailer, state } = harness()
    const priorAt = daysAgo(THROTTLE_DAYS + 2)
    state.set(GEOID, { geoid: GEOID, lastOutreachAt: priorAt, suppressed: false })
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    // The competing run wins: our claim returns false and (like the SQL) writes nothing.
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
    // The winner's stamp survives: no release rolled it back to the stale pre-check value.
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
