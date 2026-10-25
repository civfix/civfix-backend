// GH#224 / D2, D3: an account holder gets a broadcast's channels only where the host chose them and the
// broadcast's category allows them, with skipped channels recorded as prefs_off. Event changes and
// cancellations no longer bypass anything for account holders; guests keep the critical bypass.

import { beforeEach, describe, expect, it } from "vitest"
import type { BroadcastChannel, BroadcastKind } from "@civfix/contract"
import { FakeMailer } from "@civfix/seams"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../helpers/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import { makeBroadcastPipeline } from "../../src/services/host/broadcast-pipeline.js"
import { makeBroadcastInAppSender } from "../../src/services/host/broadcast-inapp-sender.js"
import { makeBroadcastEmailSender } from "../../src/services/host/broadcast-email-sender.js"
import type {
  BroadcastRecord,
  DeliveryClaim,
  DeliveryOutcome,
  EventBroadcastContext,
} from "../../src/services/host/broadcast-types.js"
import { flushNotificationDispatch } from "../helpers/notifications.js"
import {
  captureNotifications,
  OFF,
  type NotificationCapture,
} from "../helpers/notification-capture.js"

const NOW = new Date("2026-10-24T12:00:00Z")
const EVENT = "00000000-0000-4000-8000-0000000000ee"
const HOST = "00000000-0000-4000-8000-0000000000aa"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const C = "cccccccc-0000-4000-8000-000000000003"
const GUEST = "99999999-0000-4000-8000-000000000009"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 2,
  emailRatePerSec: 1000,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

const EVENT_CONTEXT: EventBroadcastContext = {
  cleanupId: EVENT,
  title: "Lake Balboa cleanup",
  pageSlug: null,
  scheduledAt: new Date("2026-11-01T17:00:00Z"),
  endsAt: null,
  timezone: "UTC",
  address: null,
  status: "upcoming",
  organizerUserId: HOST,
  organizationSuspended: false,
  replyTo: null,
  replyToVerified: false,
}

const SERVICE_LINE =
  'This is a service message about "Lake Balboa cleanup", an event you signed up for on civfix.'
const BYPASS_LINE = "You receive these even if you have turned off updates from this organizer."
const STOP_LINE = "Stop receiving messages about this event: https://civfix.org/unsubscribe?t="

let n: NotificationCapture
let repo: InMemoryBroadcastRepository
let mailer: FakeMailer

beforeEach(() => {
  n = captureNotifications(() => NOW)
  repo = new InMemoryBroadcastRepository()
  repo.seedEvent(EVENT_CONTEXT)
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  repo.seedMembers(EVENT, [{ userId: B }, { userId: C }])
  repo.seedGuests(EVENT, [{ guestId: GUEST, email: "guest@example.test", name: "Gus" }])
  mailer = new FakeMailer()
})

function record(kind: BroadcastKind, channels: BroadcastChannel[]): BroadcastRecord {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    cleanupId: EVENT,
    kind,
    subject: "Bring gloves",
    bodyMd: "See you at the meeting point.",
    ctaLabel: null,
    ctaUrl: null,
    channels,
    segment: { kind: "all_registered" },
  } as BroadcastRecord
}

let claimSeq = 0

function claim(
  channel: BroadcastChannel,
  who: { userId: string } | { guestId: string },
): DeliveryClaim {
  claimSeq += 1
  return {
    id: `claim-${claimSeq}`,
    chunkNo: 0,
    recipientKind: "userId" in who ? "member" : "guest",
    userId: "userId" in who ? who.userId : null,
    guestId: "guestId" in who ? who.guestId : null,
    channel,
    attempts: 1,
  }
}

function inApp() {
  return makeBroadcastInAppSender({
    repo,
    config: CONFIG,
    notifications: n.service,
    settingsRepo: n.settings,
    now: () => NOW,
  })
}

function email() {
  return makeBroadcastEmailSender({
    repo,
    config: CONFIG,
    mailer,
    settingsRepo: n.settings,
    cache: new InMemoryCacheClient(() => NOW.getTime()),
    mailDomain: "civfix.org",
    now: () => NOW,
  })
}

/** Runs the in-app lane for each member on in-app and push; returns each claim's outcome. */
async function runInAppAndPush(
  kind: BroadcastKind,
  channels: BroadcastChannel[],
  members: string[],
): Promise<Map<string, { inapp?: DeliveryOutcome; push?: DeliveryOutcome }>> {
  const claims = members.flatMap((userId) =>
    channels.filter((c) => c === "inapp" || c === "push").map((c) => claim(c, { userId })),
  )
  const outcomes: DeliveryOutcome[] = []
  await inApp().runInAppAndPush(record(kind, channels), EVENT_CONTEXT, claims, outcomes)
  await flushNotificationDispatch()
  const byMember = new Map<string, { inapp?: DeliveryOutcome; push?: DeliveryOutcome }>()
  for (const c of claims) {
    const entry = byMember.get(c.userId!) ?? {}
    entry[c.channel as "inapp" | "push"] = outcomes.find((o) => o.id === c.id)
    byMember.set(c.userId!, entry)
  }
  return byMember
}

async function runEmail(
  kind: BroadcastKind,
  recipients: Array<{ userId: string } | { guestId: string }>,
): Promise<Map<string, DeliveryOutcome | undefined>> {
  const claims = recipients.map((who) => claim("email", who))
  const outcomes: DeliveryOutcome[] = []
  await email().runEmail(record(kind, ["email"]), EVENT_CONTEXT, claims, outcomes)
  return new Map(claims.map((c) => [c.userId ?? c.guestId!, outcomes.find((o) => o.id === c.id)]))
}

function mailTo(address: string) {
  return mailer.sent.filter((m) => m.to === address && m.outbound !== undefined)
}

const SENT = { status: "sent" }
const PREFS_OFF = { status: "suppressed", suppressionReason: "prefs_off" }

describe("runInAppAndPush", () => {
  it("T16: each kind fans out with its notification type and category, never emailing", async () => {
    const expected: Array<[BroadcastKind, string, string | undefined]> = [
      ["host_broadcast", "event_broadcast", "hostAnnouncements"],
      ["thank_you", "event_broadcast", "hostAnnouncements"],
      ["announcement", "event_broadcast", "hostAnnouncements"],
      ["reminder", "cleanup_reminder", "events"],
      ["event_updated", "system", "events"],
      ["event_cancelled", "cleanup_cancelled", "events"],
      ["confirmation", "system", undefined],
      ["waitlist_promoted", "system", undefined],
    ]
    for (const [kind, type, category] of expected) {
      n.inputs.length = 0
      await runInAppAndPush(kind, ["inapp", "push"], [B])
      expect(n.inputs, kind).toHaveLength(1)
      const input = n.inputs[0]!.input
      expect(input.type, kind).toBe(type)
      expect(input.category, kind).toBe(category)
      expect(input.email, kind).toBe("never")
      expect(input.push, kind).toBe("auto")
    }
  })

  it('T17: a broadcast without the push channel fans out with push "never"', async () => {
    const outcomes = await runInAppAndPush("host_broadcast", ["inapp"], [B])
    expect(n.inputs[0]?.input.push).toBe("never")
    expect(outcomes.get(B)?.inapp).toMatchObject(SENT)
  })

  it("T18: Push unchecked skips only the push, recorded as prefs_off", async () => {
    await n.set(C, "hostAnnouncements", [true, false, false])
    const outcomes = await runInAppAndPush("host_broadcast", ["inapp", "push"], [B, C])
    expect(outcomes.get(B)).toMatchObject({ inapp: SENT, push: SENT })
    expect(n.pushesTo(B)).toHaveLength(1)
    expect(outcomes.get(C)).toMatchObject({ inapp: SENT, push: PREFS_OFF })
    expect(n.pushesTo(C)).toHaveLength(0)
  })

  it("T19: Events Off drops a cancellation's in-app and push, as prefs_off", async () => {
    await n.set(B, "events", OFF)
    const outcomes = await runInAppAndPush("event_cancelled", ["inapp", "push"], [B])
    expect(outcomes.get(B)).toMatchObject({ inapp: PREFS_OFF, push: PREFS_OFF })
    expect(n.rows(B)).toEqual([])
    expect(n.pushesTo(B)).toEqual([])
  })

  it("T20: an event change with Push unchecked skips the push", async () => {
    await n.set(B, "events", [true, false, true])
    const outcomes = await runInAppAndPush("event_updated", ["inapp", "push"], [B])
    expect(outcomes.get(B)).toMatchObject({ inapp: SENT, push: PREFS_OFF })
    expect(n.pushesTo(B)).toEqual([])
  })

  it("T21: a confirmation reaches a resident with every category Off", async () => {
    await n.setAll(B, OFF)
    const outcomes = await runInAppAndPush("confirmation", ["inapp", "push"], [B])
    expect(outcomes.get(B)).toMatchObject({ inapp: SENT, push: SENT })
    expect(n.rows(B)).toHaveLength(1)
    expect(n.pushesTo(B)).toHaveLength(1)
  })

  it("T22: quiet hours skip the push, recorded as prefs_off", async () => {
    repo.seedMembers(EVENT, [
      { userId: B, quietHours: { start: "11:00", end: "13:00", tz: "UTC" } },
    ])
    n.repo.prefs.set(B, {
      push: true,
      cleanupChat: true,
      reportUpdates: true,
      follows: true,
      mentions: true,
      postInteractions: true,
      hostBroadcasts: true,
      quietStart: "11:00",
      quietEnd: "13:00",
      tz: "UTC",
    })
    const outcomes = await runInAppAndPush("host_broadcast", ["inapp", "push"], [B])
    expect(outcomes.get(B)).toMatchObject({ inapp: SENT, push: PREFS_OFF })
    expect(n.pushesTo(B)).toEqual([])
  })
})

describe("runEmail", () => {
  it("T23: a host broadcast mails only the member with Email checked", async () => {
    await n.set(B, "hostAnnouncements", [true, true, true])
    const outcomes = await runEmail("host_broadcast", [{ userId: B }, { userId: C }])
    expect(mailTo(`${B}@example.test`)).toHaveLength(1)
    expect(outcomes.get(B)).toMatchObject(SENT)
    expect(mailTo(`${C}@example.test`)).toHaveLength(0)
    expect(outcomes.get(C)).toMatchObject(PREFS_OFF)
  })

  it("T24: a cancellation skips a member with Email unchecked and still mails a guest", async () => {
    await n.set(B, "events", [true, true, false])
    const outcomes = await runEmail("event_cancelled", [{ userId: B }, { guestId: GUEST }])
    expect(mailTo(`${B}@example.test`)).toHaveLength(0)
    expect(outcomes.get(B)).toMatchObject(PREFS_OFF)
    expect(mailTo("guest@example.test")).toHaveLength(1)
    expect(outcomes.get(GUEST)).toMatchObject(SENT)
  })

  it("T25: a reminder mails a member at the Events default", async () => {
    const outcomes = await runEmail("reminder", [{ userId: B }])
    expect(mailTo(`${B}@example.test`)).toHaveLength(1)
    expect(outcomes.get(B)).toMatchObject(SENT)
  })

  it("T26: a waitlist promotion mails a member with every category Off", async () => {
    await n.setAll(B, OFF)
    const outcomes = await runEmail("waitlist_promoted", [{ userId: B }])
    expect(mailTo(`${B}@example.test`)).toHaveLength(1)
    expect(outcomes.get(B)).toMatchObject(SENT)
  })

  it("T55: a member's change or cancellation email has the service footer with a stop link", async () => {
    await n.set(B, "events", [true, true, true])
    for (const kind of ["event_cancelled", "event_updated"] as const) {
      mailer.sent.length = 0
      await runEmail(kind, [{ userId: B }])
      const mails = mailTo(`${B}@example.test`)
      expect(mails, kind).toHaveLength(1)
      const text = mails[0]!.outbound!.text
      expect(text, kind).toContain(SERVICE_LINE)
      expect(text, kind).not.toContain(BYPASS_LINE)
      expect(text, kind).toContain(STOP_LINE)
    }
  })

  it("T56: a guest's change or cancellation email keeps today's footer", async () => {
    for (const kind of ["event_cancelled", "event_updated"] as const) {
      mailer.sent.length = 0
      await runEmail(kind, [{ guestId: GUEST }])
      const mails = mailTo("guest@example.test")
      expect(mails, kind).toHaveLength(1)
      const text = mails[0]!.outbound!.text
      expect(text, kind).toContain(`${SERVICE_LINE} ${BYPASS_LINE}`)
      expect(text, kind).not.toContain("Stop receiving messages about this event")
    }
  })
})

describe("makeBroadcastPipeline", () => {
  it("T27: an Off category drops one resident's in-app, push and email while another gets all three", async () => {
    await n.set(B, "hostAnnouncements", OFF)
    await n.set(C, "hostAnnouncements", [true, true, true])
    repo.notificationSettings = n.settings
    const config = { ...CONFIG }
    const service = makeBroadcastService({
      repo,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      config,
      mailer,
      enqueuePlan: () => Promise.resolve(),
      now: () => NOW,
    })
    const chunks: number[] = []
    const pipeline = makeBroadcastPipeline({
      repo,
      service,
      notifications: n.service,
      settingsRepo: n.settings,
      mailer,
      cache: new InMemoryCacheClient(() => NOW.getTime()),
      config,
      mailDomain: "civfix.org",
      enqueueChunk: (_id, chunkNo) => {
        chunks.push(chunkNo)
        return Promise.resolve()
      },
      audit: () => Promise.resolve(),
      now: () => NOW,
    })
    const created = await repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Bring gloves",
      bodyMd: "See you at the meeting point.",
      segment: { kind: "all_registered" },
      channels: ["inapp", "push", "email"],
    })
    await repo.transition(created.id, ["draft"], "sending", { startedAt: NOW })
    expect((await pipeline.plan(created.id)).kind).toBe("planned")
    for (const chunkNo of chunks) await pipeline.runChunk(created.id, chunkNo)
    await flushNotificationDispatch()

    expect(n.rows(B)).toEqual([])
    expect(n.pushesTo(B)).toEqual([])
    expect(mailTo(`${B}@example.test`)).toEqual([])
    const bDeliveries = repo.allDeliveries().filter((d) => d.userId === B)
    expect(bDeliveries.filter((d) => d.status === "failed" || d.status === "pending")).toEqual([])

    expect(n.rows(C)).toHaveLength(1)
    expect(n.pushesTo(C)).toHaveLength(1)
    expect(mailTo(`${C}@example.test`)).toHaveLength(1)
    expect((await repo.findById(created.id))?.failedCount).toBe(0)
  })
})
