import { describe, it, expect } from "vitest"
import { InMemoryAdminEventRepository } from "../../src/services/admin/admin-event-repository.memory.js"
import {
  makeAdminEventService,
  resolveEventFilter,
  eventStatusNote,
  flaggedFromTimeline,
  eventTimelineKind,
  type AdminEventService,
} from "../../src/services/admin/admin-event-service.js"

/**
 * Offline unit tests for the admin events (cleanups) service over the in-memory AdminEventRepository (no
 * DB, no Docker). They cover the list (status + flagged facet, search, pagination), the detail (timeline
 * + messages + turnout), status changes (cleanup_timeline + audit), the flag toggle
 * (cleanup_timeline-tracked + audit), cancel (-> cancelled + audit), and post-message (chat row +
 * notify each member + audit), plus the pure helpers.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

function harness(): { repo: InMemoryAdminEventRepository; svc: AdminEventService } {
  const repo = new InMemoryAdminEventRepository()
  repo.now = NOW
  const svc = makeAdminEventService({ repo, now: () => NOW })
  return { repo, svc }
}

/** A timestamp `hours` before NOW. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("admin events pure helpers", () => {
  it("resolveEventFilter maps the design facet to status + flaggedOnly", () => {
    expect(resolveEventFilter("all")).toEqual({ status: null, flaggedOnly: false })
    expect(resolveEventFilter("upcoming")).toEqual({ status: "upcoming", flaggedOnly: false })
    expect(resolveEventFilter("in_progress")).toEqual({ status: "in_progress", flaggedOnly: false })
    expect(resolveEventFilter("completed")).toEqual({ status: "completed", flaggedOnly: false })
    expect(resolveEventFilter("flagged")).toEqual({ status: null, flaggedOnly: true })
  })

  it("eventStatusNote labels each status (cancelled distinct)", () => {
    expect(eventStatusNote("cancelled")).toBe("Event cancelled")
    expect(eventStatusNote("completed")).toBe("Status set to Completed")
  })

  it("flaggedFromTimeline computes the net flag/unflag state", () => {
    expect(flaggedFromTimeline([])).toBe(false)
    expect(flaggedFromTimeline(["flag"])).toBe(true)
    expect(flaggedFromTimeline(["flag", "unflag"])).toBe(false)
    expect(flaggedFromTimeline(["flag", "unflag", "flag"])).toBe(true)
    // Non-flag rows do not change the state.
    expect(flaggedFromTimeline(["flag", "status", "message"])).toBe(true)
  })

  it("eventTimelineKind maps stored kinds to design icon kinds (flag/unflag -> warn)", () => {
    expect(eventTimelineKind("status")).toBe("status")
    expect(eventTimelineKind("cancel")).toBe("cancel")
    expect(eventTimelineKind("flag")).toBe("warn")
    expect(eventTimelineKind("unflag")).toBe("warn")
    expect(eventTimelineKind("mystery")).toBe("status")
  })
})

describe("admin events list", () => {
  it("projects a list row with turnout, date rel+abs, coords", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({
      id: "evt-1",
      status: "upcoming",
      title: "Riverbank cleanup",
      place: "Austin",
      attendees: 12,
      capacity: 30,
      bags: 4,
      lat: 30.27,
      lng: -97.74,
      scheduledAt: hoursAgo(2),
      organizer: {
        id: "u-1",
        name: "Olive",
        handle: "olive",
        emailVerified: false,
        hasOauth: true,
        joinedAt: new Date(Date.UTC(2025, 5, 1)),
      },
    })
    const page = await svc.list({})
    const row = page.items[0]!
    expect(row.status).toBe("upcoming")
    expect(row.attendees).toBe(12)
    expect(row.capacity).toBe(30)
    expect(row.bags).toBe(4)
    expect(row.coords).toEqual([30.27, -97.74])
    expect(row.date.rel).toBe("2h")
  })

  it("filters by status and by flagged", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "u", status: "upcoming" })
    repo.seedEvent({ id: "p", status: "in_progress" })
    repo.seedEvent({ id: "c", status: "completed" })
    repo.seedEvent({
      id: "f",
      status: "upcoming",
      timeline: [{ kind: "flag", note: null, who: "op", createdAt: NOW }],
    })

    expect((await svc.list({ filter: "upcoming" })).items.map((i) => i.id).sort()).toEqual([
      "f",
      "u",
    ])
    expect((await svc.list({ filter: "completed" })).items.map((i) => i.id)).toEqual(["c"])
    expect((await svc.list({ filter: "flagged" })).items.map((i) => i.id)).toEqual(["f"])
  })

  it("returns accurate per-facet counts (flagged orthogonal, spanning all statuses)", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "u", status: "upcoming" })
    repo.seedEvent({ id: "p", status: "in_progress" })
    repo.seedEvent({ id: "c", status: "completed" })
    repo.seedEvent({ id: "x", status: "cancelled" }) // in `all`, not in the visible chips
    repo.seedEvent({
      id: "f",
      status: "upcoming",
      timeline: [{ kind: "flag", note: null, who: "op", createdAt: NOW }],
    })
    // counts span ALL events (not the active facet) so the chips stay accurate.
    const { counts } = await svc.list({ filter: "completed" })
    expect(counts).toEqual({ all: 5, upcoming: 2, in_progress: 1, completed: 1, flagged: 1 })
  })

  // H1: a Phase-1 row stored as 'active'/'done' must surface as the Phase-2 EventStatus AND be caught by
  // the matching facet (the bug: filter=completed missed stored 'done', and 'active'/'done' leaked as an
  // invalid EventStatus). Seed RAW stored values to mimic a legacy row.
  it("H1: legacy stored active/done surface as in_progress/completed and the facet matches them", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "legacy-active", storedStatus: "active" })
    repo.seedEvent({ id: "legacy-done", storedStatus: "done" })
    repo.seedEvent({ id: "p2-progress", status: "in_progress" })

    // Read maps the stored Phase-1 value to the Phase-2 EventStatus DTO.
    expect((await svc.get("legacy-active")).status).toBe("in_progress")
    expect((await svc.get("legacy-done")).status).toBe("completed")

    // The completed facet catches the legacy 'done' row; the in_progress facet catches both 'active' and
    // a Phase-2 'in_progress' row.
    expect((await svc.list({ filter: "completed" })).items.map((i) => i.id)).toEqual(["legacy-done"])
    expect((await svc.list({ filter: "in_progress" })).items.map((i) => i.id).sort()).toEqual([
      "legacy-active",
      "p2-progress",
    ])
  })

  it("search matches title, place, id, and organizer name", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "evt-1", title: "Beach sweep", place: "Miami", organizer: null })
    repo.seedEvent({
      id: "evt-2",
      title: "Trail day",
      place: "Denver",
      organizer: {
        id: "u",
        name: "Pat",
        handle: "pat",
        emailVerified: false,
        hasOauth: false,
        joinedAt: null,
      },
    })
    expect((await svc.list({ q: "beach" })).items.map((i) => i.id)).toEqual(["evt-1"])
    expect((await svc.list({ q: "denver" })).items.map((i) => i.id)).toEqual(["evt-2"])
    expect((await svc.list({ q: "pat" })).items.map((i) => i.id)).toEqual(["evt-2"])
  })

  it("paginates with a cursor (no overlap)", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedEvent({ id: `e${i}`, scheduledAt: hoursAgo(i + 1) })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
  })
})

describe("admin events detail", () => {
  it("returns desc + address + timeline + messages", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({
      id: "evt-1",
      desc: "Meet at the boat ramp",
      address: "100 River Rd",
      timeline: [{ kind: "create", note: "Event created", who: "olive", createdAt: hoursAgo(48) }],
      messages: [{ who: "olive", text: "Bring gloves", createdAt: hoursAgo(24) }],
    })
    const detail = await svc.get("evt-1")
    expect(detail.desc).toBe("Meet at the boat ramp")
    expect(detail.address).toBe("100 River Rd")
    expect(detail.timeline[0]).toMatchObject({ what: "Event created", kind: "create" })
    expect(detail.messages[0]).toMatchObject({ who: "olive", text: "Bring gloves" })
  })

  it("throws notFound for an unknown event", async () => {
    const { svc } = harness()
    await expect(svc.get("nope")).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("admin events mutations", () => {
  it("setStatus changes the status, appends a cleanup_timeline row, and audits", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "evt-1", status: "upcoming" })
    await svc.setStatus("evt-1", { status: "in_progress", actorId: "op-1" })
    expect(repo.events.get("evt-1")?.record.status).toBe("in_progress")
    // H1: the value WRITTEN to cleanups.status is the Phase-1 enum value (active), never the Phase-2 one.
    expect(repo.events.get("evt-1")?.storedStatus).toBe("active")
    expect(repo.timeline.get("evt-1")?.at(-1)).toMatchObject({ kind: "status" })
    expect(repo.audits.at(-1)).toMatchObject({
      action: "event.status_changed",
      target: "cleanup:evt-1",
      meta: { status: "in_progress" },
    })
  })

  it("setOutcome logs the bags collected (the only write path for cleanups.bags) + audits", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "evt-1", status: "completed" })
    await svc.setOutcome("evt-1", { bags: 42, actorId: "op-1" })
    expect(repo.events.get("evt-1")?.record.bags).toBe(42)
    expect(repo.audits.at(-1)).toMatchObject({
      action: "event.outcome_logged",
      target: "cleanup:evt-1",
      meta: { bags: 42 },
    })
  })

  it("setOutcome throws notFound for an unknown event", async () => {
    const { svc } = harness()
    await expect(svc.setOutcome("nope", { bags: 1, actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("flag toggles via the timeline (on then off), each audited", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "evt-1" })
    const on = await svc.flag("evt-1", { reason: "spam", actorId: "op-1" })
    expect(on).toBe(true)
    expect(repo.events.get("evt-1")?.record.flagged).toBe(true)
    expect(repo.timeline.get("evt-1")?.at(-1)?.kind).toBe("flag")
    expect(repo.audits.at(-1)).toMatchObject({ action: "event.flagged" })

    const off = await svc.flag("evt-1", { reason: null, actorId: "op-1" })
    expect(off).toBe(false)
    expect(repo.timeline.get("evt-1")?.at(-1)?.kind).toBe("unflag")
    expect(repo.audits.at(-1)).toMatchObject({ action: "event.unflagged" })
  })

  it("cancel sets status cancelled + timeline + audit", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({ id: "evt-1", status: "upcoming" })
    await svc.cancel("evt-1", { reason: "weather", actorId: "op-1" })
    expect(repo.events.get("evt-1")?.record.status).toBe("cancelled")
    expect(repo.timeline.get("evt-1")?.at(-1)?.kind).toBe("cancel")
    expect(repo.audits.at(-1)).toMatchObject({ action: "event.cancelled", target: "cleanup:evt-1" })
  })

  it("postMessage posts a chat message, notifies every member, and audits", async () => {
    const { repo, svc } = harness()
    repo.seedEvent({
      id: "evt-1",
      members: [{ userId: "m-1" }, { userId: "m-2" }, { userId: "m-3" }],
    })
    const notified = await svc.postMessage("evt-1", {
      body: "Rescheduled to Saturday 9am",
      actorId: "op-1",
    })
    expect(notified).toBe(3)
    // A chat message was appended.
    expect(repo.messages.get("evt-1")?.at(-1)).toMatchObject({
      text: "Rescheduled to Saturday 9am",
    })
    // One notification per member, all carrying the body.
    expect(repo.notifications).toHaveLength(3)
    expect(repo.notifications.map((n) => n.userId).sort()).toEqual(["m-1", "m-2", "m-3"])
    expect(repo.notifications.every((n) => n.body === "Rescheduled to Saturday 9am")).toBe(true)
    expect(repo.audits.at(-1)).toMatchObject({
      action: "event.message_posted",
      target: "cleanup:evt-1",
    })
  })

  it("postMessage throws notFound for an unknown event", async () => {
    const { svc } = harness()
    await expect(svc.postMessage("nope", { body: "hi", actorId: "op-1" })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("setStatus / cancel / flag throw notFound for an unknown event", async () => {
    const { svc } = harness()
    await expect(
      svc.setStatus("nope", { status: "completed", actorId: null }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    })
    await expect(svc.cancel("nope", { reason: null, actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
    await expect(svc.flag("nope", { reason: null, actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })
})
