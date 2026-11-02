// GH#225 / D10: who a notification email may go to is read in one statement per batch, and the
// one-click unsubscribe writes only for a live account. Both against Postgres.

import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeDrizzleNotificationSettingsRepository } from "../../src/services/notification-settings-repository.drizzle.js"
import { emailHashOf } from "../../src/services/host/broadcast-service.js"
import { makeSqlRecorder } from "../helpers/sql-recorder.js"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

describe.skipIf(!pg)("notification email recipients (Postgres)", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(fields: {
    email: string | null
    verified: boolean
    deleted?: boolean
    locale?: string
  }): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, locale, deleted_at)
      VALUES (
        'Recipient', ${testHandle()}, ${fields.email}, ${fields.verified}, ${fields.locale ?? "en"},
        ${fields.deleted === true ? new Date() : null}
      )
      RETURNING id
    `
    return row!.id
  }

  it("T26: one ANY statement returns only the verified, live, unsuppressed user with its email and locale", async () => {
    const live = await newUser({ email: "live@example.test", verified: true, locale: "es" })
    const unverified = await newUser({ email: "unverified@example.test", verified: false })
    const deleted = await newUser({ email: "deleted@example.test", verified: true, deleted: true })
    const noEmail = await newUser({ email: null, verified: true })
    const suppressed = await newUser({ email: "U@Example.test", verified: true })
    await h.sql`
      INSERT INTO email_suppressions (email_hash, reason)
      VALUES (${emailHashOf("U@Example.test")}, 'hard_bounce')
    `
    const ids = [live, unverified, deleted, noEmail, suppressed, randomUUID()]

    const found = await makeDrizzleNotificationRepository(h.sql).findEmailRecipients(ids)

    expect(found).toEqual([{ userId: live, email: "live@example.test", locale: "es" }])

    const rec = makeSqlRecorder()
    await makeDrizzleNotificationRepository(rec.sql).findEmailRecipients(ids)
    expect(rec.queries).toHaveLength(1)
    expect(rec.queries[0]!.text).toMatch(/= ANY\(\$1(::uuid\[\])?\)/)
    expect(rec.queries[0]!.params).toEqual([ids])
  })

  it("matches a suppression whatever the stored address's case and surrounding spaces", async () => {
    const user = await newUser({ email: "Mixed.Case@Example.test", verified: true })
    await h.sql`
      INSERT INTO email_suppressions (email_hash, reason)
      VALUES (${emailHashOf(" mixed.case@example.TEST ")}, 'complaint')
    `

    expect(await makeDrizzleNotificationRepository(h.sql).findEmailRecipients([user])).toEqual([])
  })

  it("looks nothing up for an empty batch", async () => {
    const rec = makeSqlRecorder()
    expect(await makeDrizzleNotificationRepository(rec.sql).findEmailRecipients([])).toEqual([])
    expect(rec.queries).toHaveLength(0)
  })

  async function stored(userId: string) {
    return h.sql<{ category: string; enabled: boolean; push: boolean; email: boolean }[]>`
      SELECT category, enabled, push, email FROM notification_settings
      WHERE user_id = ${userId} ORDER BY category
    `
  }

  it("disableEmail unchecks Email from the default for a new row and keeps a stored row's other fields", async () => {
    const repo = makeDrizzleNotificationSettingsRepository(h.sql)
    const user = await newUser({ email: "settings@example.test", verified: true })
    await repo.upsertSettings(user, {
      hostAnnouncements: { enabled: true, push: false, email: true },
    })

    expect(await repo.disableEmail(user, "events")).toBe(true)
    expect(await repo.disableEmail(user, "hostAnnouncements")).toBe(true)
    expect(await repo.disableEmail(user, "hostAnnouncements")).toBe(true)

    expect([...(await stored(user))]).toEqual([
      { category: "events", enabled: true, push: true, email: false },
      { category: "hostAnnouncements", enabled: true, push: false, email: false },
    ])
  })

  it("disableEmail writes nothing for an erased or unknown account", async () => {
    const repo = makeDrizzleNotificationSettingsRepository(h.sql)
    const erased = await newUser({ email: "erased@example.test", verified: true, deleted: true })
    const unknown = randomUUID()

    expect(await repo.disableEmail(erased, "events")).toBe(false)
    expect(await repo.disableEmail(unknown, "events")).toBe(false)

    expect([...(await stored(erased))]).toEqual([])
    expect([...(await stored(unknown))]).toEqual([])
  })
})
