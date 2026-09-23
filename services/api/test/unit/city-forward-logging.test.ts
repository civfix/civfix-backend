import { describe, it, expect } from "vitest"
import {
  forwardReportCityMention,
  makeCityForwardThrottle,
} from "../../src/services/report-city-forward.js"
import type { CounterStore } from "../../src/abuse/counter-store.js"
import type { ReportForwardAuditRepository } from "../../src/services/report-forward-audit-repository.js"
import type { OutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import type { MailThreadRecord } from "../../src/services/admin/mail-repository.drizzle.js"

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const CREATED = new Date("2026-07-09T12:00:00.000Z")
const SF = {
  geoid: "0600001",
  name: "City of San Francisco",
  handle: "sf",
  contactEmail: "fix@sf.gov",
}
const ctx = {
  reportId: REPORT,
  category: "graffiti",
  place: "SF",
  jurisdiction: SF,
  actorUserId: "actor-1",
}

const THREAD = { id: "thread-1", subject: "[civfix] Tag - SF - ABC123" } as MailThreadRecord

function mail(over: Partial<OutboundMailService>): OutboundMailService {
  return {
    findReportThread: () => Promise.resolve(THREAD),
    appendOutbound: () => Promise.resolve(THREAD),
    ...over,
  } as OutboundMailService
}

function capture() {
  const lines: { obj: unknown; msg?: string }[] = []
  return { lines, logger: { warn: (obj: unknown, msg?: string) => lines.push({ obj, msg }) } }
}

describe("city forward failures are logged, not swallowed", () => {
  it("logs a failed forward send and reports it as not forwarded", async () => {
    const { lines, logger } = capture()
    const res = await forwardReportCityMention(
      mail({ appendOutbound: () => Promise.reject(new Error("smtp down")) }),
      ctx,
      "@sf please fix",
      CREATED,
      { logger },
    )

    expect(res).toMatchObject({ mentioned: true, forwarded: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.obj).toMatchObject({ reportId: REPORT, geoid: SF.geoid })
    expect(String((lines[0]!.obj as { err: unknown }).err)).toMatch(/smtp down/)
  })

  it("logs a failed report-thread lookup", async () => {
    const { lines, logger } = capture()
    const res = await forwardReportCityMention(
      mail({ findReportThread: () => Promise.reject(new Error("db down")) }),
      ctx,
      "@sf please fix",
      CREATED,
      { logger },
    )

    expect(res).toMatchObject({ mentioned: true, forwarded: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.obj).toMatchObject({ reportId: REPORT })
  })

  it("logs a failed audit write without failing the forward", async () => {
    const { lines, logger } = capture()
    const audit: ReportForwardAuditRepository = {
      recordMention: () => Promise.reject(new Error("audit down")),
      markForwarded: () => Promise.resolve(),
    } as unknown as ReportForwardAuditRepository
    const res = await forwardReportCityMention(mail({}), ctx, "@sf please fix", CREATED, {
      logger,
      audit,
      messageId: "msg-1",
    })

    expect(res.forwarded).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.obj).toMatchObject({ messageId: "msg-1", geoid: SF.geoid })
  })

  it("the throttle still fails closed on a counter outage, and says so", async () => {
    const { lines, logger } = capture()
    const broken = {
      incr: () => Promise.reject(new Error("redis down")),
    } as unknown as CounterStore

    const allowed = await makeCityForwardThrottle(broken, logger)(REPORT, SF.geoid, "actor-1")

    expect(allowed).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.obj).toMatchObject({ reportId: REPORT, geoid: SF.geoid })
  })
})
