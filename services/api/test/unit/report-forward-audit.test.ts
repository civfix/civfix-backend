/**
 * Task D-C4: @city forward AUDIT orchestration (report_message_forwards).
 *
 * forwardReportCityMention is the choke point for a report-chat @city mention. This suite pins the pure
 * ordering it must follow against a spy audit + spy mailer (no DB): a mention records an audit row BEFORE
 * the send is attempted, a successful forward stamps it, a no-contact / deduped / failed forward leaves the
 * row unstamped, a non-mention writes nothing, and an audit-write failure never propagates (the chat message
 * already persisted). The DB-backed INSERT/UPDATE SQL is exercised by the Docker-gated pg suite.
 */

import { describe, it, expect, vi } from "vitest"
import { forwardReportCityMention } from "../../src/services/report-city-forward.js"
import type { ReportForwardAudit } from "../../src/services/report-forward-audit.drizzle.js"
import type {
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

function stubThread(): MailThreadRecord {
  return {
    id: "thread-1",
    threadToken: "geo-1",
    reportId: null,
    cleanupId: null,
    jurisdictionGeoid: null,
    org: null,
    subject: null,
    status: "sent",
    unread: false,
    lastMessageAt: null,
    createdAt: new Date(),
  }
}

function mailer(opts: { fail?: boolean } = {}): OutboundMailService & { calls: SendReportInput[] } {
  const calls: SendReportInput[] = []
  return {
    calls,
    sendReportToJurisdiction(input: SendReportInput) {
      calls.push(input)
      if (opts.fail) return Promise.reject(new Error("smtp down"))
      return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
    },
    sendEventToJurisdiction: () =>
      Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" }),
    sendToCity: () => Promise.resolve(stubThread()),
    compose: () => Promise.resolve(stubThread()),
    appendOutbound: () => Promise.resolve(stubThread()),
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
    // Order: the mentioned-but-not-forwarded row is written before the forward is stamped.
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
    // No contact => no send attempted.
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
      canForward: () => false,
    })

    expect(res).toMatchObject({ mentioned: true, forwarded: false })
    expect(audit.recordMention).toHaveBeenCalledOnce()
    expect(audit.recordMention).toHaveBeenCalledWith(MSG, "0600001")
    expect(audit.markForwarded).not.toHaveBeenCalled()
    expect(mail.calls).toHaveLength(0)
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
    // The forward still proceeds and succeeds; only the audit write was lost.
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf now", CREATED, {
      audit,
      messageId: MSG,
    })

    expect(res).toMatchObject({ mentioned: true, forwarded: true })
    expect(mail.calls).toHaveLength(1)
  })

  it("skips auditing entirely when audit/messageId are omitted (opt-in seam)", async () => {
    const mail = mailer()
    // No audit + no messageId: behaves exactly like the pre-D-C4 forward, no audit side effects.
    const res = await forwardReportCityMention(mail, ctx(SF), "@sf please", CREATED, {})
    expect(res).toMatchObject({ mentioned: true, forwarded: true })
    expect(mail.calls).toHaveLength(1)
  })
})
