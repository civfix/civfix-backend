
import { describe, it, expect, vi } from "vitest"
import {
  forwardReportCityMention,
  makeCityForwardThrottle,
  CITY_FORWARD_PER_SENDER_PER_HOUR,
  CITY_FORWARD_PER_GEOID_PER_HOUR,
} from "../../src/services/report-city-forward.js"
import { InMemoryCounterStore, type CounterStore } from "../../src/abuse/counter-store.js"
import type { ReportForwardAudit } from "../../src/services/report-forward-audit.drizzle.js"
import type {
  AppendOutboundInput,
  OutboundMailService,
  SendReportInput,
} from "../../src/services/admin/outbound-mail-service.js"
import type { MailThreadRecord } from "../../src/services/admin/mail-repository.drizzle.js"
import type { ReportJurisdictionView } from "../../src/services/discussion-types.js"

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const MSG = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const CREATED = new Date("2026-07-09T12:00:00.000Z")

const SF: ReportJurisdictionView = {
  geoid: "0600001",
  name: "City of San Francisco",
  handle: "sf",
  contactEmail: "fix@sf.gov",
}
const SF_NO_CONTACT: ReportJurisdictionView = { ...SF, contactEmail: null }

function stubThread(overrides: Partial<MailThreadRecord> = {}): MailThreadRecord {
  return {
    id: "thread-1",
    threadToken: "geo-1",
    reportId: null,
    cleanupId: null,
    jurisdictionGeoid: null,
    org: null,
    subject: "[civfix] Tag on the underpass - SF - ABC123",
    status: "sent",
    unread: false,
    lastMessageAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

type SpyMailer = OutboundMailService & {
  calls: AppendOutboundInput[]
  threadIds: string[]
}

function mailer(opts: { fail?: boolean; thread?: MailThreadRecord | null } = {}): SpyMailer {
  const calls: AppendOutboundInput[] = []
  const threadIds: string[] = []
  const thread = opts.thread === undefined ? stubThread() : opts.thread
  return {
    calls,
    threadIds,
    findReportThread: () => Promise.resolve(thread),
    prepareReportToJurisdiction(_input: SendReportInput) {
      return Promise.resolve({
        thread: stubThread(),
        deliver: () => Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" }),
      })
    },
    sendReportToJurisdiction(_input: SendReportInput) {
      return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
    },
    sendEventToJurisdiction: () =>
      Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" }),
    sendToCity: () => Promise.resolve(stubThread()),
    compose: () => Promise.resolve(stubThread()),
    appendOutbound: (threadId: string, input: AppendOutboundInput) => {
      threadIds.push(threadId)
      calls.push(input)
      if (opts.fail) return Promise.reject(new Error("smtp down"))
      return Promise.resolve(stubThread())
    },
  }
}

function spyAudit(overrides: Partial<ReportForwardAudit> = {}): ReportForwardAudit & {
  recordMention: ReturnType<typeof vi.fn>
  markForwarded: ReturnType<typeof vi.fn>
} {
  return {
    recordMention: vi.fn(() => Promise.resolve()),
    markForwarded: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as ReportForwardAudit & {
    recordMention: ReturnType<typeof vi.fn>
    markForwarded: ReturnType<typeof vi.fn>
  }
}

const ctx = (jurisdiction: ReportJurisdictionView | null) => ({
  reportId: REPORT,
  category: "graffiti",
  place: "SF",
  jurisdiction,
  actorUserId: "actor-1",
})

describe("forwardReportCityMention audit writes (report_message_forwards)", () => {
  it("records the mention row THEN stamps forwarded on a successful @city forward", async () => {
    const mail = mailer()
    const audit = spyAudit()
    const res = await forwardReportCityMention(mail, ctx(SF), "pls fix @sf", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res).toMatchObject({ mentioned: true, geoid: "0600001", forwarded: true })
    expect(audit.recordMention).toHaveBeenCalledOnce()
    expect(audit.recordMention).toHaveBeenCalledWith(MSG, "0600001")
    expect(audit.markForwarded).toHaveBeenCalledOnce()
    expect(audit.markForwarded).toHaveBeenCalledWith(MSG, "0600001")
    expect(audit.recordMention.mock.invocationCallOrder[0]!).toBeLessThan(
      audit.markForwarded.mock.invocationCallOrder[0]!,
    )
    expect(mail.calls).toHaveLength(1)
  })

  it("records the mention but does NOT stamp forwarded when there is no city contact (and never throws)", async () => {
    const mail = mailer()
    const audit = spyAudit()
    const res = await forwardReportCityMention(mail, ctx(SF_NO_CONTACT), "@sf help", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res).toMatchObject({ mentioned: true, geoid: "0600001", forwarded: false })
    expect(audit.recordMention).toHaveBeenCalledOnce()
    expect(audit.recordMention).toHaveBeenCalledWith(MSG, "0600001")
    expect(audit.markForwarded).not.toHaveBeenCalled()
    expect(mail.calls).toHaveLength(0)
  })

  it("records the mention but does NOT stamp forwarded when the forward send FAILS (best-effort, no throw)", async () => {
    const mail = mailer({ fail: true })
    const audit = spyAudit()
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf urgent", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res).toMatchObject({ mentioned: true, forwarded: false })
    expect(audit.recordMention).toHaveBeenCalledOnce()
    expect(audit.recordMention).toHaveBeenCalledWith(MSG, "0600001")
    expect(audit.markForwarded).not.toHaveBeenCalled()
    expect(mail.calls).toHaveLength(1)
  })

  it("records the mention but does NOT stamp forwarded when a dedup guard blocks the send", async () => {
    const mail = mailer()
    const audit = spyAudit()
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf again", CREATED, {
      audit,
      messageId: MSG,
      canForward: () => Promise.resolve(false),
    })

    expect(res).toMatchObject({ mentioned: true, forwarded: false })
    expect(audit.recordMention).toHaveBeenCalledOnce()
    expect(audit.recordMention).toHaveBeenCalledWith(MSG, "0600001")
    expect(audit.markForwarded).not.toHaveBeenCalled()
    expect(mail.calls).toHaveLength(0)
  })

  it("records the mention but forwards NOTHING when the report was never sent to the city", async () => {
    const mail = mailer({ thread: null })
    const audit = spyAudit()
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf please fix", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res).toMatchObject({ mentioned: true, geoid: "0600001", forwarded: false })
    expect(audit.recordMention).toHaveBeenCalledOnce()
    expect(audit.markForwarded).not.toHaveBeenCalled()
    expect(mail.calls).toHaveLength(0)
  })

  it("rides the report's existing mail thread with a Re: subject and the report/geoid event meta", async () => {
    const mail = mailer()
    await forwardReportCityMention(mail, ctx(SF), "pls fix @sf", CREATED, {})

    expect(mail.threadIds).toEqual(["thread-1"])
    const sent = mail.calls[0]!
    expect(sent.subject).toBe("Re: [civfix] Tag on the underpass - SF - ABC123")
    expect(sent.kind).toBe("discussion")
    expect(sent.toAddr).toBe("fix@sf.gov")
    expect(sent.eventMeta).toEqual({ reportId: REPORT, geoid: "0600001" })
  })

  it("does not double-prefix a thread subject that is already a reply, and falls back when it has none", async () => {
    const already = mailer({ thread: stubThread({ subject: "Re: [civfix] Tag" }) })
    await forwardReportCityMention(already, ctx(SF), "@sf hi", CREATED, {})
    expect(already.calls[0]!.subject).toBe("Re: [civfix] Tag")

    const untitled = mailer({ thread: stubThread({ subject: null }) })
    await forwardReportCityMention(untitled, ctx(SF), "@sf hi", CREATED, {})
    expect(untitled.calls[0]!.subject).toContain("civfix report: graffiti in SF")
  })

  it("attributes the commenter by public display name, and stays anonymous without one", async () => {
    const named = mailer()
    await forwardReportCityMention(
      named,
      { ...ctx(SF), actorDisplayName: "Dana Neighbor" },
      "@sf there is a tag here",
      CREATED,
      {},
    )
    expect(named.calls[0]!.body).toContain("Dana Neighbor commented on a graffiti report in SF")
    expect(named.calls[0]!.body).toContain("there is a tag here")

    const anon = mailer()
    await forwardReportCityMention(anon, { ...ctx(SF), actorDisplayName: null }, "@sf hi", CREATED, {})
    expect(anon.calls[0]!.body).toContain("A neighbor commented on a graffiti report in SF")
  })

  it("writes NO audit row when the body @mentions no city handle", async () => {
    const mail = mailer()
    const audit = spyAudit()
    const res = await forwardReportCityMention(mail, ctx(SF), "just chatting", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res.mentioned).toBe(false)
    expect(audit.recordMention).not.toHaveBeenCalled()
    expect(audit.markForwarded).not.toHaveBeenCalled()
  })

  it("does NOT throw the chat message when the audit INSERT itself fails (message already persisted)", async () => {
    const mail = mailer()
    const audit = spyAudit({
      recordMention: vi.fn(() => Promise.reject(new Error("db down"))),
    })
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf now", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res).toMatchObject({ mentioned: true, forwarded: true })
    expect(mail.calls).toHaveLength(1)
  })

  it("skips auditing entirely when audit/messageId are omitted (opt-in seam)", async () => {
    const mail = mailer()
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf please", CREATED, {})
    expect(res).toMatchObject({ mentioned: true, forwarded: true })
    expect(mail.calls).toHaveLength(1)
  })
})

describe("makeCityForwardThrottle (F023: durable per-actor / per-geoid city-forward budget)", () => {
  const R1 = "11111111-1111-1111-1111-111111111111"
  const R2 = "22222222-2222-2222-2222-222222222222"
  const GEO = "0600001"
  const ACTOR = "actor-1"

  it("dedups a repeat (actor, report, geoid) forward within the window", async () => {
    const gate = makeCityForwardThrottle(new InMemoryCounterStore())
    await expect(gate(R1, GEO, ACTOR)).resolves.toBe(true)
    await expect(gate(R1, GEO, ACTOR)).resolves.toBe(false)
  })

  it("caps a single sender across DISTINCT reports (rotating report ids does not evade)", async () => {
    const gate = makeCityForwardThrottle(new InMemoryCounterStore())
    let allowed = 0
    for (let i = 0; i < CITY_FORWARD_PER_SENDER_PER_HOUR + 3; i++) {
      const reportId = `0000000${i}-0000-0000-0000-000000000000`
      if (await gate(reportId, GEO, ACTOR)) allowed++
    }
    expect(allowed).toBe(CITY_FORWARD_PER_SENDER_PER_HOUR)
  })

  it("caps aggregate forwards into ONE jurisdiction across DISTINCT senders", async () => {
    const gate = makeCityForwardThrottle(new InMemoryCounterStore())
    let allowed = 0
    for (let i = 0; i < CITY_FORWARD_PER_GEOID_PER_HOUR + 5; i++) {
      const actor = `actor-${i}`
      if (await gate(R1 + i, GEO, actor)) allowed++
    }
    expect(allowed).toBe(CITY_FORWARD_PER_GEOID_PER_HOUR)
  })

  it("FAILS CLOSED when the counter store throws", async () => {
    const broken: CounterStore = {
      incr: () => Promise.reject(new Error("redis down")),
      incrBy: () => Promise.reject(new Error("redis down")),
    }
    const gate = makeCityForwardThrottle(broken)
    await expect(gate(R2, GEO, ACTOR)).resolves.toBe(false)
  })
})
