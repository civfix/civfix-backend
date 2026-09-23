/**
 * The guest half of waitlist promotion.
 *
 * A guest has no account, so `notification_prefs`, the bell and push are all unreachable for them: the
 * ONLY way a promoted guest can learn a place opened up is this email. Before this seam existed the
 * waitlist service returned early on `userId === null` and a promoted guest was told nothing at all,
 * so the 24 h claim hold expired in silence.
 *
 * What is pinned here is mostly the REFUSALS: a guest whose contact was scrubbed, cancelled or never
 * collected (the SMS channel) must not be mailed, and a missing row must not throw into the promoter.
 */

import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryGuestRsvpRepository, type StoredGuest } from "../helpers/guest-rsvp.js"
import { makeGuestPromotionNotifier, guestEventLink } from "../../src/services/guest-notify.js"
import { formatEventWhen } from "../../src/services/host/broadcast-render.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
const SCHEDULED_AT = new Date(Date.parse("2026-09-05T17:00:00.000Z"))

function harness(over: Partial<StoredGuest> = {}): {
  repo: InMemoryGuestRsvpRepository
  mailer: FakeMailer
  guestId: string
  notify(guestId: string): Promise<void>
} {
  const repo = new InMemoryGuestRsvpRepository()
  repo.seedEvent({
    id: EVENT_ID,
    title: "Beach cleanup",
    scheduledAt: SCHEDULED_AT,
    timezone: "America/Los_Angeles",
  })
  const guestId = randomUUID()
  repo.guests.push({
    id: guestId,
    cleanupId: EVENT_ID,
    name: "Ada Lovelace",
    channel: "email",
    email: "ada@example.org",
    phone: null,
    contactKey: "ada@example.org",
    manageTokenHash: "hash",
    verifiedAt: new Date(),
    cancelledAt: null,
    contactScrubbedAt: null,
    createdAt: new Date(),
    ...over,
  })
  const mailer = new FakeMailer()
  const notifier = makeGuestPromotionNotifier({
    repo,
    mailer,
    linkBase: "https://civfix.org",
  })
  return { repo, mailer, guestId, notify: (id) => notifier.notifyGuestPromoted(id) }
}

describe("guest waitlist promotion notice", () => {
  it("emails the promoted guest with the title, the local time and the event link", async () => {
    const h = harness()
    await h.notify(h.guestId)

    expect(h.mailer.sent).toHaveLength(1)
    const mail = h.mailer.sent[0]
    expect(mail?.to).toBe("ada@example.org")
    expect(mail?.template).toBe("guest_promoted")
    expect(String(mail?.vars?.title)).toBe("Beach cleanup")
    const when = String(mail?.vars?.when)
    expect(when).toBe(formatEventWhen(SCHEDULED_AT, "America/Los_Angeles"))
    expect(when).toContain("10:00 AM PDT")
    expect(mail?.vars?.eventUrl).toBe(guestEventLink("https://civfix.org", EVENT_ID))
  })

  it("prints Pacific Time when the event carries no timezone, never a raw ISO stamp", async () => {
    const h = harness()
    h.repo.seedEvent({ id: EVENT_ID, scheduledAt: SCHEDULED_AT, timezone: null })
    await h.notify(h.guestId)

    const when = String(h.mailer.sent[0]?.vars?.when)
    expect(when).toContain("10:00 AM PDT")
    expect(when).not.toContain("2026-09-05T17:00:00.000Z")
  })

  it("never leaks the manage token: the link is the public event page", async () => {
    const h = harness()
    await h.notify(h.guestId)
    expect(JSON.stringify(h.mailer.sent[0]?.vars)).not.toContain("token=")
  })

  it("sends nothing to an SMS-channel guest, who has no address to mail", async () => {
    const h = harness({ channel: "sms", email: null, phone: "+15552223333" })
    await h.notify(h.guestId)
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("sends nothing to a cancelled guest", async () => {
    const h = harness({ cancelledAt: new Date() })
    await h.notify(h.guestId)
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("sends nothing once the retention sweep has scrubbed the contact", async () => {
    const h = harness({ contactScrubbedAt: new Date() })
    await h.notify(h.guestId)
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("is a no-op for a guest row that is gone, rather than throwing into the promoter", async () => {
    const h = harness()
    await expect(h.notify(randomUUID())).resolves.toBeUndefined()
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("is a no-op when the event itself has vanished", async () => {
    const h = harness()
    h.repo.events.clear()
    await expect(h.notify(h.guestId)).resolves.toBeUndefined()
    expect(h.mailer.sent).toHaveLength(0)
  })
})
