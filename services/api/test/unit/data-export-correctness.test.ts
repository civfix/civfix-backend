import { describe, it, expect } from "vitest"
import { ErrorCode, MailSendError, type OutboundEmail, type SentMail } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"
import { InMemoryUserStore, type UserRecord } from "../../src/auth/stores.js"
import {
  makeDataExportService,
  DATA_EXPORT_FREE_TEXT_MAX_ROWS,
  DATA_EXPORT_MAX_ROWS,
} from "../../src/services/data-export-service.js"
import type { JobHandler } from "@civfix/shared/interfaces"
import type { Container } from "../../src/di.js"
import { registerDataExportJobs, runDataExport } from "../../src/services/data-export-jobs.js"
import { DATA_EXPORT_JOB } from "../../src/lib/queue-names.js"

const FROM = "no-reply@civfix.org"
const SUPPORT = "support@civfix.org"
const USER_ID = "11111111-1111-1111-1111-111111111111"
const EMAIL = "jane@example.com"
const AUDIT_ROW: SqlHandler = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }
const LARGE_BODY_BYTES = 2000
const CERTIFICATE_ROW = { id: "cert-1", issuer: "y".repeat(LARGE_BODY_BYTES * 2) }

const OVERSIZE = new MailSendError(ErrorCode.CONFLICT, "too large", { responseCode: 552 })
const RECIPIENT_REJECTED = new MailSendError(ErrorCode.CONFLICT, "rejected", {
  responseCode: 550,
  response: "550 5.1.1 recipient rejected: no such user",
})
const SENDER_REJECTED = new MailSendError(ErrorCode.CONFLICT, "sender not approved", {
  responseCode: 550,
  response: "550 sender address not approved",
})
const MESSAGE_REJECTED = new MailSendError(ErrorCode.CONFLICT, "message refused", {
  responseCode: 554,
  command: "DATA",
  code: "EMESSAGE",
  response: "554 5.7.1 message content rejected by policy",
})

/** Fails every send that carries an attachment with `failure`; plain notices go through. */
class AttachmentRejectingMailer extends FakeMailer {
  constructor(private readonly failure: Error) {
    super()
  }

  override sendOutbound(email: OutboundEmail): Promise<SentMail> {
    if ((email.attachments?.length ?? 0) > 0) return Promise.reject(this.failure)
    return super.sendOutbound(email)
  }
}

function userRecord(): UserRecord {
  return {
    id: USER_ID,
    role: "citizen",
    displayName: "Jane Neighbor",
    handle: "jane",
    handleChangedAt: null,
    email: EMAIL,
    emailVerified: true,
    primaryOrganizationId: null,
    avatarUrl: null,
    profileComplete: true,
    allowDirectMessages: true,
    showVolunteerHours: null,
    locale: "en",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  }
}

function harness(mailer: FakeMailer, handlers: SqlHandler[] = []) {
  const users = new InMemoryUserStore()
  users.seed(EMAIL, userRecord())
  const ctl: FakeSqlControl = makeFakeSql([AUDIT_ROW, ...handlers])
  const service = makeDataExportService({
    sql: ctl.sql as unknown as Sql,
    mailer,
    users,
    fromNoReply: FROM,
    supportEmail: SUPPORT,
  })
  return { ctl, service }
}

function auditActions(ctl: FakeSqlControl): unknown[] {
  return ctl.statements.filter((s) => /INSERT INTO audit_log/.test(s.sql)).map((s) => s.values[1])
}

function auditReasons(ctl: FakeSqlControl): unknown[] {
  return ctl.statements
    .filter((s) => /INSERT INTO audit_log/.test(s.sql))
    .map((s) => (s.values[3] as { reason?: unknown } | null)?.reason)
}

describe("a data export the mail provider refuses is not dropped silently", () => {
  it("oversize: tells the user where to get the export and leaves an operator record", async () => {
    const mailer = new AttachmentRejectingMailer(OVERSIZE)
    const { ctl, service } = harness(mailer)
    await runDataExport(service, USER_ID)
    const notice = mailer.lastOutbound()
    expect(notice?.to).toBe(EMAIL)
    expect(notice?.attachments ?? []).toHaveLength(0)
    expect(notice?.text).toContain(SUPPORT)
    expect(auditActions(ctl)).toEqual(["data_export.undeliverable"])
  })

  it("recipient rejected: records it for an operator and sends nothing that would bounce again", async () => {
    const mailer = new AttachmentRejectingMailer(RECIPIENT_REJECTED)
    const { ctl, service } = harness(mailer)
    await runDataExport(service, USER_ID)
    expect(mailer.lastOutbound()).toBeUndefined()
    expect(auditActions(ctl)).toEqual(["data_export.undeliverable"])
  })

  it("sender rejected: a platform config fault, so the job retries", async () => {
    const mailer = new AttachmentRejectingMailer(SENDER_REJECTED)
    const { service } = harness(mailer)
    await expect(runDataExport(service, USER_ID)).rejects.toBe(SENDER_REJECTED)
  })

  it("sender rejected on the last attempt: records the request instead of dropping it", async () => {
    const mailer = new AttachmentRejectingMailer(SENDER_REJECTED)
    const { ctl, service } = harness(mailer)
    await expect(
      runDataExport(service, USER_ID, undefined, { finalAttempt: true }),
    ).resolves.toBeUndefined()
    expect(auditActions(ctl)).toEqual(["data_export.undeliverable"])
    expect(auditReasons(ctl)).toEqual(["rejected"])
    expect(mailer.lastOutbound()).toBeUndefined()
  })

  it("a message the provider refuses at DATA is recorded at once, not rebuilt and resent", async () => {
    const mailer = new AttachmentRejectingMailer(MESSAGE_REJECTED)
    const { ctl, service } = harness(mailer)
    await expect(runDataExport(service, USER_ID)).resolves.toBeUndefined()
    expect(auditReasons(ctl)).toEqual(["rejected"])
  })

  it("the job handler treats pg-boss's last retry as the final attempt", async () => {
    const mailer = new AttachmentRejectingMailer(SENDER_REJECTED)
    const { ctl, service } = harness(mailer)
    const handlers = new Map<string, JobHandler>()
    const container = {
      jobs: {
        work: (name: string, handler: JobHandler) => {
          handlers.set(name, handler)
          return Promise.resolve()
        },
      },
    } as unknown as Container
    await registerDataExportJobs(container, { makeService: () => service })
    const handler = handlers.get(DATA_EXPORT_JOB)!

    await expect(
      handler({ id: "job-1", data: { userId: USER_ID }, retryCount: 1, retryLimit: 10 } as never),
    ).rejects.toBe(SENDER_REJECTED)
    expect(auditActions(ctl)).toEqual([])

    await expect(
      handler({ id: "job-1", data: { userId: USER_ID }, retryCount: 10, retryLimit: 10 } as never),
    ).resolves.toBeUndefined()
    expect(auditReasons(ctl)).toEqual(["rejected"])
  })
})

describe("the export byte budget favors the small structured sections", () => {
  it("keeps a certificate even when chat messages alone exceed the budget", async () => {
    const bigBody = "x".repeat(LARGE_BODY_BYTES)
    const chatRows = Array.from({ length: DATA_EXPORT_FREE_TEXT_MAX_ROWS }, (_, i) => ({
      id: `c${i}`,
      cleanup_id: null,
      report_id: null,
      group_id: null,
      body: bigBody,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      deleted_at: null,
    }))
    const mailer = new FakeMailer()
    const { service } = harness(mailer, [
      { match: /FROM chat_messages/, rows: chatRows },
      { match: /FROM service_hours_certificates/, rows: [CERTIFICATE_ROW] },
    ])
    await service.exportData(USER_ID)
    const att = mailer.lastOutbound()!.attachments![0]!
    const parsed = JSON.parse(new TextDecoder().decode(att.content)) as Record<string, unknown>
    expect(parsed.certificates).toEqual([CERTIFICATE_ROW])
    const truncated = parsed.truncated as {
      sections: string[]
      sectionCaps: Record<string, number>
    }
    expect(truncated.sections).toEqual(["chatMessages"])
    expect(Object.keys(parsed).indexOf("chatMessages")).toBeLessThan(
      Object.keys(parsed).indexOf("certificates"),
    )
  })

  it("reports each truncated section's own row cap", async () => {
    const postRows = Array.from({ length: DATA_EXPORT_FREE_TEXT_MAX_ROWS + 1 }, (_, i) => ({
      id: `p${i}`,
    }))
    const mailer = new FakeMailer()
    const { service } = harness(mailer, [{ match: /FROM posts/, rows: postRows }])
    await service.exportData(USER_ID)
    const att = mailer.lastOutbound()!.attachments![0]!
    const parsed = JSON.parse(new TextDecoder().decode(att.content)) as {
      truncated: { capPerSection: number; sectionCaps: Record<string, number> }
    }
    expect(parsed.truncated.sectionCaps).toEqual({ posts: DATA_EXPORT_FREE_TEXT_MAX_ROWS })
    expect(parsed.truncated.capPerSection).toBe(DATA_EXPORT_MAX_ROWS)
  })
})
