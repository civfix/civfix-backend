import { describe, expect, it } from "vitest"
import { FakeAbuseChecks, FakeMailer, FakeSmsSender } from "@civfix/shared/fakes"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { smsFailure } from "../../src/errors/sms-failure.js"
import { InMemoryGuestRsvpRepository } from "../helpers/guest-rsvp.js"
import { makeGuestRsvpService } from "../../src/services/guest-rsvp-service.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
const PHONE = "+15552223333"
const CODE = "424242"
const ctx = { ip: "203.0.113.10" }

describe("guest sms notice: a failed opt-out write is not silent", () => {
  it("logs the opt-out write failure with the guest id and still completes the notice", async () => {
    const now = (): number => Date.parse("2026-08-25T12:00:00.000Z")
    const repo = new InMemoryGuestRsvpRepository({ now })
    repo.seedEvent({ id: EVENT_ID, title: "Beach cleanup" })
    const sms = new FakeSmsSender()
    const warnings: { obj: unknown; msg: string | undefined }[] = []
    const service = makeGuestRsvpService({
      repo,
      mailer: new FakeMailer(),
      smsSender: sms,
      abuseChecks: new FakeAbuseChecks(),
      cache: new InMemoryCacheClient(now),
      counters: new InMemoryCounterStore(now),
      requireGuestContact: () => Promise.resolve(),
      smsGuestEnabled: true,
      smsDailyCap: 50,
      manageLinkBase: "https://civfix.org",
      now,
      newCode: () => CODE,
      logger: {
        warn: (obj, msg) => warnings.push({ obj, msg }),
        info: () => undefined,
        error: () => undefined,
      },
    })
    await service.requestCode(
      {
        id: EVENT_ID,
        name: "Ada",
        channel: "sms",
        phone: PHONE,
        turnstileToken: "ok",
      },
      ctx,
    )
    await service.verifyCode({ id: EVENT_ID, channel: "sms", phone: PHONE, code: CODE }, ctx)
    const guestId = repo.guests[0]?.id
    const writeFailed = new Error("db down")
    sms.send = () => Promise.reject(smsFailure("opted_out", "recipient opted out"))
    repo.recordPhoneOptOut = () => Promise.reject(writeFailed)
    warnings.length = 0

    await expect(service.notifyGuestsBySms(EVENT_ID, "cancelled")).resolves.toBe(0)

    expect(warnings.map((w) => w.obj)).toContainEqual({
      err: writeFailed,
      cleanupId: EVENT_ID,
      guestId,
    })
  })
})
