import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeJobs } from "@civfix/shared/fakes"
import { MAX_BRING_ITEMS, MAX_EVENT_SLOTS, MAX_LINKED_REPORTS } from "@civfix/shared"
import {
  makeCleanupService,
  type CleanupService,
  type CleanupServiceDeps,
  type UpdateCleanupPatchRequest,
} from "../../src/services/cleanup-service.js"
import { CLEANUP_GUEST_UPDATE_FANOUT_JOB } from "../../src/services/guest-rsvp-service.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"

// Characterization of updateCleanup ahead of its split into helpers: every assertion pins what the
// current code does, including the order in which its guards fire, so the refactor can prove neutrality.

const HOUR = 60 * 60 * 1000
const NOW = new Date("2026-06-01T12:00:00.000Z")
const START = new Date(NOW.getTime() + 24 * HOUR)
const END = new Date(START.getTime() + 4 * HOUR)

const HOST = "11111111-1111-4111-8111-111111111111"
const STRANGER = "22222222-2222-4222-8222-222222222222"
const COHOST = "33333333-3333-4333-8333-333333333333"
const COORDINATOR = "44444444-4444-4444-8444-444444444444"
const CLAIMANT = "55555555-5555-4555-8555-555555555555"
const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SLOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SECOND_SLOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const REPORT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const HIDDEN_REPORT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const ORG_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff"

interface Refusal {
  code: string
  httpStatus: number
  message: string
  fields: Record<string, string> | undefined
}

async function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  try {
    await pending
  } catch (err) {
    const e = err as Refusal
    return { code: e.code, httpStatus: e.httpStatus, message: e.message, fields: e.fields }
  }
  throw new Error("expected updateCleanup to refuse")
}

interface Bell {
  userId: string
  type: string
  titleKey: string | undefined
  bodyKey: string | undefined
  vars: unknown
  link: string | undefined
}

let repo: InMemoryCleanupRepository
let jobs: FakeJobs
let bells: Bell[]
let geoidCalls: [number, number][]

function service(over: Partial<CleanupServiceDeps> = {}): CleanupService {
  return makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
    jobs,
    notifier: {
      createNotification: (userId, input) => {
        bells.push({
          userId,
          type: input.type,
          titleKey: input.titleKey,
          bodyKey: input.bodyKey,
          vars: input.vars,
          link: input.link,
        })
        return Promise.resolve({
          id: "n1",
          type: input.type,
          title: "",
          read: false,
          createdAt: NOW.toISOString(),
        })
      },
    },
    resolveJurisdictionGeoid: (lat, lng) => {
      geoidCalls.push([lat, lng])
      return Promise.resolve("0644000")
    },
    ...over,
  })
}

function seedEvent(
  over: Parameters<InMemoryCleanupRepository["seedCleanup"]>[0] = {},
): ReturnType<InMemoryCleanupRepository["seedCleanup"]> {
  const event = repo.seedCleanup({
    id: EVENT,
    organizerUserId: HOST,
    scheduledAt: START,
    endsAt: END,
    createdAt: new Date(NOW.getTime() - HOUR),
    withDefaultSlot: false,
    ...over,
  })
  repo.seedSlot({ id: SLOT, cleanupId: event.id, title: "General volunteers" })
  return event
}

function seedEndedEvent(): void {
  seedEvent({
    scheduledAt: new Date(NOW.getTime() - 10 * HOUR),
    endsAt: new Date(NOW.getTime() - 6 * HOUR),
  })
}

function update(
  patch: UpdateCleanupPatchRequest,
  actor: string = HOST,
  svc: CleanupService = service(),
): Promise<unknown> {
  return svc.updateCleanup(EVENT, patch, actor)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: HOST, displayName: "Olive Organizer", handle: "olive" })
  jobs = new FakeJobs()
  bells = []
  geoidCalls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe("updateCleanup characterization: guards that run before the event is loaded", () => {
  it("rejects an over-long bring list even when the event does not exist", async () => {
    const bring = Array.from({ length: MAX_BRING_ITEMS + 1 }, (_, i) => `item ${i}`)
    expect(await refusalOf(update({ bring }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { bring: `at most ${MAX_BRING_ITEMS} items may be listed` },
    })
  })

  it("404s an unknown event id", async () => {
    expect(await refusalOf(update({ title: "Renamed" }))).toEqual({
      code: "NOT_FOUND",
      httpStatus: 404,
      message: "Cleanup not found",
      fields: undefined,
    })
  })
})

describe("updateCleanup characterization: authorization", () => {
  it("403s a stranger on a public event with the manage_event copy", async () => {
    seedEvent()
    expect(await refusalOf(update({ title: "Renamed" }, STRANGER))).toEqual({
      code: "FORBIDDEN",
      httpStatus: 403,
      message: "Only the event hosts can edit this event.",
      fields: undefined,
    })
  })

  it("404s a stranger on a private event instead of revealing it", async () => {
    seedEvent({ visibility: "private" })
    expect(await refusalOf(update({ title: "Renamed" }, STRANGER))).toEqual({
      code: "NOT_FOUND",
      httpStatus: 404,
      message: "Cleanup not found",
      fields: undefined,
    })
  })

  it("403s a coordinator, who lacks manage_event", async () => {
    seedEvent()
    repo.seedMember(EVENT, COORDINATOR, "coordinator")
    expect(await refusalOf(update({ title: "Renamed" }, COORDINATOR))).toMatchObject({
      code: "FORBIDDEN",
      message: "Only the event hosts can edit this event.",
    })
  })

  it("lets a cohost edit but 403s a cohost who changes the organization", async () => {
    seedEvent()
    repo.seedMember(EVENT, COHOST, "cohost")
    await expect(update({ title: "Cohost title" }, COHOST)).resolves.toMatchObject({
      title: "Cohost title",
    })
    expect(await refusalOf(update({ organizationId: ORG_ID }, COHOST))).toEqual({
      code: "FORBIDDEN",
      httpStatus: 403,
      message: "Only the event organizer can change the organization.",
      fields: undefined,
    })
  })

  it("checks capability before the cancelled state: a stranger on a cancelled event gets 403", async () => {
    seedEvent({ status: "cancelled" })
    expect(await refusalOf(update({ title: "Renamed" }, STRANGER))).toMatchObject({
      code: "FORBIDDEN",
    })
  })
})

describe("updateCleanup characterization: lifecycle", () => {
  it("409s any edit to a cancelled event", async () => {
    seedEvent({ status: "cancelled" })
    expect(await refusalOf(update({ description: "notes" }))).toEqual({
      code: "CONFLICT",
      httpStatus: 409,
      message: "This event has been cancelled and can no longer be edited.",
      fields: undefined,
    })
  })

  it.each<[string, UpdateCleanupPatchRequest]>([
    ["title", { title: "Renamed" }],
    ["scheduledAt", { scheduledAt: new Date(NOW.getTime() + HOUR).toISOString() }],
    ["lat", { lat: 34.1 }],
    ["lng", { lng: -118.4 }],
    ["type", { type: "site" }],
    ["eventKind", { eventKind: "cleanup" }],
  ])("freezes %s once the event has ended, even to the same value", async (_field, patch) => {
    seedEndedEvent()
    expect(await refusalOf(update(patch))).toEqual({
      code: "CONFLICT",
      httpStatus: 409,
      message: "An event that has ended can't change its date, title, location or type.",
      fields: undefined,
    })
  })

  it("409s a changed endsAt on an ended event", async () => {
    seedEndedEvent()
    expect(await refusalOf(update({ endsAt: NOW.toISOString() }))).toEqual({
      code: "CONFLICT",
      httpStatus: 409,
      message: "An event that has ended can't change its end time.",
      fields: undefined,
    })
  })

  it("accepts an unchanged endsAt and a description on an ended event", async () => {
    seedEndedEvent()
    const endsAt = new Date(NOW.getTime() - 6 * HOUR).toISOString()
    await expect(update({ endsAt, description: "Thanks all" })).resolves.toMatchObject({
      status: "done",
      description: "Thanks all",
    })
  })

  it("422s slots on an ended event", async () => {
    seedEndedEvent()
    expect(await refusalOf(update({ slots: [{ id: SLOT, title: "General volunteers" }] }))).toEqual(
      {
        code: "VALIDATION",
        httpStatus: 422,
        message: "Validation failed",
        fields: { slots: "Slots can't be changed after an event has ended." },
      },
    )
  })

  it("does not enqueue a guest fan-out for an address change on an ended event", async () => {
    seedEndedEvent()
    await update({ address: "500 New Pier Rd" })
    expect(jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)).toHaveLength(0)
    expect(repo.cleanups.get(EVENT)?.address).toBe("500 New Pier Rd")
  })

  it("422s a scheduledAt backdated more than a day and earlier than the stored start", async () => {
    seedEvent()
    const scheduledAt = new Date(NOW.getTime() - 25 * HOUR).toISOString()
    expect(await refusalOf(update({ scheduledAt }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { scheduledAt: "must not be in the past" },
    })
  })
})

describe("updateCleanup characterization: linked reports", () => {
  it("422s linkedReportIds on a non-cleanup event", async () => {
    seedEvent({ eventKind: "other_volunteer" })
    expect(await refusalOf(update({ linkedReportIds: [REPORT] }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { linkedReportIds: "only cleanup events can link reports" },
    })
  })

  it("422s linkedReportIds when the same patch switches the kind away from cleanup", async () => {
    seedEvent()
    expect(
      await refusalOf(update({ eventKind: "other_volunteer", linkedReportIds: [] })),
    ).toMatchObject({
      code: "VALIDATION",
      fields: { linkedReportIds: "only cleanup events can link reports" },
    })
  })

  it("422s more than MAX_LINKED_REPORTS ids", async () => {
    seedEvent()
    const ids = Array.from({ length: MAX_LINKED_REPORTS + 1 }, () => REPORT)
    expect(await refusalOf(update({ linkedReportIds: ids }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { linkedReportIds: `at most ${MAX_LINKED_REPORTS} reports may be linked` },
    })
  })

  it("422s a report that is not publicly visible, naming it", async () => {
    seedEvent()
    repo.seedReport({ id: REPORT })
    repo.seedReport({ id: HIDDEN_REPORT, visibility: "hidden" })
    expect(await refusalOf(update({ linkedReportIds: [REPORT, HIDDEN_REPORT] }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { linkedReportIds: `not linkable: ${HIDDEN_REPORT}` },
    })
    expect(repo.links).toEqual([])
  })

  it("reconciles the link set and returns the linked report refs", async () => {
    seedEvent()
    repo.seedReport({ id: REPORT, title: "Overflowing bin" })
    const dto = (await update({ linkedReportIds: [REPORT] })) as {
      linkedReports: { id: string }[]
    }
    expect(dto.linkedReports.map((r) => r.id)).toEqual([REPORT])
    expect(repo.links.map((l) => [l.cleanupId, l.reportId, l.linkedByUserId])).toEqual([
      [EVENT, REPORT, HOST],
    ])
  })

  it("clears every link when the kind switches away from cleanup without linkedReportIds", async () => {
    seedEvent()
    repo.seedReport({ id: REPORT })
    repo.seedLink(EVENT, REPORT, HOST)
    const dto = (await update({ eventKind: "other_volunteer" })) as { linkedReports: unknown[] }
    expect(dto.linkedReports).toEqual([])
    expect(repo.links).toEqual([])
    expect(repo.timeline.map((t) => [t.kind, t.reportId, t.actorId])).toEqual([
      ["report_unlinked", REPORT, HOST],
    ])
  })
})

describe("updateCleanup characterization: the event window", () => {
  it("422s an explicit null endsAt", async () => {
    seedEvent()
    expect(await refusalOf(update({ endsAt: null }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { endsAt: "an event must have an end time" },
    })
  })

  it("422s an endsAt before the start", async () => {
    seedEvent()
    const endsAt = new Date(START.getTime() - HOUR).toISOString()
    expect(await refusalOf(update({ endsAt }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { endsAt: "must be after the start time" },
    })
  })

  it("422s an event shorter than the minimum duration", async () => {
    seedEvent()
    const endsAt = new Date(START.getTime() + 5 * 60 * 1000).toISOString()
    expect(await refusalOf(update({ endsAt }))).toMatchObject({
      code: "VALIDATION",
      fields: { endsAt: "must be at least 15 minutes after scheduledAt" },
    })
  })

  it("422s an event longer than the maximum duration", async () => {
    seedEvent()
    const endsAt = new Date(START.getTime() + 25 * HOUR).toISOString()
    expect(await refusalOf(update({ endsAt }))).toMatchObject({
      code: "VALIDATION",
      fields: { endsAt: "an event can run for at most 24 hours" },
    })
  })

  it("422s a moved window that strands an existing timed slot outside it", async () => {
    seedEvent()
    repo.seedSlot({
      id: SECOND_SLOT,
      cleanupId: EVENT,
      title: "Morning shift",
      startsAt: START,
      endsAt: new Date(START.getTime() + HOUR),
      sortOrder: 1,
    })
    const scheduledAt = new Date(START.getTime() + 30 * 60 * 1000).toISOString()
    expect(await refusalOf(update({ scheduledAt }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: {
        scheduledAt:
          "timed slots would fall outside the new start and end; update the slots in the same save",
      },
    })
  })

  it("lets a moved window through when every timed slot still fits", async () => {
    seedEvent()
    repo.seedSlot({
      id: SECOND_SLOT,
      cleanupId: EVENT,
      title: "Late shift",
      startsAt: new Date(START.getTime() + 2 * HOUR),
      endsAt: new Date(START.getTime() + 3 * HOUR),
      sortOrder: 1,
    })
    const scheduledAt = new Date(START.getTime() + HOUR).toISOString()
    await expect(update({ scheduledAt })).resolves.toMatchObject({ scheduledAt })
  })
})

describe("updateCleanup characterization: slots", () => {
  it("422s an empty slot list", async () => {
    seedEvent()
    expect(await refusalOf(update({ slots: [] }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { slots: "an event needs at least one signup slot" },
    })
  })

  it("422s more than MAX_EVENT_SLOTS slots", async () => {
    seedEvent()
    const slots = Array.from({ length: MAX_EVENT_SLOTS + 1 }, (_, i) => ({ title: `Slot ${i}` }))
    expect(await refusalOf(update({ slots }))).toMatchObject({
      code: "VALIDATION",
      fields: { slots: `at most ${MAX_EVENT_SLOTS} slots may be listed` },
    })
  })

  it("422s a timed slot outside the event window", async () => {
    seedEvent()
    const slots = [
      {
        title: "Too early",
        startsAt: new Date(START.getTime() - HOUR).toISOString(),
        endsAt: START.toISOString(),
      },
    ]
    expect(await refusalOf(update({ slots }))).toMatchObject({
      code: "VALIDATION",
      fields: { slots: `slot "Too early" falls outside the event's start and end` },
    })
  })

  it("422s a timed slot shorter than the minimum", async () => {
    seedEvent()
    const slots = [
      {
        title: "Blink",
        startsAt: START.toISOString(),
        endsAt: new Date(START.getTime() + 5 * 60 * 1000).toISOString(),
      },
    ]
    expect(await refusalOf(update({ slots }))).toMatchObject({
      code: "VALIDATION",
      fields: { slots: `slot "Blink" must last at least 15 minutes` },
    })
  })

  it("422s duplicate slot titles case-insensitively, echoing the untrimmed title", async () => {
    seedEvent()
    expect(
      await refusalOf(update({ slots: [{ title: "Crew" }, { title: " crew " }] })),
    ).toMatchObject({
      code: "VALIDATION",
      fields: { slots: "duplicate slot title:  crew " },
    })
  })

  it("validates slots against the window the same patch moves them into", async () => {
    seedEvent()
    const scheduledAt = new Date(START.getTime() + 2 * HOUR)
    const slots = [
      {
        title: "Old morning",
        startsAt: START.toISOString(),
        endsAt: new Date(START.getTime() + HOUR).toISOString(),
      },
    ]
    expect(
      await refusalOf(update({ scheduledAt: scheduledAt.toISOString(), slots })),
    ).toMatchObject({
      code: "VALIDATION",
      fields: { slots: `slot "Old morning" falls outside the event's start and end` },
    })
  })

  it("422s a slot id that does not belong to the event", async () => {
    seedEvent()
    const stray = "99999999-9999-4999-8999-999999999999"
    expect(await refusalOf(update({ slots: [{ id: stray, title: "Ghost" }] }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { slots: `unknown slot: ${stray}` },
    })
  })

  it("reconciles slots and rings the claimants of a removed slot", async () => {
    seedEvent()
    repo.seedSlot({ id: SECOND_SLOT, cleanupId: EVENT, title: "Kayak crew", sortOrder: 1 })
    repo.seedMember(EVENT, CLAIMANT)
    repo.slotClaims.push({ cleanupId: EVENT, userId: CLAIMANT, slotId: SECOND_SLOT })

    const dto = (await update({ slots: [{ id: SLOT, title: "Everyone" }] })) as {
      slots: { id: string; title: string }[]
    }

    expect(dto.slots.map((s) => [s.id, s.title])).toEqual([[SLOT, "Everyone"]])
    expect(bells).toEqual([
      {
        userId: CLAIMANT,
        type: "cleanup_slot",
        titleKey: "notification.cleanup_slot.removed.title",
        bodyKey: "notification.cleanup_slot.removed.body",
        vars: { slot: "Kayak crew", title: "Beach cleanup" },
        link: `/cleanups/${EVENT}`,
      },
    ])
  })

  it("rings the claimants of a rescheduled slot with the moved copy", async () => {
    seedEvent()
    repo.seedMember(EVENT, CLAIMANT)
    repo.slotClaims.push({ cleanupId: EVENT, userId: CLAIMANT, slotId: SLOT })
    const slots = [
      {
        id: SLOT,
        title: "General volunteers",
        startsAt: START.toISOString(),
        endsAt: new Date(START.getTime() + HOUR).toISOString(),
      },
    ]

    await update({ slots })

    expect(bells.map((b) => [b.userId, b.titleKey, b.bodyKey])).toEqual([
      [CLAIMANT, "notification.cleanup_slot.moved.title", "notification.cleanup_slot.moved.body"],
    ])
  })
})

describe("updateCleanup characterization: address and jurisdiction", () => {
  it("422s a host-confirmed address shorter than three characters", async () => {
    seedEvent()
    expect(await refusalOf(update({ address: " ab ", addressSource: "resolved" }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { address: "must be at least 3 characters" },
    })
  })

  it("stores a typed address as manual and a blank one as null", async () => {
    seedEvent()
    await update({ address: "  North gate  " })
    expect(repo.cleanups.get(EVENT)).toMatchObject({
      address: "North gate",
      addressSource: "manual",
    })
    await update({ address: "   " })
    expect(repo.cleanups.get(EVENT)).toMatchObject({ address: null, addressSource: null })
  })

  it("keeps the client's source for a confirmed address", async () => {
    seedEvent()
    await update({ address: " 1 Pier Rd ", addressSource: "resolved" })
    expect(repo.cleanups.get(EVENT)).toMatchObject({
      address: "1 Pier Rd",
      addressSource: "resolved",
    })
  })

  it("re-resolves the jurisdiction geoid only when both lat and lng move", async () => {
    seedEvent({ jurisdictionGeoid: "0600000" })
    await update({ lat: 34.05 })
    expect(geoidCalls).toEqual([])
    expect(repo.cleanups.get(EVENT)?.jurisdictionGeoid).toBe("0600000")

    await update({ lat: 34.05, lng: -118.25 })
    expect(geoidCalls).toEqual([[34.05, -118.25]])
    expect(repo.cleanups.get(EVENT)).toMatchObject({
      lat: 34.05,
      lng: -118.25,
      jurisdictionGeoid: "0644000",
    })
  })

  it("keeps the stored geoid when no resolver is wired", async () => {
    seedEvent({ jurisdictionGeoid: "0600000" })
    await update(
      { lat: 34.05, lng: -118.25 },
      HOST,
      service({ resolveJurisdictionGeoid: undefined }),
    )
    expect(repo.cleanups.get(EVENT)?.jurisdictionGeoid).toBe("0600000")
  })
})

describe("updateCleanup characterization: organization link", () => {
  it("422s a link to an organization that does not exist", async () => {
    seedEvent()
    expect(await refusalOf(update({ organizationId: ORG_ID }))).toEqual({
      code: "VALIDATION",
      httpStatus: 422,
      message: "Validation failed",
      fields: { organizationId: "that organization no longer exists" },
    })
  })

  it("403s a link to an organization the host is not a member of", async () => {
    seedEvent()
    repo.seedOrganization({ id: ORG_ID })
    expect(await refusalOf(update({ organizationId: ORG_ID }))).toEqual({
      code: "FORBIDDEN",
      httpStatus: 403,
      message: "Only a member of that organization can host events for it.",
      fields: undefined,
    })
  })

  it("409s a new link to a suspended organization", async () => {
    seedEvent()
    repo.seedOrganization({ id: ORG_ID, suspended: true })
    repo.seedOrgMember(ORG_ID, HOST, "owner")
    expect(await refusalOf(update({ organizationId: ORG_ID }))).toEqual({
      code: "CONFLICT",
      httpStatus: 409,
      message: "That organization is suspended and can't host events right now.",
      fields: undefined,
    })
  })

  it("lets an already-linked suspended organization ride along on an unrelated edit", async () => {
    repo.seedOrganization({ id: ORG_ID, suspended: true })
    seedEvent({ organizationId: ORG_ID })
    await expect(update({ description: "still ours" })).resolves.toMatchObject({
      description: "still ours",
    })
  })
})

describe("updateCleanup characterization: a successful edit", () => {
  it("writes the patch, enqueues the guest fan-out and returns the host's DTO", async () => {
    seedEvent({ address: "Old pier", addressSource: "manual" })
    const scheduledAt = new Date(START.getTime() + HOUR).toISOString()
    const endsAt = new Date(START.getTime() + 5 * HOUR).toISOString()

    const dto = await update({
      title: "Pier sweep",
      description: "Bring water",
      scheduledAt,
      endsAt,
      bring: ["gloves"],
      address: "500 New Pier Rd",
      timezone: "America/Los_Angeles",
    })

    expect(dto).toMatchObject({
      id: EVENT,
      title: "Pier sweep",
      description: "Bring water",
      scheduledAt,
      endsAt,
      bring: ["gloves"],
      address: "500 New Pier Rd",
      addressSource: "manual",
      timezone: "America/Los_Angeles",
      status: "upcoming",
      joined: true,
      going: 1,
      organizer: { id: HOST, name: "Olive Organizer" },
    })
    expect(dto).toMatchInlineSnapshot(`
      {
        "address": "500 New Pier Rd",
        "addressSource": "manual",
        "bring": [
          "gloves",
        ],
        "capacity": null,
        "coverUrl": null,
        "description": "Bring water",
        "donationUrl": null,
        "endsAt": "2026-06-02T17:00:00.000Z",
        "eventKind": "cleanup",
        "galleryUrls": [],
        "going": 1,
        "guestCount": 0,
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "joined": true,
        "lat": 34,
        "linkedReports": [],
        "lng": -118.49,
        "myCapabilities": [
          "view_event_private",
          "view_roster",
          "view_guest_contact",
          "view_answers",
          "view_analytics",
          "check_in",
          "manage_event",
          "manage_tickets",
          "manage_team",
          "broadcast",
          "export",
          "manage_page",
          "cancel_event",
          "manage_org_link",
          "moderate_chat",
          "request_resources",
        ],
        "myRole": "organizer",
        "organization": null,
        "organizer": {
          "avatar": [
            "#9B7ED9",
            "#74A9D8",
          ],
          "bio": null,
          "followers": 0,
          "following": 0,
          "handle": "olive",
          "id": "11111111-1111-4111-8111-111111111111",
          "isFollowing": false,
          "name": "Olive Organizer",
        },
        "pageSlug": null,
        "registrationClosesAt": null,
        "registrationOpensAt": null,
        "reminderOffsetsMinutes": null,
        "scheduledAt": "2026-06-02T13:00:00.000Z",
        "slots": [
          {
            "claimed": 0,
            "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "sortOrder": 0,
            "title": "General volunteers",
          },
        ],
        "status": "upcoming",
        "ticketTypes": [],
        "timezone": "America/Los_Angeles",
        "title": "Pier sweep",
        "type": "site",
        "visibility": "public",
      }
    `)

    const enqueued = jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)
    expect(enqueued.map((j) => [j.data, j.opts?.singletonKey])).toEqual([
      [{ cleanupId: EVENT }, EVENT],
    ])
    expect(bells).toEqual([])
  })

  it("does not enqueue a guest fan-out for a title-only edit", async () => {
    seedEvent()
    await update({ title: "Renamed" })
    expect(jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)).toHaveLength(0)
  })

  it("does not enqueue a guest fan-out for an unchanged scheduledAt or address", async () => {
    seedEvent({ address: "Old pier" })
    await update({ scheduledAt: START.toISOString(), address: "Old pier" })
    expect(jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)).toHaveLength(0)
  })
})
