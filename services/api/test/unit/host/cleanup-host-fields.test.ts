import { beforeEach, describe, expect, it } from "vitest"
import type { CreateCleanupRequest } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryCleanupRepository } from "../../helpers/cleanups.js"
import {
  HOST_EVENTS_PER_DAY,
  HOST_ROSTER_READS_PER_HOUR,
  makeCleanupService,
  type CleanupService,
} from "../../../src/services/cleanup-service.js"

const ORG = "11111111-1111-4111-8111-111111111111"
const COHOST = "22222222-2222-4222-8222-222222222222"
const STAFF = "33333333-3333-4333-8333-333333333333"
const OUTSIDER = "44444444-4444-4444-8444-444444444444"
const ORG_OWNER = "55555555-5555-4555-8555-555555555555"

let repo: InMemoryCleanupRepository
let service: CleanupService
let audits: { action: string; target: string }[]

function base(over: Partial<CreateCleanupRequest> = {}): CreateCleanupRequest {
  return {
    title: "Beach cleanup",
    type: "site",
    eventKind: "cleanup",
    lat: 34.0,
    lng: -118.49,
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  } as CreateCleanupRequest
}

function makeService(): CleanupService {
  return makeCleanupService({
    repo,
    counters: new InMemoryCounterStore(),
    presignEventMedia: (key, opts) =>
      Promise.resolve(opts.forceSigned ? `signed://${key}` : `https://cdn.test/${key}`),
    audit: {
      record: (input) => {
        audits.push({ action: input.action, target: input.target })
        return Promise.resolve()
      },
    },
  })
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: COHOST, displayName: "Cody Cohost", handle: "cody" })
  repo.seedUser({ id: STAFF, displayName: "Sasha Staff", handle: "sasha" })
  repo.seedUser({ id: OUTSIDER, displayName: "Sam Outsider", handle: "sam" })
  repo.seedUser({ id: ORG_OWNER, displayName: "Ora Owner", handle: "ora" })
  audits = []
  service = makeService()
})

describe("createCleanup with host fields", () => {
  it("defaults to a public event with no host extras", async () => {
    const dto = await service.createCleanup(base(), ORG)
    expect(dto.visibility).toBe("public")
    expect(dto.endsAt).toBeNull()
    expect(dto.galleryUrls).toEqual([])
    expect(dto.coverUrl).toBeNull()
    expect(dto.myCapabilities).toContain("manage_event")
    expect(dto.myCapabilities).toContain("cancel_event")
  })

  it("stores the window, timezone and visibility", async () => {
    const startsAt = new Date(Date.now() + 86_400_000)
    const dto = await service.createCleanup(
      base({
        scheduledAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3 * 3600_000).toISOString(),
        timezone: "America/Los_Angeles",
        visibility: "unlisted",
      }),
      ORG,
    )
    expect(dto.timezone).toBe("America/Los_Angeles")
    expect(dto.visibility).toBe("unlisted")
    expect(dto.endsAt).not.toBeNull()
  })

  it("422s an end time at or before the start", async () => {
    const startsAt = new Date(Date.now() + 86_400_000)
    await expect(
      service.createCleanup(
        base({ scheduledAt: startsAt.toISOString(), endsAt: startsAt.toISOString() }),
        ORG,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("422s a timezone that is not an IANA zone", async () => {
    await expect(
      service.createCleanup(base({ timezone: "Mars/Olympus" }), ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("422s a reminder offset outside the closed set, and a repeated one", async () => {
    await expect(
      service.createCleanup(base({ reminderOffsetsMinutes: [7] }), ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      service.createCleanup(base({ reminderOffsetsMinutes: [60, 60] }), ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    const ok = await service.createCleanup(base({ reminderOffsetsMinutes: [60, 1440] }), ORG)
    expect(ok.reminderOffsetsMinutes).toEqual([60, 1440])
  })

  it("422s a reserved page slug and 409s a taken one", async () => {
    await expect(service.createCleanup(base({ pageSlug: "admin" }), ORG)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    await service.createCleanup(base({ pageSlug: "beach-sweep" }), ORG)
    await expect(
      service.createCleanup(base({ pageSlug: "beach-sweep" }), ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("refuses an organization the host does not belong to", async () => {
    const org = repo.seedOrganization({ name: "Ballona Creek Trust" })
    await expect(
      service.createCleanup(base({ organizationId: org.id }), ORG),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("links an organization the host belongs to", async () => {
    const org = repo.seedOrganization({ slug: "bct", name: "Ballona Creek Trust" })
    repo.seedOrgMember(org.id, ORG, "admin")
    const dto = await service.createCleanup(base({ organizationId: org.id }), ORG)
    expect(dto.organization).toMatchObject({ id: org.id, slug: "bct", verified: false })
  })

  it("409s linking an operator-suspended organization, but leaves an existing link editable", async () => {
    const org = repo.seedOrganization({ slug: "bct", suspended: true })
    repo.seedOrgMember(org.id, ORG, "owner")
    await expect(
      service.createCleanup(base({ organizationId: org.id }), ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    org.suspended = false
    const created = await service.createCleanup(base({ organizationId: org.id }), ORG)
    org.suspended = true
    await expect(
      service.updateCleanup(created.id, { title: "Still editable" }, ORG),
    ).resolves.toMatchObject({ title: "Still editable" })
    await expect(
      service.updateCleanup(created.id, { organizationId: org.id, title: "Same org" }, ORG),
    ).resolves.toMatchObject({ title: "Same org" })
  })

  it("refuses to link an organization the host is only a plain member of", async () => {
    const org = repo.seedOrganization({ slug: "bct" })
    repo.seedOrgMember(org.id, ORG, "member")
    await expect(
      service.createCleanup(base({ organizationId: org.id }), ORG),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses a donation link from anyone but the organization owner", async () => {
    const org = repo.seedOrganization({
      slug: "bct",
      verifiedStatus: "verified",
      verifiedKind: "nonprofit",
    })
    repo.seedOrgMember(org.id, ORG, "admin")
    await expect(
      service.createCleanup(
        base({ organizationId: org.id, donationUrl: "https://give.example.org/bct" }),
        ORG,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses a donation link added later by a cohost with no organization standing", async () => {
    const org = repo.seedOrganization({
      slug: "bct",
      verifiedStatus: "verified",
      verifiedKind: "nonprofit",
    })
    repo.seedOrgMember(org.id, ORG, "owner")
    const created = await service.createCleanup(base({ organizationId: org.id }), ORG)
    repo.seedMember(created.id, COHOST, "cohost")
    await expect(
      service.updateCleanup(
        created.id,
        { donationUrl: "https://give.example.org/bct" },
        COHOST,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      service.updateCleanup(created.id, { donationUrl: "https://give.example.org/bct" }, ORG),
    ).resolves.toMatchObject({ donationUrl: "https://give.example.org/bct" })
  })

  it("refuses a donation link unless the organization is a verified nonprofit", async () => {
    const org = repo.seedOrganization({ slug: "bct" })
    repo.seedOrgMember(org.id, ORG, "owner")
    await expect(
      service.createCleanup(
        base({ organizationId: org.id, donationUrl: "https://give.example.org/bct" }),
        ORG,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    repo.seedOrganization({ ...org, verifiedStatus: "verified", verifiedKind: "government" })
    await expect(
      service.createCleanup(
        base({ organizationId: org.id, donationUrl: "https://give.example.org/bct" }),
        ORG,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    repo.seedOrganization({ ...org, verifiedStatus: "verified", verifiedKind: "nonprofit" })
    const dto = await service.createCleanup(
      base({ organizationId: org.id, donationUrl: "https://give.example.org/bct" }),
      ORG,
    )
    expect(dto.donationUrl).toBe("https://give.example.org/bct")
  })

  it("replays an idempotent create instead of making a second event", async () => {
    const input = base({ idempotencyKey: "create-key-0001" })
    const first = await service.createCleanup(input, ORG)
    const second = await service.createCleanup(input, ORG)
    expect(second.id).toBe(first.id)
    expect(repo.cleanups.size).toBe(1)
  })

  it(`caps a host at ${HOST_EVENTS_PER_DAY} events a day`, async () => {
    for (let i = 0; i < HOST_EVENTS_PER_DAY; i += 1) {
      await service.createCleanup(base({ title: `Event ${i}` }), ORG)
    }
    await expect(service.createCleanup(base(), ORG)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })
})

describe("updateCleanup authorization", () => {
  it("a cohost may edit but may not relink the organization", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, COHOST, "cohost")
    const org = repo.seedOrganization({ slug: "bct" })
    repo.seedOrgMember(org.id, COHOST, "owner")

    const edited = await service.updateCleanup(created.id, { title: "Renamed" }, COHOST)
    expect(edited.title).toBe("Renamed")
    await expect(
      service.updateCleanup(created.id, { organizationId: org.id }, COHOST),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("staff may not edit the event at all", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, STAFF, "staff")
    await expect(
      service.updateCleanup(created.id, { title: "Nope" }, STAFF),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("an org owner inherits the organizer's powers on the org's events", async () => {
    const org = repo.seedOrganization({ slug: "bct" })
    repo.seedOrgMember(org.id, ORG, "owner")
    repo.seedOrgMember(org.id, ORG_OWNER, "owner")
    const created = await service.createCleanup(base({ organizationId: org.id }), ORG)
    const edited = await service.updateCleanup(created.id, { title: "Org edit" }, ORG_OWNER)
    expect(edited.title).toBe("Org edit")
    expect(edited.myCapabilities).toContain("cancel_event")
  })

  it("writes the host fields through the patch and reflects them in the DTO", async () => {
    const created = await service.createCleanup(base(), ORG)
    const endsAt = new Date(Date.parse(created.scheduledAt) + 2 * 3600_000).toISOString()
    const edited = await service.updateCleanup(
      created.id,
      {
        visibility: "private",
        endsAt,
        timezone: "America/New_York",
        reminderOffsetsMinutes: [1440],
        pageSlug: "renamed-sweep",
        hostReplyTo: "host@example.org",
      },
      ORG,
    )
    expect(edited.visibility).toBe("private")
    expect(edited.endsAt).toBe(endsAt)
    expect(edited.timezone).toBe("America/New_York")
    expect(edited.reminderOffsetsMinutes).toEqual([1440])
    expect(edited.pageSlug).toBe("renamed-sweep")
    expect(repo.cleanups.get(created.id)?.hostReplyTo).toBe("host@example.org")
    expect(repo.cleanups.get(created.id)?.hostReplyToVerifiedAt).toBeNull()
    expect(edited.myCapabilities).toContain("manage_event")
  })

  it("409s a page slug already taken by another event", async () => {
    await service.createCleanup(base({ pageSlug: "taken" }), ORG)
    const other = await service.createCleanup(base({ title: "Other" }), ORG)
    await expect(
      service.updateCleanup(other.id, { pageSlug: "taken" }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.updateCleanup(other.id, { pageSlug: "free" }, ORG),
    ).resolves.toMatchObject({ pageSlug: "free" })
  })

  it("lets an event keep its own page slug on a re-save", async () => {
    const created = await service.createCleanup(base({ pageSlug: "keep-me" }), ORG)
    const edited = await service.updateCleanup(created.id, { pageSlug: "keep-me" }, ORG)
    expect(edited.pageSlug).toBe("keep-me")
  })

  it("a private event 404s a stranger rather than telling them it exists", async () => {
    const created = await service.createCleanup(base({ visibility: "private" }), ORG)
    await expect(service.getCleanup(created.id, { userId: OUTSIDER })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(
      service.updateCleanup(created.id, { title: "Nope" }, OUTSIDER),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a stranger cannot JOIN their way into a private event's roster", async () => {
    const created = await service.createCleanup(base({ visibility: "private" }), ORG)
    await expect(service.joinCleanup(created.id, OUTSIDER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.claimEventSlot(created.id, OUTSIDER, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.getCleanup(created.id, { userId: OUTSIDER })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(
      service.listAttendees(created.id, { userId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("an invited member of a private event may join, read and see the roster", async () => {
    const created = await service.createCleanup(base({ visibility: "private" }), ORG)
    repo.seedMember(created.id, OUTSIDER, "member")
    await expect(service.joinCleanup(created.id, OUTSIDER)).resolves.toMatchObject({
      joined: true,
    })
    const read = await service.getCleanup(created.id, { userId: OUTSIDER })
    expect(read.id).toBe(created.id)
  })

  it("an unlisted event is still joinable by link", async () => {
    const created = await service.createCleanup(base({ visibility: "unlisted" }), ORG)
    await expect(service.joinCleanup(created.id, OUTSIDER)).resolves.toMatchObject({
      joined: true,
    })
  })

  it("an unlisted event stays reachable by its link", async () => {
    const created = await service.createCleanup(base({ visibility: "unlisted" }), ORG)
    const read = await service.getCleanup(created.id, { userId: OUTSIDER })
    expect(read.id).toBe(created.id)
    expect(read.myCapabilities).toEqual([])
  })
})

describe("getCleanup addressing", () => {
  it("resolves a uuid, a reference code and a page slug", async () => {
    const scoped = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      resolveJurisdictionCode: () => Promise.resolve(42),
    })
    const created = await scoped.createCleanup(base({ pageSlug: "beach-sweep" }), ORG)
    expect((await scoped.getCleanup(created.id, { userId: ORG })).id).toBe(created.id)
    expect((await scoped.getCleanup(created.referenceCode!, { userId: ORG })).id).toBe(created.id)
    expect((await scoped.getCleanup("beach-sweep", { userId: ORG })).id).toBe(created.id)
  })
})

describe("cover and gallery URLs", () => {
  it("serves a public event's cover from the CDN and a private one signed", async () => {
    const coverMediaId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
    const publicEvent = await service.createCleanup(base({ coverMediaId }), ORG)
    expect(publicEvent.coverUrl).toBe(`https://cdn.test/media/${coverMediaId}`)

    const privateEvent = await service.createCleanup(
      base({ coverMediaId, visibility: "private", title: "Private" }),
      ORG,
    )
    expect(privateEvent.coverUrl).toBe(`signed://media/${coverMediaId}`)
  })

  it("422s more gallery images than the cap and a repeated image", async () => {
    const many = Array.from({ length: 13 }, (_, i) => `aaaaaaaa-1111-4111-8111-00000000000${i}`)
    await expect(
      service.createCleanup(base({ galleryMediaIds: many }), ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      service.createCleanup(
        base({ galleryMediaIds: ["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"] }),
        ORG,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})

describe("visibility in feeds and audited reads", () => {
  it("keeps unlisted and private events out of the anonymous list", async () => {
    await service.createCleanup(base({ title: "Public" }), ORG)
    await service.createCleanup(base({ title: "Unlisted", visibility: "unlisted" }), ORG)
    await service.createCleanup(base({ title: "Private", visibility: "private" }), ORG)
    const anon = await service.listCleanups({ when: "upcoming" }, { userId: null })
    expect(anon.items.map((c) => c.title)).toEqual(["Public"])
  })

  it("shows a host their own unlisted and private events", async () => {
    await service.createCleanup(base({ title: "Public" }), ORG)
    await service.createCleanup(base({ title: "Private", visibility: "private" }), ORG)
    const mine = await service.listCleanups({ when: "upcoming" }, { userId: ORG })
    expect(mine.items.map((c) => c.title).sort()).toEqual(["Private", "Public"])
    expect(mine.items.every((c) => c.myCapabilities.includes("manage_event"))).toBe(true)
  })

  it("audits a host reading the roster, and never audits an ordinary attendee", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, OUTSIDER, "member")
    await service.listAttendees(created.id, { userId: OUTSIDER })
    expect(audits).toHaveLength(0)
    await service.listAttendees(created.id, { userId: ORG })
    expect(audits).toEqual([{ action: "event.roster_viewed", target: `cleanup:${created.id}` }])
  })

  it("audits a roster read once per hour per host, not once per page view", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, OUTSIDER, "member")
    await service.listAttendees(created.id, { userId: ORG })
    await service.listAttendees(created.id, { userId: ORG })
    await service.listAttendees(created.id, { userId: ORG })
    expect(audits.filter((a) => a.action === "event.roster_viewed")).toHaveLength(1)
  })

  it(`caps a host at ${HOST_ROSTER_READS_PER_HOUR} roster reads an hour`, async () => {
    const created = await service.createCleanup(base(), ORG)
    for (let i = 0; i < HOST_ROSTER_READS_PER_HOUR; i += 1) {
      await service.listAttendees(created.id, { userId: ORG })
    }
    await expect(service.listAttendees(created.id, { userId: ORG })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("audits an attendee removal", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, OUTSIDER, "member")
    await service.removeMember(created.id, ORG, OUTSIDER)
    expect(audits.some((a) => a.action === "event.attendee_removed")).toBe(true)
  })
})

describe("setCleanupMemberRole widened to staff", () => {
  it("promotes a member to staff and audits the change", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, OUTSIDER, "member")
    await service.setMemberRole(created.id, ORG, OUTSIDER, "staff")
    expect(await repo.roleOf(created.id, OUTSIDER)).toBe("staff")
    expect(audits.some((a) => a.action === "event.team_role_changed")).toBe(true)
  })

  it("only the organizer (manage_team) may change roles", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, COHOST, "cohost")
    repo.seedMember(created.id, OUTSIDER, "member")
    await expect(
      service.setMemberRole(created.id, COHOST, OUTSIDER, "staff"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("a cohost may remove a plain member but not another cohost", async () => {
    const created = await service.createCleanup(base(), ORG)
    repo.seedMember(created.id, COHOST, "cohost")
    repo.seedMember(created.id, STAFF, "cohost")
    repo.seedMember(created.id, OUTSIDER, "member")
    await expect(service.removeMember(created.id, COHOST, STAFF)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(service.removeMember(created.id, COHOST, OUTSIDER)).resolves.toMatchObject({
      ok: true,
    })
  })
})
