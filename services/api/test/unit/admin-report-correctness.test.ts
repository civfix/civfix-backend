import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import { makeAdminReportService } from "../../src/services/admin/admin-report-service.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"

const NOW = new Date("2026-06-06T00:00:00.000Z")
const REPORT_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e11"

const AUDIT_ROW = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }

const REPORTER = {
  id: "u-7",
  name: "Sam",
  handle: "sam",
  emailVerified: true,
  hasOauth: false,
  joinedAt: null,
}

interface Warned {
  obj: unknown
  msg: string | undefined
}

function harness(opts: { emitterThrows?: boolean } = {}) {
  const repo = new InMemoryAdminReportRepository()
  repo.now = NOW
  const notifier = new RecordingNotifier()
  const warned: Warned[] = []
  const svc = makeAdminReportService({
    repo,
    outboundMail: makeOutboundMailService({
      repo: new InMemoryMailRepository(),
      mailer: new FakeMailer(),
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    }),
    now: () => NOW,
    notifications: notifier,
    logger: { warn: (obj: unknown, msg?: string) => warned.push({ obj, msg }) },
    reportChatEmitter: {
      emit: () =>
        opts.emitterThrows === true ? Promise.reject(new Error("emit boom")) : Promise.resolve(),
    },
  })
  return { repo, notifier, warned, svc }
}

describe("admin report flag: a failed chat mirror is logged, not swallowed", () => {
  it("keeps the committed toggle and warns through the injected logger", async () => {
    const { repo, warned, svc } = harness({ emitterThrows: true })
    repo.seedReport({ id: REPORT_ID, flagged: false })
    await expect(svc.flag(REPORT_ID, { reason: null, actorId: "op-1" })).resolves.toBe(true)
    expect(repo.reports.get(REPORT_ID)?.record.flagged).toBe(true)
    expect(warned).toHaveLength(1)
    expect(warned[0]?.obj).toMatchObject({ reportId: REPORT_ID })
  })
})

describe("admin report verdict: the timeline row is the operator's", () => {
  it("attributes the verdict timeline row to the operator, not to system", async () => {
    const { repo, svc } = harness()
    repo.seedReport({ id: REPORT_ID })
    await svc.setVerdict({ id: REPORT_ID, verdict: "approved", actorId: "op-1" })
    const rows = repo.timeline.get(REPORT_ID) ?? []
    expect(rows.at(-1)).toMatchObject({ note: "Approved by an operator", who: "operator" })
    expect(rows.filter((r) => r.note === "Approved by an operator")).toHaveLength(1)
  })

  it("writes the timeline row inside the verdict transaction with the operator as actor", async () => {
    const ctl = makeFakeSql([
      { match: /UPDATE reports\s+SET verification_verdict/, rows: [{ reporter_user_id: null }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminReportRepository(ctl.sql as unknown as Sql)
    await repo.setReportVerdict(REPORT_ID, {
      verdict: "rejected",
      actorId: "op-1",
      note: "Rejected by an operator",
    })
    const timeline = ctl.statements.find((s) => /INSERT INTO report_timeline/.test(s.sql))
    expect(timeline?.values).toContain("op-1")
    expect(timeline?.values).toContain("Rejected by an operator")
  })
})

describe("admin report follow-up to the reporter", () => {
  it("never messages the citizen when the follow-up could not be recorded", async () => {
    const { repo, notifier, svc } = harness()
    repo.seedReport({ id: REPORT_ID, reporter: REPORTER })
    repo.appendFollowup = () => Promise.reject(new Error("audit write failed"))
    await expect(
      svc.sendFollowup(REPORT_ID, { to: "reporter", body: "hello", actorId: "op-1" }),
    ).rejects.toThrow("audit write failed")
    expect(notifier.sent).toHaveLength(0)
  })

  it("records the follow-up and then notifies the reporter", async () => {
    const { repo, notifier, svc } = harness()
    repo.seedReport({ id: REPORT_ID, reporter: REPORTER })
    await svc.sendFollowup(REPORT_ID, { to: "reporter", body: "hello", actorId: "op-1" })
    expect(notifier.sent).toHaveLength(1)
    expect(repo.audits.at(-1)).toMatchObject({ action: "report.followup_sent" })
  })
})

describe("admin report flag toggle serializes on the report row", () => {
  it("locks the report row before reading the open flag", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT status FROM reports/, rows: [{ status: "submitted" }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminReportRepository(ctl.sql as unknown as Sql)
    await repo.toggleFlag(REPORT_ID, { reason: null, actorId: "op-1" })
    const lock = ctl.statements.find((s) => /SELECT status FROM reports/.test(s.sql))
    expect(lock?.sql).toMatch(/FOR UPDATE/)
  })
})

describe("admin report route lock", () => {
  it("logs a failed advisory unlock instead of dropping it", async () => {
    const warned: Warned[] = []
    const reserved = Object.assign(
      (strings: TemplateStringsArray): Promise<unknown[]> =>
        strings.join("?").includes("pg_advisory_unlock")
          ? Promise.reject(new Error("connection lost"))
          : Promise.resolve([]),
      { release: () => undefined },
    )
    const sql = { reserve: () => Promise.resolve(reserved) } as unknown as Sql
    const repo = makeDrizzleAdminReportRepository(sql, {
      logger: { warn: (obj: unknown, msg?: string) => warned.push({ obj, msg }) },
    })
    await expect(repo.withRouteLock(REPORT_ID, () => Promise.resolve("sent"))).resolves.toBe("sent")
    expect(warned).toHaveLength(1)
    expect(warned[0]?.obj).toMatchObject({ reportId: REPORT_ID })
  })
})
