import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeAbuseChecks, FakeMailer, FakeSmsSender } from "@civfix/shared/fakes"
import type { GuestRsvpRequestRequest, GuestRsvpVerifyRequest } from "@civfix/shared"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryGuestRsvpRepository } from "../helpers/guest-rsvp.js"
import {
  makeGuestRsvpService,
  type GuestRsvpService,
} from "../../src/services/guest-rsvp-service.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
const CODE = "424242"
const ctx = { ip: "203.0.113.10" }

interface Harness {
  service: GuestRsvpService
  repo: InMemoryGuestRsvpRepository
  mailer: FakeMailer
}

function build(): Harness {
  const clock = Date.parse("2026-08-25T12:00:00.000Z")
  const now = (): number => clock
  const repo = new InMemoryGuestRsvpRepository({ now })
  repo.seedEvent({ id: EVENT_ID, title: "Quiet private cleanup" })
  const mailer = new FakeMailer()
  const service = makeGuestRsvpService({
    repo,
    mailer,
    smsSender: new FakeSmsSender(),
    abuseChecks: new FakeAbuseChecks(),
    cache: new InMemoryCacheClient(now),
    counters: new InMemoryCounterStore(now),
    requireGuestContact: () => Promise.resolve(),
    smsGuestEnabled: false,
    smsDailyCap: 50,
    manageLinkBase: "https://civfix.org",
    now,
    newCode: () => CODE,
    newToken: () => `manage-token-${randomUUID()}`,
  })
  return { service, repo, mailer }
}

function emailRequest(id: string): GuestRsvpRequestRequest {
  return {
    id,
    name: "Ada Lovelace",
    channel: "email",
    email: "ada@example.org",
    turnstileToken: "ok",
  } as GuestRsvpRequestRequest
}

function emailVerify(id: string): GuestRsvpVerifyRequest {
  return { id, channel: "email", email: "ada@example.org", code: CODE } as GuestRsvpVerifyRequest
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (err) {
    const { code, message } = err as { code: string; message: string }
    return { code, message }
  }
  throw new Error("expected the call to reject")
}

describe("guest rsvp on a private event", () => {
  let h: Harness
  beforeEach(() => {
    h = build()
  })

  it("answers a code request exactly like an unknown event and sends nothing", async () => {
    const unknown = await rejectionOf(h.service.requestCode(emailRequest(randomUUID()), ctx))
    h.repo.seedEvent({ id: EVENT_ID, visibility: "private" })

    const hidden = await rejectionOf(h.service.requestCode(emailRequest(EVENT_ID), ctx))

    expect(unknown.code).toBe("NOT_FOUND")
    expect(hidden).toEqual(unknown)
    expect(h.mailer.sent).toHaveLength(0)
    expect(h.repo.otps).toHaveLength(0)
  })

  it("does not reveal that a private event was cancelled or has ended", async () => {
    const unknown = await rejectionOf(h.service.requestCode(emailRequest(randomUUID()), ctx))

    h.repo.seedEvent({ id: EVENT_ID, visibility: "private", status: "cancelled" })
    await expect(rejectionOf(h.service.requestCode(emailRequest(EVENT_ID), ctx))).resolves.toEqual(
      unknown,
    )

    h.repo.seedEvent({
      id: EVENT_ID,
      visibility: "private",
      scheduledAt: new Date(Date.parse("2026-08-24T09:00:00.000Z")),
      endsAt: new Date(Date.parse("2026-08-24T12:00:00.000Z")),
    })
    await expect(rejectionOf(h.service.verifyCode(emailVerify(EVENT_ID), ctx))).resolves.toEqual(
      unknown,
    )
  })

  it("refuses to verify a code once the event has gone private since the request", async () => {
    await h.service.requestCode(emailRequest(EVENT_ID), ctx)
    h.repo.seedEvent({ id: EVENT_ID, visibility: "private" })

    const unknown = await rejectionOf(h.service.verifyCode(emailVerify(randomUUID()), ctx))
    const hidden = await rejectionOf(h.service.verifyCode(emailVerify(EVENT_ID), ctx))

    expect(hidden).toEqual(unknown)
    expect(h.repo.guests).toHaveLength(0)
  })

  it("still lets an existing guest cancel after the event went private", async () => {
    await h.service.requestCode(emailRequest(EVENT_ID), ctx)
    const { manageToken } = await h.service.verifyCode(emailVerify(EVENT_ID), ctx)
    h.repo.seedEvent({ id: EVENT_ID, visibility: "private" })

    await expect(h.service.cancelRsvp(manageToken)).resolves.toEqual({ ok: true })
    expect(h.repo.guests[0]?.cancelledAt).not.toBeNull()
  })

  it("keeps unlisted events joinable by link", async () => {
    h.repo.seedEvent({ id: EVENT_ID, visibility: "unlisted" })

    await expect(h.service.requestCode(emailRequest(EVENT_ID), ctx)).resolves.toMatchObject({
      sent: true,
    })
  })
})
