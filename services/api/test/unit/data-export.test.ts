import { describe, it, expect } from "vitest"
import { FakeMailer, FakeStorage } from "@civfix/shared/fakes"
import type { Sql } from "../../src/db/client.js"
import type { Storage } from "@civfix/shared/interfaces"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { InMemoryUserStore, type UserRecord } from "../../src/auth/stores.js"
import { makeDataExportService } from "../../src/services/data-export-service.js"

/**
 * Offline unit tests for the data-export service: it gathers the user's data via the per-source SELECTs
 * (here the scripted fake `sql` returns empty rows — the join shapes are exercised by the integration
 * suite) and emails a single JSON attachment via FakeMailer.sendOutbound. When the account has no email it
 * skips the send and returns email:null.
 */

const FROM = "no-reply@civfix.org"
const USER_ID = "11111111-1111-1111-1111-111111111111"

function userRecord(over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: USER_ID,
    role: "citizen",
    displayName: "Jane Neighbor",
    handle: "jane",
    email: "jane@example.com",
    emailVerified: true,
    avatarUrl: null,
    profileComplete: true,
    allowDirectMessages: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...over,
  }
}

function harness(user: UserRecord): {
  mailer: FakeMailer
  service: ReturnType<typeof makeDataExportService>
} {
  const users = new InMemoryUserStore()
  users.seed(user.email, user)
  const mailer = new FakeMailer()
  const sql = makeFakeSql().sql as unknown as Sql
  const storage: Storage = new FakeStorage()
  const service = makeDataExportService({ sql, mailer, storage, users, fromNoReply: FROM })
  return { mailer, service }
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
    // The attachment is the serialized export object (parseable JSON carrying the user id).
    const parsed = JSON.parse(new TextDecoder().decode(att.content))
    expect(parsed.userId).toBe(USER_ID)
    expect(parsed.format).toBe("civfix-data-export@1")
  })

  it("skips the send and returns email:null when the account has no email", async () => {
    const { mailer, service } = harness(userRecord({ email: null }))
    const result = await service.exportData(USER_ID)
    expect(result).toEqual({ ok: true, email: null })
    expect(mailer.lastOutbound()).toBeUndefined()
  })
})
