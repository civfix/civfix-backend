import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/seams"
import { renderMessage } from "../../src/i18n/renderMessage.js"
import type { MessageKey } from "../../src/i18n/messages/en.js"
import { makeAdminReportService } from "../../src/services/admin/admin-report-service.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import type { FilingRecord } from "../../src/services/filings/filing-types.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { InMemoryAdminReportRepository } from "../helpers/admin/admin-report-repository.memory.js"
import {
  filingHarness,
  J_CONTACT,
  J_GEOID,
  PORTAL_HOST,
  PORTAL_URL,
  WEB_BASE,
  type FilingHarness,
} from "../helpers/filings/filing-harness.js"

const MINUTE_MS = 60_000

async function created(h: FilingHarness, reportId: string, note: string | null = null) {
  const out = await h.svc.create({ reportId, actorId: "op-1", note })
  expect(out.kind).toBe("created")
  if (out.kind !== "created") throw new Error("not created")
  return out.filing
}

function notificationText(n: { titleKey?: MessageKey; vars?: Record<string, unknown> }): string {
  if (n.titleKey === undefined) throw new Error("notification has no titleKey")
  return renderMessage("en", n.titleKey, n.vars as Record<string, string>)
}

async function portalRoute(
  h: FilingHarness,
  routes: { category: string | null; channel: "portal" | "email" | "manual"; enabled?: boolean }[],
) {
  await h.filings.replaceRoutes(
    J_GEOID,
    routes.map((r) => ({
      category: r.category,
      channel: r.channel,
      formUrl: r.channel === "portal" ? PORTAL_URL : null,
      enabled: r.enabled ?? true,
    })),
  )
}

describe("filingService.create", () => {
  it("C1: J has only an email contact: queued email filing, one filing.email job keyed by the filing", async () => {
    const h = filingHarness()
    const r = h.seed({ contact: J_CONTACT })
    const filing = await created(h, r.record.id)
    expect(filing).toMatchObject({ status: "queued", channel: "email", routeCategory: null })
    expect(h.jobs.enqueued.map((j) => ({ name: j.name, data: j.data, opts: j.opts }))).toEqual([
      { name: "filing.email", data: { filingId: filing.id }, opts: { singletonKey: filing.id } },
    ])
  })

  it("C2: an enabled (J, graffiti) portal route with automatic filing on: queued portal filing, one filing.run attempt 1", async () => {
    const h = filingHarness({ automatic: true })
    await portalRoute(h, [{ category: "graffiti", channel: "portal" }])
    const r = h.seed({ category: "graffiti" })
    const filing = await created(h, r.record.id)
    expect(filing).toMatchObject({
      status: "queued",
      channel: "portal",
      portalHost: PORTAL_HOST,
      formUrl: PORTAL_URL,
      routeCategory: "graffiti",
    })
    expect(h.jobs.enqueued.map((j) => ({ name: j.name, data: j.data, opts: j.opts }))).toEqual([
      {
        name: "filing.run",
        data: { filingId: filing.id, attempt: 1 },
        opts: { singletonKey: filing.id },
      },
    ])
  })

  it("C3: the same portal route with automatic filing off: needs_human / filing_off, no job", async () => {
    const h = filingHarness({ automatic: false })
    await portalRoute(h, [{ category: "graffiti", channel: "portal" }])
    const r = h.seed({ category: "graffiti" })
    const filing = await created(h, r.record.id)
    expect(filing).toMatchObject({ status: "needs_human", reason: "filing_off", channel: "portal" })
    expect(h.jobs.enqueued).toEqual([])
  })

  it("C4: a disabled (J, graffiti) route wins over an enabled (J, NULL) portal: needs_human / route_disabled", async () => {
    const h = filingHarness({ automatic: true })
    await portalRoute(h, [
      { category: "graffiti", channel: "portal", enabled: false },
      { category: null, channel: "portal" },
    ])
    const r = h.seed({ category: "graffiti" })
    const filing = await created(h, r.record.id)
    expect(filing).toMatchObject({
      status: "needs_human",
      reason: "route_disabled",
      routeCategory: "graffiti",
    })
    expect(h.jobs.enqueued).toEqual([])
  })

  it("C5: no (J, graffiti) and a manual (J, NULL): needs_human / manual_route on the default route", async () => {
    const h = filingHarness({ automatic: true })
    await portalRoute(h, [{ category: null, channel: "manual" }])
    const r = h.seed({ category: "graffiti", contact: J_CONTACT })
    const filing = await created(h, r.record.id)
    expect(filing).toMatchObject({
      status: "needs_human",
      reason: "manual_route",
      channel: "manual",
      routeCategory: null,
    })
    expect(h.jobs.enqueued).toEqual([])
  })

  it("C6: no route and no contact gives needs_human / no_route; so does a report with no jurisdiction", async () => {
    const h = filingHarness({ automatic: true })
    const inJ = h.seed()
    expect(await created(h, inJ.record.id)).toMatchObject({
      status: "needs_human",
      reason: "no_route",
      channel: null,
      geoid: J_GEOID,
    })
    const nowhere = h.seed({ geoid: null, contact: J_CONTACT })
    expect(await created(h, nowhere.record.id)).toMatchObject({
      status: "needs_human",
      reason: "no_route",
      channel: null,
      geoid: null,
    })
    expect(h.jobs.enqueued).toEqual([])
  })

  it("C7: an active filing and an open submitted one are already filed; a city-closed one is not", async () => {
    const h = filingHarness()
    const active = h.seed({ contact: J_CONTACT })
    await h.addFiling(active.record.id, {}, { status: "needs_human", reason: "no_route" })
    expect(await h.svc.create({ reportId: active.record.id, actorId: "op-1" })).toEqual({
      kind: "already_filed",
    })

    const open = h.seed({ contact: J_CONTACT })
    await h.addFiling(open.record.id, {}, { status: "submitted", submittedAt: new Date() })
    expect(await h.svc.create({ reportId: open.record.id, actorId: "op-1" })).toEqual({
      kind: "already_filed",
    })

    const closed = h.seed({ contact: J_CONTACT })
    await h.addFiling(
      closed.record.id,
      {},
      { status: "submitted", submittedAt: new Date(), cityClosedAt: new Date() },
    )
    const again = await h.svc.create({ reportId: closed.record.id, actorId: "op-1" })
    expect(again.kind).toBe("created")
  })

  it("T3: a blank note is stored as no note; a padded one is stored trimmed", async () => {
    const h = filingHarness()
    const blank = h.seed({ contact: J_CONTACT })
    expect((await created(h, blank.record.id, "  ")).note).toBeNull()
    const padded = h.seed({ contact: J_CONTACT })
    expect((await created(h, padded.record.id, " call back ")).note).toBe("call back")
  })

  it("C8: a report whose verdict is rejected is not fileable and gets no filing", async () => {
    const h = filingHarness()
    const r = h.seed({ contact: J_CONTACT, verificationVerdict: "rejected" })
    expect(await h.svc.create({ reportId: r.record.id, actorId: "op-1" })).toEqual({
      kind: "not_fileable",
    })
    expect(h.filings.filings.size).toBe(0)
    expect(h.jobs.enqueued).toEqual([])
  })

  it("C46: an open submitted filing whose mail thread bounced does not block filing again; a delivered or a linked one does", async () => {
    const h = filingHarness()
    async function filedBefore(patch: Partial<FilingRecord>, threadStatus: string | null) {
      const r = h.seed({ contact: J_CONTACT })
      let mailThreadId: string | null = null
      if (threadStatus !== null) {
        mailThreadId = randomUUID()
        h.filings.mailThreads.set(mailThreadId, threadStatus)
      }
      await h.addFiling(
        r.record.id,
        { channel: "email" },
        { submittedAt: new Date(), cityClosedAt: null, mailThreadId, ...patch },
      )
      return r.record.id
    }

    const bounced = await filedBefore({ status: "submitted", method: "email" }, "bounced")
    const again = await h.svc.create({ reportId: bounced, actorId: "op-1" })
    expect(again).toMatchObject({ kind: "created", filing: { status: "queued", channel: "email" } })

    const delivered = await filedBefore({ status: "submitted", method: "email" }, "delivered")
    expect(await h.svc.create({ reportId: delivered, actorId: "op-1" })).toEqual({
      kind: "already_filed",
    })

    const linked = await filedBefore({ status: "linked_existing", method: "operator" }, null)
    expect(await h.svc.create({ reportId: linked, actorId: "op-1" })).toEqual({
      kind: "already_filed",
    })
  })
})

describe("ticket text", () => {
  it("C9: title, description, framing line with ref, and the public link", async () => {
    const h = filingHarness()
    const r = h.seed({
      contact: J_CONTACT,
      title: "Pothole",
      desc: "Deep",
      referenceCode: "LA-7",
      status: "published",
      visibility: "public",
    })
    const filing = await created(h, r.record.id)
    expect(filing.ticketText).toBe(
      `Pothole\nDeep\n\nReported by a resident via CivFix · ref LA-7\n${WEB_BASE}/pin/${r.record.id}`,
    )
  })

  it("C10: no URL line with includeLink off or a non-public report; no ref part without a code; the note last", async () => {
    const off = filingHarness()
    await off.filings.replaceRoutes(J_GEOID, [
      { category: null, channel: "email", includeLink: false },
    ])
    const r1 = off.seed({ contact: J_CONTACT, referenceCode: "LA-7" })
    expect((await created(off, r1.record.id)).ticketText).not.toContain("/pin/")

    const hidden = filingHarness()
    const r2 = hidden.seed({ contact: J_CONTACT, referenceCode: "LA-7", visibility: "hidden" })
    expect((await created(hidden, r2.record.id)).ticketText).not.toContain("/pin/")

    const noRef = filingHarness()
    const r3 = noRef.seed({ contact: J_CONTACT, referenceCode: null })
    const lines = (await created(noRef, r3.record.id)).ticketText.split("\n")
    expect(lines).toContain("Reported by a resident via CivFix")
    expect(lines.some((l) => l.includes("· ref"))).toBe(false)

    const noted = filingHarness()
    const r4 = noted.seed({ contact: J_CONTACT, referenceCode: "LA-7" })
    const text = (await created(noted, r4.record.id, "Corner of 5th")).ticketText
    expect(text.split("\n").at(-1)).toBe("Note from CivFix: Corner of 5th")
  })

  it("C43: a blank description is omitted", async () => {
    const h = filingHarness()
    await h.filings.replaceRoutes(J_GEOID, [
      { category: null, channel: "email", includeLink: false },
    ])
    const r = h.seed({ contact: J_CONTACT, title: "Pothole", desc: "   ", referenceCode: "LA-7" })
    expect((await created(h, r.record.id)).ticketText).toBe(
      "Pothole\n\nReported by a resident via CivFix · ref LA-7",
    )
  })
})

describe("enqueueFiling and runSweepPass", () => {
  function queued(
    h: FilingHarness,
    reportId: string,
    channel: "email" | "portal",
    patch: Partial<FilingRecord> = {},
  ): Promise<FilingRecord> {
    return h.addFiling(
      reportId,
      {
        channel,
        portalHost: channel === "portal" ? PORTAL_HOST : null,
        formUrl: channel === "portal" ? PORTAL_URL : null,
      },
      { status: "queued", ...patch },
    )
  }

  it("C24: an email filing sends filing.email; a portal filing with automatic off sends nothing; a delayed portal filing starts after its delay", async () => {
    const off = filingHarness({ automatic: false })
    const email = await queued(off, off.seed().record.id, "email")
    expect(await off.svc.enqueueFiling(email)).toBe(true)
    expect(off.jobs.enqueued.map((j) => ({ name: j.name, data: j.data, opts: j.opts }))).toEqual([
      { name: "filing.email", data: { filingId: email.id }, opts: { singletonKey: email.id } },
    ])

    const portalOff = await queued(off, off.seed().record.id, "portal")
    off.jobs.reset()
    expect(await off.svc.enqueueFiling(portalOff)).toBe(false)
    expect(off.jobs.enqueued).toEqual([])

    const on = filingHarness({ automatic: true })
    const later = await queued(on, on.seed().record.id, "portal", {
      nextAttemptAt: new Date(on.clock.now.getTime() + 5 * MINUTE_MS),
    })
    expect(await on.svc.enqueueFiling(later)).toBe(true)
    expect(on.jobs.enqueued.map((j) => ({ name: j.name, data: j.data, opts: j.opts }))).toEqual([
      {
        name: "filing.run",
        data: { filingId: later.id, attempt: 1 },
        opts: { singletonKey: later.id, startAfter: 300 },
      },
    ])
  })

  it("C25: the sweep re-enqueues an old enough due filing, nothing while paused or for a fresh one, and email with automatic off", async () => {
    const on = filingHarness({ automatic: true })
    const old = await queued(on, on.seed().record.id, "portal", {
      updatedAt: new Date(on.clock.now.getTime() - 11 * MINUTE_MS),
    })
    await on.svc.runSweepPass()
    expect(on.jobs.enqueued.map((j) => ({ name: j.name, opts: j.opts }))).toEqual([
      { name: "filing.run", opts: { singletonKey: old.id } },
    ])

    on.jobs.reset()
    await on.filings.setPaused(true)
    await on.svc.runSweepPass()
    expect(on.jobs.enqueued).toEqual([])

    const fresh = filingHarness({ automatic: true })
    await queued(fresh, fresh.seed().record.id, "portal", {
      updatedAt: new Date(fresh.clock.now.getTime() - 9 * MINUTE_MS),
    })
    await fresh.svc.runSweepPass()
    expect(fresh.jobs.enqueued).toEqual([])

    const off = filingHarness({ automatic: false })
    const email = await queued(off, off.seed().record.id, "email", {
      updatedAt: new Date(off.clock.now.getTime() - 11 * MINUTE_MS),
    })
    await queued(off, off.seed().record.id, "portal", {
      updatedAt: new Date(off.clock.now.getTime() - 11 * MINUTE_MS),
    })
    await off.svc.runSweepPass()
    expect(off.jobs.enqueued.map((j) => ({ name: j.name, data: j.data }))).toEqual([
      { name: "filing.email", data: { filingId: email.id } },
    ])
  })

  it("C26: a pass takes at most 100, oldest created first; ignoreAge takes a filing updated a minute ago", async () => {
    const h = filingHarness({ automatic: true })
    const hourAgo = new Date(h.clock.now.getTime() - 60 * MINUTE_MS)
    const all: FilingRecord[] = []
    for (let i = 0; i < 150; i += 1) {
      all.push(await queued(h, h.seed().record.id, "portal", { updatedAt: hourAgo }))
    }
    await h.svc.runSweepPass()
    const sent = h.jobs.enqueued.map((j) => (j.data as { filingId: string }).filingId)
    expect(sent).toEqual(
      [...all]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, 100)
        .map((f) => f.id),
    )

    const recent = filingHarness({ automatic: true })
    const minuteAgo = await queued(recent, recent.seed().record.id, "portal", {
      updatedAt: new Date(recent.clock.now.getTime() - MINUTE_MS),
    })
    await recent.svc.runSweepPass({ ignoreAge: true })
    expect(recent.jobs.enqueued.map((j) => j.data)).toEqual([
      { filingId: minuteAgo.id, attempt: 1 },
    ])
  })
})

describe("applyFilingSuccess", () => {
  it("C39: an operator success on a jurisdiction-less filing reads 'the city', once", async () => {
    const h = filingHarness()
    const r = h.seed({ geoid: null, status: "published" })
    const filing = await h.addFiling(
      r.record.id,
      { geoid: null },
      { status: "needs_human", reason: "no_route" },
    )
    const call = {
      filingId: filing.id,
      from: { status: ["needs_human" as const] },
      outcome: "submitted" as const,
      method: "operator" as const,
    }
    expect(await h.svc.applyFilingSuccess(call)).toEqual({ applied: true })
    expect(h.filings.timeline.map((t) => t.note)).toEqual(["Filed with the city"])
    expect(h.notifier.sent.map(notificationText)).toEqual(["Your report was sent to the city"])
    expect(h.emitter.events).toHaveLength(1)

    expect(await h.svc.applyFilingSuccess(call)).toEqual({ applied: false })
    expect(h.filings.timeline).toHaveLength(1)
    expect(h.notifier.sent).toHaveLength(1)
    expect(h.emitter.events).toHaveLength(1)
  })
})

describe("admin report detail and list", () => {
  function adminService(h: FilingHarness) {
    const outboundMail = makeOutboundMailService({
      repo: new InMemoryMailRepository(),
      mailer: new FakeMailer(),
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    return makeAdminReportService({ repo: h.reports, outboundMail, filings: h.svc })
  }

  it("C29: filingRoute names the email address or portal host (even disabled), filing is the latest in any status, and null without a route", async () => {
    const email = filingHarness()
    const r1 = email.seed({ contact: J_CONTACT })
    expect((await adminService(email).get(r1.record.id)).filingRoute).toEqual({
      channel: "email",
      target: J_CONTACT,
    })

    const portal = filingHarness({ automatic: true })
    await portalRoute(portal, [{ category: null, channel: "portal" }])
    const r2 = portal.seed()
    expect((await adminService(portal).get(r2.record.id)).filingRoute).toEqual({
      channel: "portal",
      target: PORTAL_HOST,
    })

    const disabled = filingHarness({ automatic: true })
    await portalRoute(disabled, [{ category: "graffiti", channel: "portal", enabled: false }])
    const r3 = disabled.seed({ category: "graffiti" })
    expect((await adminService(disabled).get(r3.record.id)).filingRoute).toEqual({
      channel: "portal",
      target: PORTAL_HOST,
    })

    const cancelled = filingHarness()
    const r4 = cancelled.seed({ contact: J_CONTACT, title: "Broken light" })
    await cancelled.addFiling(
      r4.record.id,
      {},
      { status: "submitted", submittedAt: new Date(Date.now() - 60 * MINUTE_MS) },
    )
    await cancelled.addFiling(r4.record.id, {}, { status: "cancelled" })
    const detail = await adminService(cancelled).get(r4.record.id)
    expect(detail.filing).toMatchObject({
      status: "cancelled",
      reportId: r4.record.id,
      reportTitle: "Broken light",
    })
    expect(detail.filing).not.toHaveProperty("evidence")

    const none = filingHarness()
    const r5 = none.seed()
    const bare = await adminService(none).get(r5.record.id)
    expect(bare.filingRoute).toBeNull()
    expect(bare.filing).toBeNull()
  })

  it("C42: the admin list carries no filing and no filingRoute", async () => {
    const h = filingHarness()
    const r = h.seed({ contact: J_CONTACT })
    await h.addFiling(r.record.id, {}, { status: "submitted", submittedAt: new Date() })
    const page = await adminService(h).list({ filter: "all" })
    const item = page.items.find((i) => i.id === r.record.id)
    expect(item).toBeDefined()
    expect(item).not.toHaveProperty("filing")
    expect(item).not.toHaveProperty("filingRoute")
  })
})

describe("getOutreach packetsSince (memory twin)", () => {
  it("C32: a packet sent before packetsSince is not counted; at or without it, it is", async () => {
    const repo = new InMemoryAdminReportRepository()
    const t = new Date("2026-06-06T12:00:00.000Z")
    repo.seedReport({
      id: "rep-1",
      outreach: {
        threadId: "t-1",
        threadStatus: "sent",
        routedTo: J_CONTACT,
        routedAt: t,
        packetSent: true,
        sendFailed: false,
      },
    })
    const after = await repo.getOutreach("rep-1", { packetsSince: new Date(t.getTime() + 1000) })
    expect(after.packetSent).toBe(false)
    expect(after.sendFailed).not.toBe(true)
    expect(after.sendInFlight).toBe(false)
    expect((await repo.getOutreach("rep-1", { packetsSince: t })).packetSent).toBe(true)
    expect((await repo.getOutreach("rep-1")).packetSent).toBe(true)
  })
})
