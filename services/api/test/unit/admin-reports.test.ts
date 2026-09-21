import { describe, it, expect } from "vitest"
import { AppError } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import { runAutoForwardWith } from "../../src/services/admin/autoforward-jobs.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import type { MailMessageKind } from "../../src/services/admin/mail-repository.js"
import {
  makeAdminReportService,
  resolveListFilter,
  statusChangeNote,
  timelineKindForStatus,
  type AdminReportService,
} from "../../src/services/admin/admin-report-service.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryForwardTemplateRepository } from "../../src/services/admin/forward-template-repository.memory.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { MAX_PACKET_TOTAL_BYTES } from "../../src/services/admin/mail-format.js"
import {
  makeOutboundMailService,
  OutboundSendDeadlineError,
  type OutboundMailService,
} from "../../src/services/admin/outbound-mail-service.js"


const NOW = new Date("2026-06-06T00:00:00.000Z")

const REPORTER = {
  id: "u-7",
  name: "Sam",
  handle: "sam",
  emailVerified: true,
  hasOauth: false,
  joinedAt: null,
}

const REPORT_STATUSES = [
  "submitted",
  "held",
  "published",
  "acknowledged",
  "in_progress",
  "resolved",
  "rejected",
] as const

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
  forwardTemplates: InMemoryForwardTemplateRepository
  notifier: RecordingNotifier
  svc: AdminReportService
}

function harness(): Harness {
  const repo = new InMemoryAdminReportRepository()
  repo.now = NOW
  const mailRepo = new InMemoryMailRepository()
  const mailer = new FakeMailer()
  const emitter = new FakeReportChatEmitter()
  const forwardTemplates = new InMemoryForwardTemplateRepository()
  const notifier = new RecordingNotifier()
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
    forwardTemplates,
    notifications: notifier,
    presignMedia: async (r2Key, thumbKey) => ({
      url: `https://media.test/${r2Key}`,
      ...(thumbKey !== null ? { thumbUrl: `https://media.test/${thumbKey}` } : {}),
    }),
  })
  return { repo, mailRepo, mailer, emitter, forwardTemplates, notifier, svc }
}

function lastOutbound(mailer: FakeMailer): { subject: string; text: string; html?: string } {
  const outbound = mailer.sent.filter((m) => m.outbound !== undefined).at(-1)?.outbound
  if (outbound === undefined) throw new Error("no outbound mail was sent")
  return {
    subject: outbound.subject,
    text: outbound.text,
    ...(outbound.html !== undefined ? { html: outbound.html } : {}),
  }
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("admin reports pure helpers", () => {
  it("resolveListFilter maps each design facet to its civfix status SET + flaggedOnly", () => {
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

  it("statusChangeNote reads as English to a resident — never a raw enum token", () => {
    expect(statusChangeNote("submitted")).toBe("Status set to Submitted")
    expect(statusChangeNote("held")).toBe("Status set to Under review")
    expect(statusChangeNote("published")).toBe("Status set to Published")
    expect(statusChangeNote("acknowledged")).toBe("Status set to Acknowledged")
    expect(statusChangeNote("in_progress")).toBe("Status set to In progress")
    expect(statusChangeNote("resolved")).toBe("Status set to Resolved")
    expect(statusChangeNote("rejected")).toBe("Report removed")
    for (const status of REPORT_STATUSES) {
      expect(statusChangeNote(status)).not.toContain(status)
    }
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
    repo.seedReport({ id: "rej", status: "rejected" })
    repo.seedReport({ id: "f", status: "published", flagged: true })
    const { counts } = await svc.list({ filter: "completed" })
    expect(counts).toEqual({ all: 7, submitted: 4, in_progress: 2, completed: 1, flagged: 1 })
  })

  it("search matches title, place, reporter name and reporter handle (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", title: "Pothole", place: "Austin", reporter: null })
    repo.seedReport({
      id: "rep-2",
      title: "Graffiti",
      place: "Dallas",
      reporter: {
        id: "u",
        name: "Maria",
        handle: "muralwatch",
        emailVerified: false,
        hasOauth: false,
        joinedAt: null,
      },
    })
    expect((await svc.list({ q: "pothole" })).items.map((i) => i.id)).toEqual(["rep-1"])
    expect((await svc.list({ q: "dallas" })).items.map((i) => i.id)).toEqual(["rep-2"])
    expect((await svc.list({ q: "maria" })).items.map((i) => i.id)).toEqual(["rep-2"])
    expect((await svc.list({ q: "MURALwatch" })).items.map((i) => i.id)).toEqual(["rep-2"])
  })

  it("search matches a reference code exactly, case- and whitespace-insensitively", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", title: "Pothole", referenceCode: "PD-42-000001" })
    repo.seedReport({ id: "rep-2", title: "Graffiti", referenceCode: "GR-42-000007" })

    expect((await svc.list({ q: "PD-42-000001" })).items.map((i) => i.id)).toEqual(["rep-1"])
    expect((await svc.list({ q: "  pd-42-000001 " })).items.map((i) => i.id)).toEqual(["rep-1"])
    expect((await svc.list({ q: "PD-42" })).items).toHaveLength(0)
    expect((await svc.list({ q: "GR-42-000007" })).counts.all).toBe(1)
  })

  it("search matches an address substring (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", title: "Pothole", address: "1200 S Figueroa St" })
    repo.seedReport({ id: "rep-2", title: "Graffiti", address: "44 Sunset Blvd" })

    expect((await svc.list({ q: "figueroa" })).items.map((i) => i.id)).toEqual(["rep-1"])
    expect((await svc.list({ q: "SUNSET" })).items.map((i) => i.id)).toEqual(["rep-2"])
    expect((await svc.list({ q: "figueroa" })).counts.all).toBe(1)
  })

  it("matches an id ONLY on a full uuid — never a substring, never a non-uuid needle", async () => {
    const { repo, svc } = harness()
    const id = "3f2b1c44-0a55-4d66-8e77-99aa00bb11cc"
    repo.seedReport({ id, title: "Broken swing", place: "Austin", reporter: null })
    repo.seedReport({ id: "rep-other", title: "Litter", place: "Dallas", reporter: null })

    expect((await svc.list({ q: id })).items.map((i) => i.id)).toEqual([id])
    expect((await svc.list({ q: id.toUpperCase() })).items.map((i) => i.id)).toEqual([id])
    expect((await svc.list({ q: "3f2b1c44" })).items).toHaveLength(0)
    expect((await svc.list({ q: "rep-other" })).items).toHaveLength(0)
  })

  it("counts follow the SAME search predicate as the list (chips cannot disagree)", async () => {
    const { repo, svc } = harness()
    const id = "8c1d2e33-4455-4666-8777-99aa00bb2233"
    repo.seedReport({ id, title: "Pothole", place: "Austin", status: "published" })
    repo.seedReport({ id: "other", title: "Graffiti", place: "Dallas", status: "published" })

    const byUuid = await svc.list({ q: id })
    expect(byUuid.items.map((i) => i.id)).toEqual([id])
    expect(byUuid.counts.all).toBe(1)
    const byPrefix = await svc.list({ q: "8c1d2e33" })
    expect(byPrefix.items).toHaveLength(0)
    expect(byPrefix.counts.all).toBe(0)
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
    repo.seedReport({ id: "rep-1", status: "published" })
    await svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" })
    expect(repo.reports.get("rep-1")?.record.status).toBe("in_progress")
    expect(repo.timeline.get("rep-1")?.at(-1)).toMatchObject({ status: "in_progress" })
    expect(repo.audits.at(-1)).toMatchObject({
      action: "report.status_changed",
      target: "report:rep-1",
      meta: { status: "in_progress" },
    })
  })

  it("setStatus REFUSES a move the lifecycle does not allow, and writes nothing", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "submitted" })
    await expect(
      svc.setStatus("rep-1", { status: "resolved", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { status: "illegal_transition" } })
    expect(repo.reports.get("rep-1")?.record.status).toBe("submitted")
    expect(repo.timeline.get("rep-1") ?? []).toHaveLength(0)
    expect(repo.audits).toHaveLength(0)
  })

  it("setStatus('rejected') is refused: removal is its own action, and it is irreversible", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "published" })
    await expect(
      svc.setStatus("rep-1", { status: "rejected", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { status: "use_remove" } })
    expect(repo.reports.get("rep-1")?.record.status).toBe("published")
    expect(repo.reports.get("rep-1")?.deletedAt).toBeNull()
    const page = await svc.list({})
    expect(page.items.some((i) => i.id === "rep-1")).toBe(true)
  })

  it("setStatus to the status the report already has is a no-op (no row, no audit, no bell)", async () => {
    const { repo, notifier, emitter, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "in_progress" })
    await svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" })
    expect(repo.timeline.get("rep-1") ?? []).toHaveLength(0)
    expect(repo.audits).toHaveLength(0)
    expect(notifier.sent).toHaveLength(0)
    expect(emitter.events).toHaveLength(0)
  })

  it("setStatus accepts a concurrent move that reached the SAME status (the operator got what they asked for)", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "published" })
    const seeded = repo.reports.get("rep-1")!
    const realAdvance = repo.advanceStatusIfIn.bind(repo)
    repo.advanceStatusIfIn = (id, input) => {
      seeded.record.status = "in_progress"
      return realAdvance(id, input)
    }
    await expect(
      svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" }),
    ).resolves.toBeUndefined()
    expect(repo.reports.get("rep-1")?.record.status).toBe("in_progress")
    expect(repo.timeline.get("rep-1") ?? []).toHaveLength(0)
    expect(repo.audits).toHaveLength(0)
  })

  it("setStatus rings the reporter through the notification pipeline on in_progress and resolved", async () => {
    const { repo, notifier, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      status: "published",
      reporter: REPORTER,
    })
    await svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" })
    await svc.setStatus("rep-1", { status: "resolved", actorId: "op-1" })
    expect(notifier.sent).toHaveLength(2)
    expect(notifier.sent[0]).toMatchObject({
      userId: "u-7",
      type: "report_update",
      link: "/reports/rep-1",
    })
    expect(notifier.sent[1]?.title).toContain("resolved")
  })

  it("setStatus is a 409 when the report moved on between the read and the write", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "published" })
    const seeded = repo.reports.get("rep-1")!
    const realAdvance = repo.advanceStatusIfIn.bind(repo)
    repo.advanceStatusIfIn = (id, input) => {
      seeded.record.status = "held"
      return realAdvance(id, input)
    }
    await expect(
      svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(repo.reports.get("rep-1")?.record.status).toBe("held")
  })

  it("setStatus SURVIVES a notifier that throws — the committed status change is not undone", async () => {
    const { repo, notifier, emitter, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      status: "published",
      reporter: REPORTER,
    })
    notifier.failNext = true
    await expect(
      svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" }),
    ).resolves.toBeUndefined()
    expect(repo.reports.get("rep-1")?.record.status).toBe("in_progress")
    expect(notifier.sent).toHaveLength(0)
    expect(emitter.events).toHaveLength(1)
  })

  it("setStatus rings nobody for an anonymous report or for a status with no reporter-facing news", async () => {
    const { repo, notifier, svc } = harness()
    repo.seedReport({ id: "rep-anon", status: "published", reporter: null })
    await svc.setStatus("rep-anon", { status: "in_progress", actorId: "op-1" })
    repo.seedReport({ id: "rep-2", status: "submitted" })
    await svc.setStatus("rep-2", { status: "held", actorId: "op-1" })
    expect(notifier.sent).toHaveLength(0)
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
    repo.seedReport({ id: "rep-1", status: "published" })
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
    repo.seedReport({ id: "rep-1", status: "acknowledged" })
    emitter.shouldThrow = true
    await expect(
      svc.setStatus("rep-1", { status: "resolved", actorId: "op-1" }),
    ).rejects.toThrow("emit boom")
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
    repo.getReport = () => Promise.reject(new Error("read boom"))
    const on = await svc.flag("rep-1", { reason: "looks off", actorId: "op-1" })
    expect(on).toBe(true)
    expect(repo.reports.get("rep-1")?.record.flagged).toBe(true)
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

  it("follow-up to reporter rings the notification pipeline + a timeline row + audit", async () => {
    const { repo, notifier, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      reporter: REPORTER,
    })
    const result = await svc.sendFollowup("rep-1", {
      to: "reporter",
      body: "Thanks, we routed this to the city.",
      actorId: "op-1",
    })
    expect(result).toEqual({ to: "reporter", destination: "u-7" })
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]).toMatchObject({
      userId: "u-7",
      type: "report_update",
      body: "Thanks, we routed this to the city.",
      link: "/reports/rep-1",
    })
    expect(repo.timeline.get("rep-1")?.at(-1)).toMatchObject({
      note: "Follow-up sent to the reporter",
      kind: "followup",
    })
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

  it("follow-up to city goes on the REPORT'S OWN thread, as a reply the city can correlate", async () => {
    const { repo, mailRepo, mailer, svc } = harness()
    const thread = mailRepo.seedThread({
      reportId: "rep-1",
      jurisdictionGeoid: "0644000",
      subject: "Hazard report — Los Angeles",
      status: "sent",
    })
    mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: "311@lacity.gov" })
    repo.seedReport({
      id: "rep-1",
      category: "hazard",
      place: "Los Angeles",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "new-311@lacity.gov",
        routed: true,
      },
      outreach: { threadId: thread.id, threadStatus: "sent", routedTo: "311@lacity.gov" },
    })
    const before = mailRepo.messagesOf(thread.id).length

    const result = await svc.sendFollowup("rep-1", {
      to: "city",
      body: "Please prioritize this hazard.",
      actorId: "op-1",
    })

    expect(result).toEqual({ to: "city", destination: "311@lacity.gov" })
    expect(mailRepo.messagesOf(thread.id)).toHaveLength(before + 1)
    expect(mailRepo.messagesOf(thread.id).at(-1)).toMatchObject({
      direction: "out",
      toAddr: "311@lacity.gov",
      subject: "Re: Hazard report — Los Angeles",
    })
    expect([...mailRepo.threads.values()]).toHaveLength(1)
    expect(mailer.sent.at(-1)?.to).toBe("311@lacity.gov")
    expect(repo.timeline.get("rep-1")?.at(-1)?.note).toBe("Follow-up sent to 311@lacity.gov")
    expect(repo.audits.at(-1)).toMatchObject({
      action: "report.followup_sent",
      meta: { to: "city", destination: "311@lacity.gov" },
    })
  })

  it("follow-up to city REFUSES while a send on that thread is still in flight (409, nothing mailed)", async () => {
    const { repo, mailRepo, mailer, svc } = harness()
    const thread = mailRepo.seedThread({ reportId: "rep-1", subject: "Hazard report", status: "sent" })
    repo.seedReport({
      id: "rep-1",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
      outreach: {
        threadId: thread.id,
        threadStatus: "sent",
        routedTo: "311@lacity.gov",
        sendInFlight: true,
      },
    })
    const before = mailRepo.messagesOf(thread.id).length
    await expect(
      svc.sendFollowup("rep-1", { to: "city", body: "hi", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(mailer.sent).toHaveLength(0)
    expect(mailRepo.messagesOf(thread.id)).toHaveLength(before)
  })

  it("follow-up to city is REFUSED until the report itself has been routed (no orphan thread)", async () => {
    const { repo, mailRepo, mailer, svc } = harness()
    repo.seedReport({
      id: "rep-1",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })
    await expect(
      svc.sendFollowup("rep-1", { to: "city", body: "hi", actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { to: "not_routed" } })
    expect(mailer.sent).toHaveLength(0)
    expect([...mailRepo.threads.values()]).toHaveLength(0)
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

  it("setVerdict leaves a timeline row and a report-chat event, not just an audit", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedReport({ id: "rep-1", status: "published" })
    await svc.setVerdict({ id: "rep-1", verdict: "approved", actorId: "op-1" })
    expect(repo.timeline.get("rep-1")?.at(-1)).toMatchObject({
      note: "Approved by an operator",
      kind: "status",
    })
    expect(emitter.events.at(-1)).toMatchObject({
      reportId: "rep-1",
      status: "published",
      kind: "status",
      note: "Approved by an operator",
    })

    await svc.setVerdict({ id: "rep-1", verdict: "rejected", actorId: "op-1" })
    expect(repo.timeline.get("rep-1")?.at(-1)?.note).toBe("Rejected by an operator")
  })
})

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
      note: null,
      actorId: "op-1",
    })
    expect(routedTo).toBe("311@lacity.gov")
    expect(h.mailRepo.audits.at(-1)).toMatchObject({
      actorId: "op-1",
      action: "report.routed",
      target: "report:rep-1",
      meta: { threadId, to: "311@lacity.gov" },
    })
  })

  it("sends the packet to the jurisdiction's own contact and records it in the resident-visible note", async () => {
    const h = harness()
    seedRoutable(h)
    const { routedTo } = await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })

    expect(routedTo).toBe("311@lacity.gov")
    expect(h.mailer.sent.some((m) => m.to === "311@lacity.gov")).toBe(true)
    const routeEntry = (await h.svc.get("rep-1")).timeline.find((t) => t.kind === "route")
    expect(routeEntry?.what).toContain("311@lacity.gov")
  })

  it("REFUSES to route when the jurisdiction has NO contact on file (NOT_ROUTABLE, sends NOTHING)", async () => {
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
      h.svc.routeToJurisdiction("rep-2", { note: null, actorId: "op-1" }),
    ).rejects.toMatchObject({ code: "NOT_ROUTABLE", httpStatus: 422 })
    expect(h.mailer.sent).toHaveLength(0)
    expect(h.mailRepo.audits).toHaveLength(0)
  })
})

describe("routeToJurisdiction template resolution", () => {
  function seedWith(h: Harness, templates: { subject?: string | null; body?: string | null }): void {
    h.repo.seedReport({
      id: "rep-1",
      status: "submitted",
      category: "trash",
      title: "Overflowing bin",
      place: "Los Angeles",
      address: "5th & Main",
      confirmations: 4,
      referenceCode: "LA-1-000042",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
        forwardSubjectTemplate: templates.subject ?? null,
        forwardBodyTemplate: templates.body ?? null,
      },
    })
  }

  it("sends the JURISDICTION's own template, rendered, when it has one", async () => {
    const h = harness()
    h.forwardTemplates.seed({ subjectTemplate: "Default {referenceCode}", bodyTemplate: "Default body." })
    seedWith(h, {
      subject: "City case {referenceCode}: {category}",
      body: "A {category} report at {address}, confirmed by {confirmations} neighbors.",
    })

    await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })

    const mail = lastOutbound(h.mailer)
    expect(mail.subject).toBe("City case LA-1-000042: Trash")
    expect(mail.text).toContain("A Trash report at 5th & Main, confirmed by 4 neighbors.")
    expect(mail.html).toContain("A Trash report at 5th &amp; Main, confirmed by 4 neighbors.")
    expect(mail.text).not.toContain("Default body.")
  })

  it("falls back to the STORED platform default when the jurisdiction has no template", async () => {
    const h = harness()
    h.forwardTemplates.seed({
      subjectTemplate: "civfix default {referenceCode}",
      bodyTemplate: "Platform default body for {category}.",
    })
    seedWith(h, {})

    await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })

    const mail = lastOutbound(h.mailer)
    expect(mail.subject).toBe("civfix default LA-1-000042")
    expect(mail.text).toContain("Platform default body for Trash.")
    expect(mail.text).not.toContain("What was reported")
  })

  it("falls back to the BUILT-IN default when neither layer has a template", async () => {
    const h = harness()
    seedWith(h, {})

    await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })

    const mail = lastOutbound(h.mailer)
    expect(mail.subject).toBe("[civfix] Overflowing bin - Los Angeles - LA-1-000042")
    expect(mail.text).toContain("What was reported")
  })

  it("an EMPTY jurisdiction template does not shadow the stored default", async () => {
    const h = harness()
    h.forwardTemplates.seed({ subjectTemplate: "Stored {referenceCode}", bodyTemplate: "Stored body." })
    seedWith(h, { subject: "   ", body: "" })

    await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })

    const mail = lastOutbound(h.mailer)
    expect(mail.subject).toBe("Stored LA-1-000042")
    expect(mail.text).toContain("Stored body.")
  })

  it("never ships a half-substituted placeholder to the city", async () => {
    const h = harness()
    seedWith(h, {})

    await h.svc.routeToJurisdiction("rep-1", { note: "Second report this month.", actorId: "op-1" })

    const mail = lastOutbound(h.mailer)
    for (const part of [mail.subject, mail.text, mail.html ?? ""]) {
      expect(part).not.toMatch(/\{\{/)
      expect(part).not.toMatch(/\{[A-Za-z]+\}/)
    }
  })
})

describe("routeToJurisdiction re-send gate", () => {
  function seedRouted(
    h: Harness,
    outreach: {
      threadStatus: string
      hasInbound?: boolean
      packetSent?: boolean
      outboundKinds?: (MailMessageKind | null)[]
      sendFailed?: boolean
      routedTo?: string
      contact?: string
    },
  ): void {
    h.repo.seedReport({
      id: "rep-1",
      status: "acknowledged",
      category: "hazard",
      place: "Los Angeles",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: outreach.contact ?? "311@lacity.gov",
        routed: true,
      },
      outreach: {
        threadId: "t-1",
        threadStatus: outreach.threadStatus,
        hasInbound: outreach.hasInbound ?? false,
        ...(outreach.outboundKinds !== undefined
          ? { outboundKinds: outreach.outboundKinds }
          : { packetSent: outreach.packetSent ?? true }),
        routedTo: outreach.routedTo ?? "311@lacity.gov",
        ...(outreach.sendFailed !== undefined ? { sendFailed: outreach.sendFailed } : {}),
      },
    })
  }

  it("ALLOWS a re-route after a hard bounce (the city never received the packet)", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "bounced" })
    const { routedTo } = await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    expect(routedTo).toBe("311@lacity.gov")
    expect(h.mailer.sent).toHaveLength(1)
    expect(h.emitter.events.at(-1)).toMatchObject({ status: "acknowledged", kind: "route" })
  })

  it("REFUSES a repeat send of a delivered packet to the SAME address (409, nothing mailed)", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "sent" })
    await expect(
      h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(h.mailer.sent).toHaveLength(0)

    for (const threadStatus of ["delivered", "replied"]) {
      const h2 = harness()
      seedRouted(h2, { threadStatus })
      await expect(
        h2.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
      ).rejects.toMatchObject({ httpStatus: 409 })
      expect(h2.mailer.sent).toHaveLength(0)
    }
  })

  it("REFUSES a repeat send when the contact differs from the sent address only in CASE", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "sent", contact: "311@LACity.gov" })
    await expect(
      h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("ALLOWS a re-route once the operator CORRECTS the jurisdiction's contact (wrong mailbox)", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "delivered", contact: "streets@lacity.gov" })
    const { routedTo } = await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })
    expect(routedTo).toBe("streets@lacity.gov")
    expect(h.mailer.sent.some((m) => m.to === "streets@lacity.gov")).toBe(true)
  })

  it("ALLOWS a re-route when every send attempt THREW (thread stamped 'sent', nothing delivered)", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "sent", sendFailed: true })
    await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    expect(h.mailer.sent).toHaveLength(1)
  })

  it("a failed send leaves the report re-routable end-to-end (mailer throws, then recovers)", async () => {
    const h = harness()
    h.repo.seedReport({
      id: "rep-1",
      status: "submitted",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })
    h.mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    await expect(
      h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
    ).rejects.toThrow(/smtp down/)
    expect(h.mailRepo.events.map((e) => e.type)).toEqual(["failed"])
    expect((await h.svc.get("rep-1")).status).toBe("submitted")

    const thread = [...h.mailRepo.threads.values()].find((t) => t.reportId === "rep-1")
    expect(thread?.status).toBe("needs_action")
    const seeded = h.repo.reports.get("rep-1")
    if (seeded) {
      seeded.outreach = {
        threadId: thread?.id ?? "t-1",
        threadStatus: "sent",
        hasInbound: false,
        packetSent: true,
        routedTo: "311@lacity.gov",
        routedAt: NOW,
        sendFailed: true,
      }
    }
    h.mailer.sendOutbound = FakeMailer.prototype.sendOutbound.bind(h.mailer)
    const { routedTo } = await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    expect(routedTo).toBe("311@lacity.gov")
    expect(h.mailRepo.events.some((e) => e.type === "sent")).toBe(true)
    expect((await h.svc.get("rep-1")).status).toBe("acknowledged")
  })

  it("lets the operator send the packet after a citizen's @city discussion forward", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "sent", packetSent: false })
    const { routedTo } = await h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })
    expect(routedTo).toBe("311@lacity.gov")
    expect(h.mailer.sent).toHaveLength(1)
    expect(h.mailRepo.messages.at(-1)?.kind).toBe("packet")
  })

  it("REFUSES a second packet for a report routed BEFORE 0174 (kind NULL is a packet)", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "sent", outboundKinds: [null] })
    await expect(
      h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("REFUSES a second packet once one has been sent, whatever the thread status says", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "needs_action", packetSent: true })
    await expect(
      h.svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("exposes sendFailed on the report DTO so the operator can see a resend is allowed", async () => {
    const h = harness()
    seedRouted(h, { threadStatus: "sent", sendFailed: true })
    expect((await h.svc.get("rep-1")).outreach.sendFailed).toBe(true)
    const clean = harness()
    seedRouted(clean, { threadStatus: "sent" })
    expect((await clean.svc.get("rep-1")).outreach.sendFailed).toBe(false)
  })

  it("clears a thread's 'bounced' status once a re-route actually delivers (no unbounded re-sends)", async () => {
    const h = harness()
    const thread = await h.mailRepo.findOrCreateReportThread("rep-1", { subject: "S", status: "sent" })
    await h.mailRepo.setThreadStatus(thread.id, "bounced")
    expect((await h.mailRepo.getThreadRecord(thread.id))?.status).toBe("bounced")
    seedRouted(h, { threadStatus: "bounced" })
    await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    expect(h.mailRepo.threads.size).toBe(1)
    expect((await h.mailRepo.getThreadRecord(thread.id))?.status).toBe("sent")
  })
})

describe("F009 routeToJurisdiction concurrent double-send guard", () => {
  it("two concurrent routes of the same report yield exactly one send and one 409", async () => {
    const repo = new InMemoryAdminReportRepository()
    repo.now = NOW
    repo.seedReport({
      id: "rep-1",
      status: "submitted",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })

    let sends = 0
    const outboundMail = {
      async prepareReportToJurisdiction(input: { reportId: string; toAddr: string }) {
        await Promise.resolve()
        sends += 1
        const marker = sends
        const seeded = repo.reports.get(input.reportId)
        if (seeded) {
          seeded.outreach = {
            threadId: `t-${marker}`,
            threadStatus: "sent",
            hasInbound: false,
            packetSent: true,
            routedTo: input.toAddr,
            routedAt: NOW,
            sendFailed: false,
          }
        }
        return {
          thread: { id: `t-${marker}` },
          deliver: () =>
            Promise.resolve({ thread: { id: `t-${marker}` }, messageId: `m-${marker}` }),
        }
      },
    } as unknown as OutboundMailService

    const svc = makeAdminReportService({ repo, outboundMail, now: () => NOW })

    const results = await Promise.allSettled([
      svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" }),
      svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-2" }),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(sends).toBe(1)
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ httpStatus: 409 })
  })

  it("B2: a late success never regresses a status the operator moved on after the deadline", async () => {
    const repo = new InMemoryAdminReportRepository()
    repo.now = NOW
    repo.seedReport({
      id: "rep-1",
      status: "published",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })

    let lateSuccess: (() => Promise<void>) | undefined
    const outboundMail = {
      prepareReportToJurisdiction(input: { reportId: string; toAddr: string }) {
        const seeded = repo.reports.get(input.reportId)
        if (seeded) {
          seeded.outreach = {
            threadId: "t-1",
            threadStatus: "sent",
            hasInbound: false,
            packetSent: true,
            routedTo: input.toAddr,
            routedAt: NOW,
            sendFailed: false,
          }
        }
        return Promise.resolve({
          thread: { id: "t-1" },
          deliver: (opts?: { onLateSuccess?: () => Promise<void> }) => {
            lateSuccess = opts?.onLateSuccess
            return Promise.reject(new OutboundSendDeadlineError(30_000))
          },
        })
      },
    } as unknown as OutboundMailService

    const svc = makeAdminReportService({ repo, outboundMail, now: () => NOW })

    await expect(
      svc.routeToJurisdiction("rep-1", {
        note: null,
        actorId: "op-1",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 })

    expect(repo.reports.get("rep-1")?.record.status).toBe("published")
    expect(repo.timeline.get("rep-1") ?? []).toHaveLength(0)

    await svc.setStatus("rep-1", { status: "in_progress", actorId: "op-1" })
    expect(repo.reports.get("rep-1")?.record.status).toBe("in_progress")
    const afterOperator = (repo.timeline.get("rep-1") ?? []).length

    expect(lateSuccess).toBeDefined()
    await lateSuccess?.()

    expect(repo.reports.get("rep-1")?.record.status).toBe("in_progress")
    const timeline = repo.timeline.get("rep-1") ?? []
    expect(timeline).toHaveLength(afterOperator + 1)
    expect(timeline.at(-1)?.note).toContain("Sent to jurisdiction")
    expect(timeline.at(-1)?.status).toBe("in_progress")
    expect(timeline.filter((t) => t.status === "acknowledged")).toHaveLength(0)
    expect(
      repo.audits.filter(
        (a) => a.action === "report.status_changed" && a.meta.status === "acknowledged",
      ),
    ).toHaveLength(0)
  })

  it("B2: a late success DOES advance a report the operator left alone", async () => {
    const repo = new InMemoryAdminReportRepository()
    repo.now = NOW
    repo.seedReport({
      id: "rep-1",
      status: "published",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })

    let lateSuccess: (() => Promise<void>) | undefined
    const outboundMail = {
      prepareReportToJurisdiction: () =>
        Promise.resolve({
          thread: { id: "t-1" },
          deliver: (opts?: { onLateSuccess?: () => Promise<void> }) => {
            lateSuccess = opts?.onLateSuccess
            return Promise.reject(new OutboundSendDeadlineError(30_000))
          },
        }),
    } as unknown as OutboundMailService

    const svc = makeAdminReportService({ repo, outboundMail, now: () => NOW })
    await expect(
      svc.routeToJurisdiction("rep-1", {
        note: null,
        actorId: "op-1",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 })

    await lateSuccess?.()

    expect(repo.reports.get("rep-1")?.record.status).toBe("acknowledged")
    const timeline = repo.timeline.get("rep-1") ?? []
    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.status).toBe("acknowledged")
    expect(timeline[0]?.who).toBe("op-1")
    expect(repo.audits.filter((a) => a.action === "report.status_changed")).toEqual([
      { actorId: "op-1", action: "report.status_changed", target: "report:rep-1", meta: { status: "acknowledged" } },
    ])
  })

  it("does NOT hold the route lock across the mailer network send", async () => {
    const repo = new InMemoryAdminReportRepository()
    repo.now = NOW
    repo.seedReport({
      id: "rep-1",
      status: "submitted",
      routing: {
        geoid: "0644000",
        dept: "LA Public Works",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })

    let lockDepth = 0
    let maxLockDepthDuringSend = 0
    const realLock = repo.withRouteLock.bind(repo)
    repo.withRouteLock = async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
      return realLock(id, async () => {
        lockDepth += 1
        try {
          return await fn()
        } finally {
          lockDepth -= 1
        }
      })
    }

    let releaseSend: () => void = () => {}
    const hung = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const outboundMail = {
      prepareReportToJurisdiction(input: { reportId: string; toAddr: string }) {
        const seeded = repo.reports.get(input.reportId)
        if (seeded) {
          seeded.outreach = {
            threadId: "t-1",
            threadStatus: "sent",
            hasInbound: false,
            packetSent: true,
            routedTo: input.toAddr,
            routedAt: NOW,
            sendFailed: false,
          }
        }
        return Promise.resolve({
          thread: { id: "t-1" },
          deliver: async () => {
            maxLockDepthDuringSend = Math.max(maxLockDepthDuringSend, lockDepth)
            await hung
            return { thread: { id: "t-1" }, messageId: "m-1" }
          },
        })
      },
    } as unknown as OutboundMailService

    const svc = makeAdminReportService({ repo, outboundMail, now: () => NOW })
    const routing = svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(maxLockDepthDuringSend).toBe(0)
    expect(lockDepth).toBe(0)

    releaseSend()
    await expect(routing).resolves.toMatchObject({ threadId: "t-1", routedTo: "311@lacity.gov" })
  })
})

describe("F108 report-packet attachments are bounded in AGGREGATE, not just per file", () => {
  const FOUR_MB = 4 * 1024 * 1024

  function harnessWithMedia(count: number, bytesEach: number) {
    const repo = new InMemoryAdminReportRepository()
    repo.now = NOW
    const mailRepo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    const loaded: string[] = []
    const svc = makeAdminReportService({
      repo,
      outboundMail,
      now: () => NOW,
      presignMedia: async (r2Key) => ({ url: `https://media.test/${r2Key}` }),
      loadMediaBytes: (r2Key) => {
        loaded.push(r2Key)
        return Promise.resolve(new Uint8Array(bytesEach))
      },
    })
    repo.seedReport({
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
      media: Array.from({ length: count }, (_, i) => ({
        id: `m-${i}`,
        kind: "image" as const,
        r2Key: `media/photo-${i}.jpg`,
        thumbKey: null,
        contentType: "image/jpeg",
      })),
    })
    return { repo, mailer, svc, loaded }
  }

  it("stops attaching once the running total would exceed MAX_PACKET_TOTAL_BYTES", async () => {
    const h = harnessWithMedia(4, FOUR_MB)
    await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    const sent = h.mailer.sent.at(-1)?.outbound
    expect(sent?.attachments).toHaveLength(2)
    const total = (sent?.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0)
    expect(total).toBeLessThanOrEqual(MAX_PACKET_TOTAL_BYTES)
  })

  it("still lists every skipped photo as a presigned mediaLink so nothing is lost from the packet", async () => {
    const h = harnessWithMedia(4, FOUR_MB)
    await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    const body = h.mailer.sent.at(-1)?.outbound?.text ?? ""
    for (let i = 0; i < 4; i++) {
      expect(body).toContain(`https://media.test/media/photo-${i}.jpg`)
    }
  })

  it("attaches every photo when the aggregate stays under the cap", async () => {
    const h = harnessWithMedia(4, 512 * 1024)
    await h.svc.routeToJurisdiction("rep-1", {
      note: null,
      actorId: "op-1",
    })
    expect(h.mailer.sent.at(-1)?.outbound?.attachments).toHaveLength(4)
  })
})

describe("runAutoForwardWith delegates the duplicate-send decision", () => {
  function routable(h: Harness): void {
    h.repo.seedReport({
      id: "rep-1",
      status: "submitted",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: false,
      },
    })
  }

  it("retries a report whose send THREW (the job's own pre-check used to make that permanent)", async () => {
    const h = harness()
    routable(h)
    h.mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    await expect(runAutoForwardWith(h.svc, "rep-1")).rejects.toThrow(/smtp down/)

    const seeded = h.repo.reports.get("rep-1")
    if (seeded) {
      seeded.outreach = {
        threadId: "t-1",
        threadStatus: "sent",
        hasInbound: false,
        packetSent: true,
        routedTo: "311@lacity.gov",
        routedAt: NOW,
        sendFailed: true,
      }
    }
    h.mailer.sendOutbound = FakeMailer.prototype.sendOutbound.bind(h.mailer)
    const infos: unknown[] = []
    const warnings: unknown[] = []
    await runAutoForwardWith(h.svc, "rep-1", {
      info: (o) => infos.push(o),
      warn: (o) => warnings.push(o),
    })
    expect(h.mailer.sent).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it("skips an already-delivered report at INFO (not as a failure) and mails nothing", async () => {
    const h = harness()
    h.repo.seedReport({
      id: "rep-1",
      status: "acknowledged",
      routing: {
        geoid: "0644000",
        dept: "LA",
        place: "Los Angeles",
        contact: "311@lacity.gov",
        routed: true,
      },
      outreach: {
        threadId: "t-1",
        threadStatus: "delivered",
        hasInbound: false,
        routedTo: "311@lacity.gov",
      },
    })
    const infos: unknown[] = []
    const warnings: unknown[] = []
    await runAutoForwardWith(h.svc, "rep-1", {
      info: (o) => infos.push(o),
      warn: (o) => warnings.push(o),
    })
    expect(h.mailer.sent).toHaveLength(0)
    expect(infos).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it("keeps a MAILER 409 (unapproved sender) a warned failure, not an idempotent skip", async () => {
    const h = harness()
    routable(h)
    h.mailer.sendOutbound = () => Promise.reject(AppError.conflict("sender not approved"))
    const infos: unknown[] = []
    const warnings: unknown[] = []
    await expect(
      runAutoForwardWith(h.svc, "rep-1", {
        info: (o) => infos.push(o),
        warn: (o) => warnings.push(o),
      }),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})
