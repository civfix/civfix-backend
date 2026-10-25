/**
 * drizzle/0199_notification_settings.sql against a real database. The template every other file clones
 * already has 0199 applied, so this file first takes its own database back to 0198 (drops the table),
 * seeds old notification_prefs rows, then applies the canonical file as the runner does (one
 * transaction, simple-query mode).
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0199_notification_settings.sql", import.meta.url),
)

type PrefFlag =
  | "push"
  | "cleanup_chat"
  | "report_updates"
  | "follows"
  | "mentions"
  | "post_interactions"
  | "host_broadcasts"

type Triple = [enabled: boolean, push: boolean, email: boolean]

interface SettingRow {
  user_id: string
  category: string
  enabled: boolean
  push: boolean
  email: boolean
  updated_at: Date
}

describe.skipIf(!pg)("0199 notification settings migration (integration)", () => {
  let h: PgHarness
  let text: string
  const users: Record<string, string> = {}

  const apply = () => h.sql.begin((tx) => tx.unsafe(text))

  async function newUser(): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Prefs', ${testHandle()}) RETURNING id
    `
    return row!.id
  }

  async function seedPrefs(
    userId: string,
    off: PrefFlag[],
    quiet: { start: string; end: string; tz: string } | null = null,
  ): Promise<void> {
    const flag = (f: PrefFlag) => !off.includes(f)
    await h.sql`
      INSERT INTO notification_prefs (
        user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions,
        host_broadcasts, quiet_start, quiet_end, tz
      ) VALUES (
        ${userId}, ${flag("push")}, ${flag("cleanup_chat")}, ${flag("report_updates")},
        ${flag("follows")}, ${flag("mentions")}, ${flag("post_interactions")},
        ${flag("host_broadcasts")}, ${quiet?.start ?? null}, ${quiet?.end ?? null}, ${quiet?.tz ?? null}
      )
    `
  }

  async function settingsOf(userId: string): Promise<Record<string, Triple>> {
    const rows = await h.sql<SettingRow[]>`
      SELECT category, enabled, push, email FROM notification_settings WHERE user_id = ${userId}
    `
    return Object.fromEntries(rows.map((r) => [r.category, [r.enabled, r.push, r.email]]))
  }

  const allSettings = () => h.sql<SettingRow[]>`
    SELECT user_id, category, enabled, push, email, updated_at FROM notification_settings
    ORDER BY user_id, category
  `

  const allPrefs = () => h.sql`SELECT * FROM notification_prefs ORDER BY user_id`

  let prefsBefore: unknown[]

  beforeAll(async () => {
    h = pg as PgHarness
    text = await readFile(MIGRATION, "utf8")
    await h.sql`DROP TABLE IF EXISTS notification_settings`

    const seeds: [string, PrefFlag[] | null][] = [
      ["allOn", []],
      ["noPrefs", null],
      ["pushOff", ["push"]],
      ["reportUpdatesOff", ["report_updates"]],
      ["cleanupChatOff", ["cleanup_chat"]],
      ["mentionsOff", ["mentions"]],
      ["followsOff", ["follows"]],
      ["postInteractionsOff", ["post_interactions"]],
      ["hostBroadcastsOff", ["host_broadcasts"]],
      ["combined", ["push", "mentions", "host_broadcasts", "cleanup_chat"]],
    ]
    for (const [name, off] of seeds) {
      users[name] = await newUser()
      if (off !== null) {
        await seedPrefs(
          users[name],
          off,
          name === "combined" ? { start: "22:00", end: "07:30", tz: "America/Los_Angeles" } : null,
        )
      }
    }
    prefsBefore = [...(await allPrefs())]

    await apply()
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("T5: sets lock_timeout = '3s' before its first DDL statement", () => {
    const statements = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "")
    const timeout = statements.indexOf("SET LOCAL lock_timeout = '3s'")
    expect(timeout).toBeGreaterThanOrEqual(0)
    const firstDdl = statements.findIndex((s) => /^(CREATE|ALTER|DROP)\b/i.test(s))
    expect(firstDdl).toBeGreaterThan(timeout)
  })

  it("T6: creates notification_settings with exactly the D4 columns, key and cascading FK", async () => {
    const columns = await h.sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notification_settings'
      ORDER BY ordinal_position
    `
    expect(columns.map((c) => Object.values(c))).toEqual([
      ["user_id", "uuid", "NO", null],
      ["category", "text", "NO", null],
      ["enabled", "boolean", "NO", null],
      ["push", "boolean", "NO", null],
      ["email", "boolean", "NO", null],
      ["updated_at", "timestamp with time zone", "NO", "now()"],
    ])
    const constraints = await h.sql<{ contype: string; def: string }[]>`
      SELECT contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = to_regclass('notification_settings')
      ORDER BY contype, def
    `
    expect([...constraints]).toEqual([
      { contype: "f", def: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" },
      { contype: "p", def: "PRIMARY KEY (user_id, category)" },
    ])
  })

  it("T7: all-true prefs and no prefs row both backfill nothing", async () => {
    expect(await settingsOf(users.allOn!)).toEqual({})
    expect(await settingsOf(users.noPrefs!)).toEqual({})
  })

  it("T8: push = false unchecks Push wherever the default has it checked", async () => {
    expect(await settingsOf(users.pushOff!)).toEqual({
      reportUpdates: [true, false, false],
      directMessages: [true, false, false],
      mentions: [true, false, false],
      events: [true, false, true],
      hostAnnouncements: [true, false, false],
      eventTeam: [true, false, false],
    })
  })

  it("T9: report_updates = false unchecks Push on reportUpdates", async () => {
    expect(await settingsOf(users.reportUpdatesOff!)).toEqual({
      reportUpdates: [true, false, false],
    })
  })

  it("T10: cleanup_chat = false unchecks Push on events and eventTeam", async () => {
    expect(await settingsOf(users.cleanupChatOff!)).toEqual({
      events: [true, false, true],
      eventTeam: [true, false, false],
    })
  })

  it("T11: mentions = false turns mentions Off", async () => {
    expect(await settingsOf(users.mentionsOff!)).toEqual({ mentions: [false, true, false] })
  })

  it("T12: follows = false and post_interactions = false backfill nothing", async () => {
    expect(await settingsOf(users.followsOff!)).toEqual({})
    expect(await settingsOf(users.postInteractionsOff!)).toEqual({})
  })

  it("T13: host_broadcasts = false turns hostAnnouncements Off", async () => {
    expect(await settingsOf(users.hostBroadcastsOff!)).toEqual({
      hostAnnouncements: [false, true, false],
    })
  })

  it("T14: several switches off combine", async () => {
    expect(await settingsOf(users.combined!)).toEqual({
      reportUpdates: [true, false, false],
      directMessages: [true, false, false],
      mentions: [false, false, false],
      events: [true, false, true],
      hostAnnouncements: [false, false, false],
      eventTeam: [true, false, false],
    })
  })

  it("T15: a second run changes no row, updated_at included", async () => {
    const before = [...(await allSettings())]
    await apply()
    expect([...(await allSettings())]).toEqual(before)
  })

  it("T16: a second run keeps a row changed since the first", async () => {
    await h.sql`
      UPDATE notification_settings SET enabled = true, push = true, email = true
      WHERE user_id = ${users.pushOff!} AND category = 'events'
    `
    await apply()
    expect((await settingsOf(users.pushOff!)).events).toEqual([true, true, true])
  })

  it("T17: leaves every notification_prefs row unchanged", async () => {
    expect([...(await allPrefs())]).toEqual(prefsBefore)
  })

  it("T18: deleting a user deletes their settings rows", async () => {
    const userId = users.combined!
    expect(Object.keys(await settingsOf(userId))).not.toHaveLength(0)
    // notification_prefs references users without a cascade, so it goes first.
    await h.sql`DELETE FROM notification_prefs WHERE user_id = ${userId}`
    await h.sql`DELETE FROM users WHERE id = ${userId}`
    expect(await settingsOf(userId)).toEqual({})
  })
})
