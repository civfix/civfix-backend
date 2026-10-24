import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { makeDrizzleNotificationSettingsRepository } from "../../src/services/notification-settings-repository.drizzle.js"
import { makeSqlRecorder } from "../helpers/sql-recorder.js"

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

describe("notification settings repository: statements per call", () => {
  it("T21: getSettingsMany([]) runs no query", async () => {
    const rec = makeSqlRecorder()
    expect(await makeDrizzleNotificationSettingsRepository(rec.sql).getSettingsMany([])).toEqual([])
    expect(rec.queries).toHaveLength(0)
  })

  it("T22: getSettingsMany over 2000 ids is one query with the ids as one array parameter", async () => {
    const rec = makeSqlRecorder()
    const ids = Array.from({ length: 2000 }, () => randomUUID())
    await makeDrizzleNotificationSettingsRepository(rec.sql).getSettingsMany(ids)
    expect(rec.queries).toHaveLength(1)
    expect(rec.queries[0]!.text).toMatch(/= ANY\(\$1(::uuid\[\])?\)/)
    expect(rec.queries[0]!.params).toEqual([ids])
  })

  it("T25: an upsert naming two categories is one statement", async () => {
    const rec = makeSqlRecorder()
    await makeDrizzleNotificationSettingsRepository(rec.sql).upsertSettings(USER, {
      events: { push: false },
      followers: { enabled: false, push: true },
    })
    expect(rec.queries).toHaveLength(1)
    expect(rec.queries[0]!.text).toMatch(/INSERT INTO notification_settings/)
  })

  it("T26: an empty upsert runs no query", async () => {
    const rec = makeSqlRecorder()
    await makeDrizzleNotificationSettingsRepository(rec.sql).upsertSettings(USER, {})
    expect(rec.queries).toHaveLength(0)
  })
})
