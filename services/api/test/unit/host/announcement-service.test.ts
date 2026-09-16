import { beforeEach, describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import {
  ANNOUNCEMENT_BROADCAST_KIND,
  MAX_EVENT_ANNOUNCEMENTS_PER_DAY,
  type OrganizationRefDTO,
  type PersonDTO,
} from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../../src/services/host/broadcast-repository.memory.js"
import {
  BroadcastCapError,
  makeBroadcastService,
  type BroadcastConfig,
  type BroadcastService,
} from "../../../src/services/host/broadcast-service.js"
import {
  announcementTitleOf,
  makeAnnouncementService,
  type AnnouncementService,
} from "../../../src/services/host/announcement-service.js"
import type { AnnouncementIdentityRepository } from "../../../src/services/host/announcement-repository.drizzle.js"
import type { EventBroadcastContext } from "../../../src/services/host/broadcast-types.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const SLOT = "00000000-0000-0000-0000-0000000000s1".replace("s1", "0f1")

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
  title: "Beach Cleanup",
  pageSlug: "beach-cleanup",
  scheduledAt: new Date("2026-02-01T17:00:00Z"),
  endsAt: null,
  timezone: "America/Los_Angeles",
  address: "Ocean Ave",
  status: "upcoming",
  organizerUserId: HOST,
  organizationSuspended: false,
  replyTo: null,
  replyToVerified: false,
}

const AUTHOR: PersonDTO = {
  id: HOST,
  name: "Hana Host",
  handle: "hana",
  bio: null,
  avatar: ["#000000", "#ffffff"],
  followers: 0,
  following: 0,
  isFollowing: false,
}

const ORG: OrganizationRefDTO = {
  id: "00000000-0000-0000-0000-0000000000cc",
  slug: "ballona",
  name: "Ballona Creek Trust",
  logoUrl: null,
  verified: true,
  verifiedKind: null,
}

function identities(org: OrganizationRefDTO | null = ORG): AnnouncementIdentityRepository {
  return {
    authorsFor: (ids) =>
      Promise.resolve(new Map(ids.filter((id) => id === HOST).map(() => [HOST, AUTHOR]))),
    organizationFor: () => Promise.resolve(org),
  }
}

interface Harness {
  repo: InMemoryBroadcastRepository
  plans: string[]
  service: AnnouncementService
  broadcasts: BroadcastService
  clock: { at: Date }
}

function harness(over: { org?: OrganizationRefDTO | null } = {}): Harness {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent(EVENT_CONTEXT)
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  repo.seedMembers(EVENT, [{ userId: HOST }])
  repo.seedGuests(EVENT, [])
  const clock = { at: new Date("2026-01-20T12:00:00.000Z") }
  const plans: string[] = []
  const broadcasts = makeBroadcastService({
    repo,
    counters: new InMemoryCounterStore(() => clock.at.getTime()),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan: (broadcastId) => {
      plans.push(broadcastId)
      return Promise.resolve()
    },
    now: () => clock.at,
  })
  const service = makeAnnouncementService({
    repo,
    identities: identities(over.org === undefined ? ORG : over.org),
    broadcasts,
    config: CONFIG,
    now: () => clock.at,
  })
  return { repo, plans, service, broadcasts, clock }
}

async function sendRegularBroadcast(h: Harness, subject: string): Promise<void> {
  const draft = await h.repo.create({
    cleanupId: EVENT,
    createdBy: HOST,
    kind: "host_broadcast",
    subject,
    bodyMd: "Body",
    segment: { kind: "all_registered" },
    channels: ["email"],
    status: "draft",
  })
  await h.broadcasts.send(EVENT, HOST, draft.id)
}

async function capKindOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return "none"
  } catch (err) {
    return err instanceof BroadcastCapError ? err.kind : `other:${String(err)}`
  }
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe("announcementTitleOf", () => {
  it("keeps a host-written title", () => {
    expect(announcementTitleOf("  Pizza is here  ", "Beach Cleanup")).toBe("Pizza is here")
  })

  it("derives one from the event when the host left it blank", () => {
    expect(announcementTitleOf(null, "Beach Cleanup")).toBe("Announcement · Beach Cleanup")
    expect(announcementTitleOf("   ", "Beach Cleanup")).toBe("Announcement · Beach Cleanup")
  })
})

describe("createEventAnnouncement", () => {
  it("writes an announcement broadcast, sends it immediately, and enqueues the existing plan job", async () => {
    const dto = await h.service.create(EVENT, HOST, {
      id: EVENT,
      title: "Pizza is here",
      bodyMd: "Meet at the pavilion.",
      audience: { kind: "all_registered" },
    })

    const record = await h.repo.findForEvent(EVENT, dto.id)
    expect(record?.kind).toBe(ANNOUNCEMENT_BROADCAST_KIND)
    expect(record?.status).toBe("sending")
    expect(record?.channels).toEqual(["inapp", "push", "email"])
    expect(h.plans).toEqual([dto.id])
    expect(dto.title).toBe("Pizza is here")
    expect(dto.bodyMd).toBe("Meet at the pavilion.")
  })

  it("maps every audience option straight onto the existing broadcast segment union", async () => {
    const audiences = [
      { kind: "all_registered" as const },
      { kind: "checked_in" as const },
      { kind: "not_checked_in" as const },
      { kind: "waitlist" as const },
      { kind: "slots" as const, ids: [SLOT] },
    ]
    for (const audience of audiences) {
      const dto = await h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: "Body",
        audience,
      })
      const record = await h.repo.findForEvent(EVENT, dto.id)
      expect(record?.segment).toEqual(audience)
      expect(dto.audience).toEqual(audience)
    }
  })

  it("derives the subject from the event title when none was given", async () => {
    const dto = await h.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "Body",
      audience: { kind: "all_registered" },
    })
    expect(dto.title).toBe("Announcement · Beach Cleanup")
  })

  it("attaches the announcement deep link as the email CTA", async () => {
    const dto = await h.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "Body",
      audience: { kind: "all_registered" },
    })
    const record = await h.repo.findForEvent(EVENT, dto.id)
    expect(record?.ctaUrl).toBe(`https://civfix.org/cleanups/${EVENT}/announcements/${dto.id}`)
    expect(record?.ctaLabel).toBe("View announcement")
  })

  it(`rate-limits at ${MAX_EVENT_ANNOUNCEMENTS_PER_DAY} per event per rolling 24h`, async () => {
    for (let i = 0; i < MAX_EVENT_ANNOUNCEMENTS_PER_DAY; i += 1) {
      await h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: `Body ${i}`,
        audience: { kind: "all_registered" },
      })
    }

    await expect(
      h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: "One too many",
        audience: { kind: "all_registered" },
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("lets the host announce again once the 24h window has rolled past", async () => {
    for (let i = 0; i < MAX_EVENT_ANNOUNCEMENTS_PER_DAY; i += 1) {
      const dto = await h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: `Body ${i}`,
        audience: { kind: "all_registered" },
      })
      h.repo.forceCreatedAt(dto.id, new Date("2026-01-19T00:00:00.000Z"))
    }

    await expect(
      h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: "A new day",
        audience: { kind: "all_registered" },
      }),
    ).resolves.toMatchObject({ bodyMd: "A new day" })
  })

  it("is not blocked by the regular-broadcast cooldown", async () => {
    await h.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "First",
      audience: { kind: "all_registered" },
    })

    await expect(
      h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: "Second, minutes later",
        audience: { kind: "all_registered" },
      }),
    ).resolves.toMatchObject({ bodyMd: "Second, minutes later" })
  })

  it("does not consume the event's regular-broadcast daily slots", async () => {
    for (let i = 0; i < CONFIG.perEventPerDay + 2; i += 1) {
      await h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: `Body ${i}`,
        audience: { kind: "all_registered" },
      })
    }

    expect(await capKindOf(() => sendRegularBroadcast(h, "Still allowed"))).toBe("none")
  })

  it("leaves the regular-broadcast cooldown and per-event cap intact for host broadcasts", async () => {
    await h.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "Announcement first",
      audience: { kind: "all_registered" },
    })

    expect(await capKindOf(() => sendRegularBroadcast(h, "One"))).toBe("none")
    expect(await capKindOf(() => sendRegularBroadcast(h, "Two"))).toBe("cooldown")
  })

  it("still refuses a host broadcast that exhausts the per-event daily cap", async () => {
    const noCooldown = harness()
    for (let i = 0; i < CONFIG.perEventPerDay; i += 1) {
      noCooldown.clock.at = new Date(Date.UTC(2026, 0, 20, 12 + i))
      expect(await capKindOf(() => sendRegularBroadcast(noCooldown, `Body ${i}`))).toBe("none")
    }
    noCooldown.clock.at = new Date(Date.UTC(2026, 0, 20, 12 + CONFIG.perEventPerDay))

    expect(await capKindOf(() => sendRegularBroadcast(noCooldown, "One too many"))).toBe(
      "per_event_per_day",
    )
    await expect(
      noCooldown.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: "Announcements are a separate lane",
        audience: { kind: "all_registered" },
      }),
    ).resolves.toMatchObject({ bodyMd: "Announcements are a separate lane" })
  })

  it("leaves no orphan draft behind when the send is refused", async () => {
    const suspended = harness()
    suspended.repo.seedHost(HOST, {
      accountCreatedAt: new Date("2020-01-01T00:00:00Z"),
      suspended: true,
    })

    await expect(
      suspended.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: "Body",
        audience: { kind: "all_registered" },
      }),
    ).rejects.toBeTruthy()

    const { items } = await suspended.service.list(EVENT, { id: EVENT }, { host: true })
    expect(items).toHaveLength(0)
    expect(await suspended.repo.countAnnouncementsSince(EVENT, new Date(0))).toBe(0)
  })
})

describe("announcement projections", () => {
  async function seeded(): Promise<string> {
    const dto = await h.service.create(EVENT, HOST, {
      id: EVENT,
      title: "Pizza is here",
      bodyMd: "Meet at the pavilion.",
      audience: { kind: "checked_in" },
    })
    return dto.id
  }

  it("gives a host the audience and the delivery counts", async () => {
    const id = await seeded()
    const dto = await h.service.get(EVENT, id, { host: true })
    expect(dto.audience).toEqual({ kind: "checked_in" })
    expect(dto).toMatchObject({ recipientCount: 0, sentCount: 0, failedCount: 0 })
  })

  it("omits audience and counts entirely from the public projection", async () => {
    const id = await seeded()
    const dto = await h.service.get(EVENT, id, { host: false })
    expect(dto).not.toHaveProperty("audience")
    expect(dto).not.toHaveProperty("recipientCount")
    expect(dto).not.toHaveProperty("sentCount")
    expect(dto).not.toHaveProperty("failedCount")
    expect(dto.bodyMd).toBe("Meet at the pavilion.")
  })

  it("hydrates the author and the hosting organization on both projections", async () => {
    const id = await seeded()
    for (const host of [true, false]) {
      const dto = await h.service.get(EVENT, id, { host })
      expect(dto.author?.handle).toBe("hana")
      expect(dto.authorOrg?.slug).toBe("ballona")
    }
  })

  it("returns a null org for an event nobody hosts as an organization", async () => {
    const solo = harness({ org: null })
    const dto = await solo.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "Body",
      audience: { kind: "all_registered" },
    })
    expect(dto.authorOrg).toBeNull()
  })
})

describe("listEventAnnouncements", () => {
  it("returns announcements newest-first and never other broadcast kinds", async () => {
    await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Not an announcement",
      bodyMd: "Body",
      segment: { kind: "all_registered" },
      channels: ["email"],
      status: "sent",
    })
    const first = await h.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "First",
      audience: { kind: "all_registered" },
    })
    h.repo.forceCreatedAt(first.id, new Date("2026-01-20T12:00:00.000Z"))
    const second = await h.service.create(EVENT, HOST, {
      id: EVENT,
      bodyMd: "Second",
      audience: { kind: "all_registered" },
    })
    h.repo.forceCreatedAt(second.id, new Date("2026-01-20T13:00:00.000Z"))

    const { items, nextCursor } = await h.service.list(EVENT, { id: EVENT }, { host: true })
    expect(items.map((item) => item.id)).toEqual([second.id, first.id])
    expect(nextCursor).toBeNull()
  })

  it("pages with a cursor and stops without one on the last page", async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const dto = await h.service.create(EVENT, HOST, {
        id: EVENT,
        bodyMd: `Body ${i}`,
        audience: { kind: "all_registered" },
      })
      h.repo.forceCreatedAt(dto.id, new Date(Date.UTC(2026, 0, 20, 12 + i)))
      ids.push(dto.id)
    }

    const page1 = await h.service.list(EVENT, { id: EVENT, limit: 2 }, { host: true })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await h.service.list(
      EVENT,
      { id: EVENT, limit: 2, cursor: page1.nextCursor as string },
      { host: true },
    )
    expect(page2.items.map((item) => item.id)).toEqual([ids[0]])
    expect(page2.nextCursor).toBeNull()
  })

  it("404s an announcement id that belongs to a different event", async () => {
    await expect(
      h.service.get(EVENT, "00000000-0000-0000-0000-00000000dead", { host: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
