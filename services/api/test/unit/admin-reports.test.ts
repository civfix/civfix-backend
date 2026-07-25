import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import {
  makeAdminReportService,
  resolveListFilter,
  timelineKindForStatus,
  type AdminReportService,
} from "../../src/services/admin/admin-report-service.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"

/**
 * Offline unit tests for the admin reports service over the in-memory AdminReportRepository (no DB, no
 * Docker). They cover the list (status + flagged facet, search, pagination), the detail projection
 * (timeline/routing/media), status changes (timeline + audit), the flag toggle
 * (abuse-flag marker + audit), remove (-> rejected + audit), and the follow-up paths: to the reporter
 * (notification + timeline) and to the city (OutboundMailService.sendToCity + timeline), plus the pure
 * helpers. Mirrors admin-discovery.test.ts conventions.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

/**
 * A recording fake for the D-D1 report-chat SYSTEM-message emitter. Captures every emitted timeline event
 * so a test can assert the service fired it with the right status/kind after a mutation. `shouldThrow`
 * makes emit reject INTERNALLY (the real emitter never does — it swallows) so a test can prove the status
 * change is INDEPENDENT of the emit even if the emit blew up.
 */
class FakeReportChatEmitter {
  readonly events: { reportId: string; status: string; kind?: string | null; note?: string | null }[] = []
  shouldThrow = false
  emit(event: { reportId: string; status: string; kind?: string | null; note?: string | null }): Promise<void> {
    this.events.push(event)
    if (this.shouldThrow) return Promise.reject(new Error("emit boom"))
    return Promise.resolve()
  }
}

interface Harness {
  repo: InMemoryAdminReportRepository
  mailRepo: InMemoryMailRepository
  mailer: FakeMailer
  emitter: FakeReportChatEmitter
  svc: AdminReportService
}

function harness(): Harness {
  const repo = new InMemoryAdminReportRepository()
  repo.now = NOW
  const mailRepo = new InMemoryMailRepository()
  const mailer = new FakeMailer()
  const emitter = new FakeReportChatEmitter()
  const outboundMail = makeOutboundMailService({
    repo: mailRepo,
    mailer,
    env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
  })
  const svc = makeAdminReportService({
    repo,
    outboundMail,
    now: () => NOW,
    reportChatEmitter: emitter,
    // A deterministic presigner so the media test asserts the keys are resolved into client URLs.
    presignMedia: async (r2Key, thumbKey) => ({
      url: `https://media.test/${r2Key}`,
      ...(thumbKey !== null ? { thumbUrl: `https://media.test/${thumbKey}` } : {}),
    }),
  })
  return { repo, mailRepo, mailer, emitter, svc }
}

/** A timestamp `hours` before NOW. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("admin reports pure helpers", () => {
  it("resolveListFilter maps each design facet to its civfix status SET + flaggedOnly", () => {
    // "Submitted" = a freshly published/held pin (live, awaiting city action) too, NOT just literal submitted.
    expect(resolveListFilter("all")).toEqual({ statuses: null, flaggedOnly: false })
    expect(resolveListFilter("submitted")).toEqual({
      statuses: ["submitted", "held", "published"],
      flaggedOnly: false,
    })
    expect(resolveListFilter("in_progress")).toEqual({
      statuses: ["acknowledged", "in_progress"],
      flaggedOnly: false,
    })
    expect(resolveListFilter("completed")).toEqual({ statuses: ["resolved"], flaggedOnly: false })
    expect(resolveListFilter("flagged")).toEqual({ statuses: null, flaggedOnly: true })
    expect(resolveListFilter(undefined)).toEqual({ statuses: null, flaggedOnly: false })
  })

  it("timelineKindForStatus maps civfix statuses to design timeline icon kinds", () => {
    expect(timelineKindForStatus("submitted")).toBe("submit")
    expect(timelineKindForStatus("acknowledged")).toBe("route")
    expect(timelineKindForStatus("resolved")).toBe("done")
    expect(timelineKindForStatus("rejected")).toBe("remove")
    expect(timelineKindForStatus("in_progress")).toBe("status")
  })
})

describe("admin reports list", () => {
  it("projects a list row with confirmations, coords, and rel+abs submitted", async () => {
    const { repo, svc } = harness()
    repo.seedReport({
      id: "11111111-1111-1111-1111-111111111111",
      category: "trash",
      status: "submitted",
      title: "Overflowing bin",
      place: "Los Angeles",
      confirmations: 4,
      address: "5th & Main",
      lat: 34.05,
      lng: -118.24,
      hasPhoto: true,
      createdAt: hoursAgo(3),
      reporter: {
        id: "u-1",
        name: "Jane Neighbor",
        handle: "jane",
        emailVerified: true,
        hasOauth: false,
        joinedAt: new Date(Date.UTC(2025, 0, 1)),
      },
    })

    const page = await svc.list({})
    expect(page.items).toHaveLength(1)
    const row = page.items[0]!
    expect(row.category).toBe("trash")
    expect(row.status).toBe("submitted")
    expect(row.confirmations).toBe(4)
    expect(row.coords).toEqual([34.05, -118.24])
    expect(row.hasPhoto).toBe(true)
    expect(row.submitted.rel).toBe("3h")
    expect(row.submitted.abs).toContain("2026")
  })

  it("projects a named reporter, and falls back to Anonymous for a report with no reporter", async () => {
    const { repo, svc } = harness()
    repo.seedReport({
      id: "a",
      reporter: {
        id: "u",
        name: "Al",
        handle: "al",
        emailVerified: false,
        hasOauth: false,
        joinedAt: null,
      },
    })
    repo.seedReport({ id: "b", reporter: null })
    const items = (await svc.list({})).items
    const a = items.find((i) => i.id === "a")!
    const b = items.find((i) => i.id === "b")!
    expect(a.reporter.name).toBe("Al")
    expect(b.reporter.name).toBe("Anonymous")
    expect(b.reporter.handle).toBe("anonymous")
    expect(b.reporter.id).toBeNull()
  })

  it("filters by status bucket and by flagged (published/held are Submitted, not Completed)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "s", status: "submitted" })
    // A live, just-published pin and a held one both belong in the Submitted bucket.
    repo.seedReport({ id: "pub", status: "published" })
    repo.seedReport({ id: "held", status: "held" })
    repo.seedReport({ id: "ack", status: "acknowledged" })
    repo.seedReport({ id: "p", status: "in_progress" })
    repo.seedReport({ id: "r", status: "resolved" })
    repo.seedReport({ id: "f", status: "submitted", flagged: true })

    expect((await svc.list({ filter: "submitted" })).items.map((i) => i.id).sort()).toEqual([
      "f",
      "held",
      "pub",
      "s",
    ])
    expect((await svc.list({ filter: "in_progress" })).items.map((i) => i.id).sort()).toEqual([
      "ack",
      "p",
    ])
    // Only a resolved report is Completed — a published (live) one must NOT show here.
    expect((await svc.list({ filter: "completed" })).items.map((i) => i.id)).toEqual(["r"])
    expect((await svc.list({ filter: "flagged" })).items.map((i) => i.id)).toEqual(["f"])
  })

  it("returns accurate per-bucket counts (published/held=Submitted, rejected excluded, flagged orthogonal)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "s", status: "submitted" })
    repo.seedReport({ id: "pub", status: "published" })
    repo.seedReport({ id: "held", status: "held" })
    repo.seedReport({ id: "ack", status: "acknowledged" })
    repo.seedReport({ id: "ip", status: "in_progress" })
    repo.seedReport({ id: "res", status: "resolved" })
    repo.seedReport({ id: "rej", status: "rejected" }) // removed -> excluded from every bucket
    repo.seedReport({ id: "f", status: "published", flagged: true })
    // counts span ALL statuses (not the active facet) so the chips are accurate regardless of the page.
    const { counts } = await svc.list({ filter: "completed" })
    expect(counts).toEqual({ all: 7, submitted: 4, in_progress: 2, completed: 1, flagged: 1 })
  })

  it("search matches title, place, id, and reporter name (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", title: "Pothole", place: "Austin", reporter: null })
    repo.seedReport({
      id: "rep-2",
      title: "Graffiti",
      place: "Dallas",
      reporter: {
        id: "u",
        name: "Maria",
        handle: "m",
        emailVerified: false,
        hasOauth: false,
        joinedAt: null,
      },
    })
    expect((await svc.list({ q: "pothole" })).items.map((i) => i.id)).toEqual(["rep-1"])
    expect((await svc.list({ q: "dallas" })).items.map((i) => i.id)).toEqual(["rep-2"])
    expect((await svc.list({ q: "REP-1" })).items.map((i) => i.id)).toEqual(["rep-1"])
    expect((await svc.list({ q: "maria" })).items.map((i) => i.id)).toEqual(["rep-2"])
  })

  it("paginates with a cursor (no overlap)", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedReport({ id: `r${i}`, createdAt: hoursAgo(i + 1) })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
  })
})

describe("admin reports detail", () => {
  it("returns desc + timeline + routing + media", async () => {
    const { repo, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      desc: "Trash piled on the corner",
      routing: {
        geoid: "0644000",
        dept: "LA Sanitation",
        place: "Los Angeles",
        contact: "san@lacity.gov",
        routed: true,
      },
      media: [{ id: "m1", kind: "image", r2Key: "r2://photo.jpg", thumbKey: "r2://thumb.jpg" }],
      timeline: [
        { status: "submitted", note: "Report submitted", who: "jane", createdAt: hoursAgo(5) },
      ],
    })
    const detail = await svc.get("rep-1")
    expect(detail.desc).toBe("Trash piled on the corner")
    expect(detail.city.dept).toBe("LA Sanitation")
    expect(detail.city.contact).toBe("san@lacity.gov")
    expect(detail.city.routed).toBe(true)
    expect(detail.media).toEqual([
      {
        id: "m1",
        kind: "image",
        url: "https://media.test/r2://photo.jpg",
        thumbUrl: "https://media.test/r2://thumb.jpg",
      },
    ])
    expect(detail.timeline).toHaveLength(1)
    expect(detail.timeline[0]).toMatchObject({ what: "Report submitted", kind: "submit" })
  })

  it("throws notFound for an unknown report", async () => {
    const { svc } = harness()
    await expect(svc.get("nope")).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("admin reports mutations", () => {
  it("setStatus changes the status, appends a timeline row, and audits", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "submitted" })
    await svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" })
    expect(repo.reports.get("rep-1")?.record.status).toBe("in_progress")
    expect(repo.timeline.get("rep-1")?.at(-1)).toMatchObject({ status: "in_progress" })
    expect(repo.audits.at(-1)).toMatchObject({
      action: "report.status_changed",
      target: "report:rep-1",
      meta: { status: "in_progress" },
    })
  })

  it("setStatus throws notFound for an unknown report", async () => {
    const { svc } = harness()
    await expect(
      svc.setStatus("nope", { status: "resolved", actorId: null }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("setStatus emits ONE report-chat system event carrying the NEW status", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "submitted" })
    await svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" })
    expect(emitter.events).toHaveLength(1)
    expect(emitter.events[0]).toMatchObject({
      reportId: "rep-1",
      status: "in_progress",
      kind: "status",
    })
  })

  it("setStatus still succeeds (and changes the status) even when the emitter rejects internally", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "submitted" })
    emitter.shouldThrow = true
    // The real emitter never throws (it swallows), but even if it did the status change must be independent.
    await expect(
      svc.setStatus("rep-1", { status: "resolved", actorId: "op-1" }),
    ).rejects.toThrow("emit boom")
    // The underlying transition committed BEFORE the emit, so it stuck regardless of the emit failure.
    expect(repo.reports.get("rep-1")?.record.status).toBe("resolved")
    expect(repo.timeline.get("rep-1")?.at(-1)).toMatchObject({ status: "resolved" })
  })

  it("flag toggles the abuse marker on then off, each with a timeline row + audit", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", flagged: false })
    const on = await svc.flag("rep-1", { reason: "looks off", actorId: "op-1" })
    expect(on).toBe(true)
    expect(repo.reports.get("rep-1")?.record.flagged).toBe(true)
    expect(repo.audits.at(-1)).toMatchObject({ action: "report.flagged" })

    const off = await svc.flag("rep-1", { reason: null, actorId: "op-1" })
    expect(off).toBe(false)
    expect(repo.reports.get("rep-1")?.record.flagged).toBe(false)
    expect(repo.audits.at(-1)).toMatchObject({ action: "report.unflagged" })
  })

  it("flag emits a report-chat system event carrying the report's current status", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "published", flagged: false })
    await svc.flag("rep-1", { reason: "looks off", actorId: "op-1" })
    expect(emitter.events).toEqual([
      { reportId: "rep-1", status: "published", kind: "status", note: "Flagged for review" },
    ])
  })

  it("flag still SUCCEEDS (returns the toggled state) even if the post-commit status read-back throws", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedReport({ id: "rep-1", flagged: false })
    // The flag toggle has already committed; simulate the read-back (added only to recover the status for
    // the chat mirror) throwing. It must NOT reject flag() — a 500 here would leave the admin thinking the
    // flag failed (and a retry would double-toggle).
    repo.getReport = () => Promise.reject(new Error("read boom"))
    const on = await svc.flag("rep-1", { reason: "looks off", actorId: "op-1" })
    expect(on).toBe(true)
    expect(repo.reports.get("rep-1")?.record.flagged).toBe(true)
    // The read-back failed, so no system message was mirrored — but the flag change stuck.
    expect(emitter.events).toHaveLength(0)
  })

  it("remove sets status rejected, appends a timeline row, and audits", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "submitted" })
    await svc.remove("rep-1", { reason: "spam", actorId: "op-1" })
    expect(repo.reports.get("rep-1")?.record.status).toBe("rejected")
    expect(repo.timeline.get("rep-1")?.at(-1)).toMatchObject({ status: "rejected" })
    expect(repo.audits.at(-1)).toMatchObject({ action: "report.removed", target: "report:rep-1" })
  })

  it("follow-up to reporter creates a notification + a timeline row + audit", async () => {
    const { repo, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      reporter: {
        id: "u-7",
        name: "Sam",
        handle: "sam",
        emailVerified: true,
        hasOauth: false,
        joinedAt: null,
      },
    })
    const result = await svc.sendFollowup("rep-1", {
      to: "reporter",
      body: "Thanks, we routed this to the city.",
      actorId: "op-1",
    })
    expect(result).toEqual({ to: "reporter", destination: "u-7" })
    expect(repo.notifications).toHaveLength(1)
    expect(repo.notifications[0]).toMatchObject({
      userId: "u-7",
      body: "Thanks, we routed this to the city.",
    })
    expect(repo.timeline.get("rep-1")?.at(-1)?.note).toBe("Follow-up sent to the reporter")
    expect(repo.audits.at(-1)).toMatchObject({
      action: "report.followup_sent",
      meta: { to: "reporter" },
    })
  })

  it("follow-up to reporter on an anonymous report is a 422 (no account to notify)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", reporter: null })
    await expect(
      svc.sendFollowup("rep-1", { to: "reporter", body: "hi", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })

  it("follow-up to city calls OutboundMailService.sendToCity (delivers + threads) + audits", async () => {
    const { repo, mailRepo, mailer, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      category: "hazard",
      place: "Los Angeles",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
    })
    const result = await svc.sendFollowup("rep-1", {
      to: "city",
      body: "Please prioritize this hazard.",
      actorId: "op-1",
    })
    expect(result).toEqual({ to: "city", destination: "311@lacity.gov" })
    // The mailer delivered to the city contact via the first-class sendOutbound envelope, From the
    // per-thread reply- address (the digest path; no Reply-To).
    const sent = mailer.sent.find((m) => m.to === "311@lacity.gov")
    expect(sent).toBeDefined()
    expect(sent?.outbound?.from).toMatch(/^"civfix" <reply-[a-z2-7]{12}@civfix\.org>$/)
    expect(sent?.outbound?.replyTo).toBeUndefined()
    // A jurisdiction (digest) thread was created with a MINTED 24-hex token (not geo-<geoid>) + an OUT
    // message. The reply token must satisfy the real inbound regex, so it is no longer geo-prefixed.
    const thread = [...mailRepo.threads.values()].find(
      (t) => t.jurisdictionGeoid === "0644000" && t.reportId === null,
    )
    expect(thread).toBeDefined()
    expect(thread?.threadToken).toMatch(/^[a-z2-7]{12}$/)
    expect(mailRepo.messagesOf(thread!.id).some((m) => m.direction === "out")).toBe(true)
    expect(repo.audits.at(-1)).toMatchObject({
      action: "report.followup_sent",
      meta: { to: "city" },
    })
  })

  it("follow-up to city with no contact on file is a 422", async () => {
    const { repo, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      routing: { geoid: "0644000", dept: "LA", place: "Los Angeles", contact: null, routed: false },
    })
    await expect(
      svc.sendFollowup("rep-1", { to: "city", body: "hi", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })
})

/**
 * M5: POST /admin/reports/:id/route emails a FULL report packet — the reporter's display name, the exact
 * lat/lng, the street address, presigned photo URLs and the raw JPEGs — off-platform. Three controls:
 *   (a) the report.routed audit is written INSIDE the outbound message insert's transaction, so a packet
 *       can never be sent without an audit row (it used to be written afterwards, best-effort, with the
 *       failure caught and downgraded to a log warning);
 *   (b) contactEmailOverride is constrained to the jurisdiction's OWN mail domain (it used to accept any
 *       address that merely parsed as an email — a one-request exfiltration channel);
 *   (c) a per-operator rate limit at the route (asserted at the HTTP layer, not here).
 */
describe("M5: routeToJurisdiction destination + audit", () => {
  function seedRoutable(h: Harness): void {
    h.repo.seedReport({
      id: "rep-1",
      status: "submitted",
      category: "hazard",
      place: "Los Angeles",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })
  }

  it("writes the report.routed audit IN-TX with the outbound message insert", async () => {
    const h = harness()
    seedRoutable(h)
    const { threadId, routedTo } = await h.svc.routeToJurisdiction("rep-1", {
      contactEmailOverride: null,
      note: null,
      actorId: "op-1",
    })
    expect(routedTo).toBe("311@lacity.gov")
    // The audit rode through MailRepository.insertMessage's `audit` param (the same seam the other mail
    // paths use), so it is recorded by the mail repo, not by a separate best-effort write.
    expect(h.mailRepo.audits.at(-1)).toMatchObject({
      actorId: "op-1",
      action: "report.routed",
      target: "report:rep-1",
      meta: { threadId, to: "311@lacity.gov", override: false },
    })
  })

  it("ACCEPTS an override on the jurisdiction's own domain (the real workflow: a different mailbox)", async () => {
    const h = harness()
    seedRoutable(h)
    const { routedTo } = await h.svc.routeToJurisdiction("rep-1", {
      contactEmailOverride: "Streets@LACity.gov",
      note: null,
      actorId: "op-1",
    })
    expect(routedTo).toBe("Streets@LACity.gov")
    expect(h.mailer.sent.some((m) => m.to === "Streets@LACity.gov")).toBe(true)
    expect(h.mailRepo.audits.at(-1)).toMatchObject({ meta: { override: true } })
  })

  it("REFUSES an override on a foreign domain, and sends NOTHING", async () => {
    const h = harness()
    seedRoutable(h)
    await expect(
      h.svc.routeToJurisdiction("rep-1", {
        contactEmailOverride: "attacker@evil.example",
        note: null,
        actorId: "op-1",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })
    expect(h.mailer.sent).toHaveLength(0)
    expect(h.mailRepo.audits).toHaveLength(0)
  })

  it("REFUSES a lookalike domain that merely ENDS WITH the jurisdiction's (evil-lacity.gov)", async () => {
    const h = harness()
    seedRoutable(h)
    await expect(
      h.svc.routeToJurisdiction("rep-1", {
        contactEmailOverride: "x@evil-lacity.gov",
        note: null,
        actorId: "op-1",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("REFUSES any override when the jurisdiction has NO contact on file (nothing to verify against)", async () => {
    const h = harness()
    h.repo.seedReport({
      id: "rep-2",
      status: "submitted",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: null,
        routed: false,
      },
    })
    await expect(
      h.svc.routeToJurisdiction("rep-2", {
        contactEmailOverride: "somebody@lacity.gov",
        note: null,
        actorId: "op-1",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })
    expect(h.mailer.sent).toHaveLength(0)
  })
})
