import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"
import { InMemoryUserStore, type UserRecord } from "../../src/auth/stores.js"
import {
  makeDataExportService,
  DATA_EXPORT_BYTE_BUDGET,
  DATA_EXPORT_FREE_TEXT_MAX_ROWS,
} from "../../src/services/data-export-service.js"

const FROM = "no-reply@civfix.org"
const SUPPORT = "support@civfix.org"
const USER_ID = "11111111-1111-1111-1111-111111111111"

function userRecord(over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: USER_ID,
    role: "citizen",
    displayName: "Jane Neighbor",
    handle: "jane",
    handleChangedAt: null,
    email: "jane@example.com",
    emailVerified: true,
    avatarUrl: null,
    profileComplete: true,
    allowDirectMessages: true,
    showVolunteerHours: null,
    locale: "en",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...over,
  }
}

function harness(
  user: UserRecord,
  handlers: SqlHandler[] = [],
): {
  mailer: FakeMailer
  service: ReturnType<typeof makeDataExportService>
} {
  const users = new InMemoryUserStore()
  users.seed(user.email, user)
  const mailer = new FakeMailer()
  const sql = makeFakeSql(handlers).sql as unknown as Sql
  const service = makeDataExportService({ sql, mailer, users, fromNoReply: FROM, supportEmail: SUPPORT })
  return { mailer, service }
}

function attachmentJson(mailer: FakeMailer): Record<string, unknown> {
  const att = mailer.lastOutbound()!.attachments![0]!
  return JSON.parse(new TextDecoder().decode(att.content))
}

describe("data export", () => {
  it("emails a JSON attachment to the account, From the no-reply mailbox", async () => {
    const { mailer, service } = harness(userRecord())
    const result = await service.exportData(USER_ID)

    expect(result).toEqual({ ok: true, email: "jane@example.com" })

    const out = mailer.lastOutbound()
    expect(out).toBeDefined()
    expect(out!.to).toBe("jane@example.com")
    expect(out!.from).toBe(FROM)
    expect(out!.subject).toBe("Your civfix data export")
    expect(out!.attachments).toHaveLength(1)
    const att = out!.attachments![0]!
    expect(att.filename).toBe("civfix-export.json")
    expect(att.contentType).toBe("application/json")
    const parsed = attachmentJson(mailer)
    expect(parsed.userId).toBe(USER_ID)
    expect(parsed.format).toBe("civfix-data-export@1")
  })

  it("skips the send and returns email:null when the account has no email", async () => {
    const { mailer, service } = harness(userRecord({ email: null }))
    const result = await service.exportData(USER_ID)
    expect(result).toEqual({ ok: true, email: null })
    expect(mailer.lastOutbound()).toBeUndefined()
  })

  it("includes the user's posts and volunteer-hours ledger (F139)", async () => {
    const { mailer, service } = harness(userRecord(), [
      {
        match: /FROM posts/,
        rows: [
          {
            id: "p1",
            kind: "post",
            body: "hello neighbors",
            visibility: "public",
            reply_to_id: null,
            repost_of_id: null,
            created_at: new Date("2026-02-01T00:00:00.000Z"),
            updated_at: new Date("2026-02-01T00:00:00.000Z"),
            deleted_at: null,
          },
        ],
      },
      {
        match: /FROM volunteer_hours/,
        rows: [
          {
            id: "v1",
            source: "event",
            report_id: null,
            cleanup_id: "cl1",
            jurisdiction_geoid: "0600000",
            hours: 2,
            logged_by_user_id: null,
            created_at: new Date("2026-02-02T00:00:00.000Z"),
          },
        ],
      },
    ])
    await service.exportData(USER_ID)
    const parsed = attachmentJson(mailer)
    expect(Array.isArray(parsed.posts)).toBe(true)
    expect((parsed.posts as unknown[]).length).toBe(1)
    expect((parsed.posts as { body: string }[])[0]!.body).toBe("hello neighbors")
    expect(Array.isArray(parsed.volunteerHours)).toBe(true)
    expect((parsed.volunteerHours as { hours: number }[])[0]!.hours).toBe(2)
  })

  it("bounds the attachment to the byte budget and records byte-truncated sections (F018)", async () => {
    const bigBody = "x".repeat(2000)
    const rows = Array.from({ length: DATA_EXPORT_FREE_TEXT_MAX_ROWS + 1000 }, (_, i) => ({
      id: `c${i}`,
      cleanup_id: null,
      report_id: null,
      group_id: null,
      body: bigBody,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      deleted_at: null,
    }))
    const { mailer, service } = harness(userRecord(), [{ match: /FROM chat_messages/, rows }])
    await service.exportData(USER_ID)

    const att = mailer.lastOutbound()!.attachments![0]!
    expect(att.content.byteLength).toBeLessThanOrEqual(DATA_EXPORT_BYTE_BUDGET + 4096)

    const parsed = attachmentJson(mailer)
    expect((parsed.truncated as { sections: string[] }).sections).toContain("chatMessages")
    expect((parsed.chatMessages as unknown[]).length).toBeLessThan(rows.length)
    expect((parsed.truncated as { note: string }).note).toContain(SUPPORT)
  })

  it("redacts push-token secrets and never emails without an email on file", async () => {
    const { mailer, service } = harness(userRecord(), [
      {
        match: /FROM push_tokens/,
        rows: [
          {
            id: "pt1",
            platform: "ios",
            created_at: new Date("2026-01-01T00:00:00.000Z"),
            revoked_at: null,
          },
        ],
      },
    ])
    await service.exportData(USER_ID)
    const parsed = attachmentJson(mailer)
    expect((parsed.pushTokens as { token: string }[])[0]!.token).toBe("[REDACTED]")
  })
})
