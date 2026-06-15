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
import { OUTBOUND_MAIL_TEMPLATE } from "../../src/services/admin/outbound-mail-service.js"

/**
 * Offline unit tests for the admin reports service over the in-memory AdminReportRepository (no DB, no
 * Docker). They cover the list (status + flagged facet, search, pagination), the detail projection
 * (timeline/routing/media/derived trust), status changes (timeline + audit), the flag toggle
 * (abuse-flag marker + audit), remove (-> rejected + audit), and the follow-up paths: to the reporter
 * (notification + timeline) and to the city (OutboundMailService.sendToCity + timeline), plus the pure
 * helpers. Mirrors admin-discovery.test.ts conventions.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

interface Harness {
  repo: InMemoryAdminReportRepository
  mailRepo: InMemoryMailRepository
  mailer: FakeMailer
  svc: AdminReportService
}

function harness(opts?: {
  presignMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
}): Harness {
  const repo = new InMemoryAdminReportRepository()
  repo.now = NOW
  const mailRepo = new InMemoryMailRepository()
  const mailer = new FakeMailer()
  const outboundMail = makeOutboundMailService({
    repo: mailRepo,
    mailer,
    env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
  })
  const svc = makeAdminReportService({
    repo,
    outboundMail,
    now: () => NOW,
    ...(opts?.presignMedia !== undefined ? { presignMedia: opts.presignMedia } : {}),
  })
  return { repo, mailRepo, mailer, svc }
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
  it("projects a list row with derived trust, confirmations, coords, and rel+abs submitted", async () => {
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
      media: [{ id: "m1", kind: "image", url: "r2://photo.jpg", thumbUrl: "r2://thumb.jpg" }],
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
      { id: "m1", kind: "image", url: "r2://photo.jpg", thumbUrl: "r2://thumb.jpg" },
    ])
    expect(detail.timeline).toHaveLength(1)
    expect(detail.timeline[0]).toMatchObject({ what: "Report submitted", kind: "submit" })
  })

  it("presigns media keys into browser-loadable URLs (and carries a null thumb through)", async () => {
    // The repo returns raw r2 keys; the service must run them through the injected presigner so the admin
    // photo box gets a loadable URL, not a key that 404s.
    const { repo, svc } = harness({
      presignMedia: async (r2Key, thumbKey) =>
        thumbKey === null
          ? { url: `https://cdn.test/${r2Key}?sig=x` }
          : { url: `https://cdn.test/${r2Key}?sig=x`, thumbUrl: `https://cdn.test/${thumbKey}?sig=x` },
    })
    repo.seedReport({
      id: "rep-2",
      media: [
        { id: "m1", kind: "image", url: "photo.jpg", thumbUrl: "thumb.jpg" },
        { id: "m2", kind: "video", url: "clip.mp4", thumbUrl: null },
      ],
    })
    const detail = await svc.get("rep-2")
    expect(detail.media).toEqual([
      { id: "m1", kind: "image", url: "https://cdn.test/photo.jpg?sig=x", thumbUrl: "https://cdn.test/thumb.jpg?sig=x" },
      { id: "m2", kind: "video", url: "https://cdn.test/clip.mp4?sig=x", thumbUrl: null },
    ])
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
    // The mailer delivered to the city contact via the outbound template.
    const sent = mailer.sent.find((m) => m.to === "311@lacity.gov")
    expect(sent).toBeDefined()
    expect(sent?.template).toBe(OUTBOUND_MAIL_TEMPLATE)
    // A jurisdiction thread (geo-<geoid>) was created with an OUT message.
    const thread = [...mailRepo.threads.values()].find((t) => t.threadToken === "geo-0644000")
    expect(thread).toBeDefined()
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
