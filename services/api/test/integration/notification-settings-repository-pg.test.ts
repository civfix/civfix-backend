/**
 * The notification_settings repository's behavior, run against the Drizzle repository on Postgres and the
 * in-memory helper alike, so the two stay interchangeable. The query counts are pinned separately, on the
 * Drizzle repository alone (test/unit/notification-settings-repository-sql.test.ts).
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { NotificationCategory } from "@civfix/contract"
import { makeDrizzleNotificationSettingsRepository } from "../../src/services/notification-settings-repository.drizzle.js"
import type {
  NotificationSettingRecord,
  NotificationSettingsRepository,
} from "../../src/services/notification-settings-repository.js"
import { InMemoryNotificationSettingsRepository } from "../helpers/notifications.js"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

interface Stored {
  category: NotificationCategory
  enabled: boolean
  push: boolean
  email: boolean
  updatedAt: Date
}

interface Subject {
  repo: NotificationSettingsRepository
  newUser(): Promise<string>
  stored(userId: string): Promise<Stored[]>
}

function byCategory<T extends { userId?: string; category: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    `${a.userId ?? ""}:${a.category}`.localeCompare(`${b.userId ?? ""}:${b.category}`),
  )
}

function contract(
  repoName: string,
  setup: () => Promise<Subject>,
  teardown: () => Promise<void>,
  skip: boolean,
) {
  describe.skipIf(skip)(`notification settings repository (${repoName})`, () => {
    let s: Subject

    beforeAll(async () => {
      s = await setup()
    })

    afterAll(teardown)

    it("T19: a user with no rows gets [] (no defaults filled in)", async () => {
      const user = await s.newUser()
      expect(await s.repo.getSettings(user)).toEqual([])
    })

    it("T20: getSettings returns exactly that user's stored rows", async () => {
      const a = await s.newUser()
      const b = await s.newUser()
      await s.repo.upsertSettings(a, {
        events: { push: false },
        mentions: { enabled: false },
      })
      await s.repo.upsertSettings(b, { followers: { push: true } })

      const rows = await s.repo.getSettings(a)
      expect(byCategory(rows)).toEqual<NotificationSettingRecord[]>([
        { userId: a, category: "events", enabled: true, push: false, email: true },
        { userId: a, category: "mentions", enabled: false, push: true, email: false },
      ])
    })

    it("T21: getSettingsMany([]) returns []", async () => {
      expect(await s.repo.getSettingsMany([])).toEqual([])
    })

    it("T22: getSettingsMany returns the listed users' stored rows only", async () => {
      const listed = [await s.newUser(), await s.newUser(), await s.newUser()]
      const outsider = await s.newUser()
      await s.repo.upsertSettings(listed[0]!, { events: { push: false } })
      await s.repo.upsertSettings(listed[1]!, {
        followers: { push: true },
        organizations: { email: false },
      })
      await s.repo.upsertSettings(listed[2]!, { mentions: { enabled: false } })
      await s.repo.upsertSettings(outsider, { events: { email: false } })

      const ids = [...listed]
      while (ids.length < 2000) ids.push(randomUUID())

      const rows = await s.repo.getSettingsMany(ids)
      expect(byCategory(rows)).toEqual(
        byCategory<NotificationSettingRecord>([
          { userId: listed[0]!, category: "events", enabled: true, push: false, email: true },
          { userId: listed[1]!, category: "followers", enabled: true, push: true, email: false },
          {
            userId: listed[1]!,
            category: "organizations",
            enabled: true,
            push: false,
            email: false,
          },
          { userId: listed[2]!, category: "mentions", enabled: false, push: true, email: false },
        ]),
      )
    })

    it("T23: a new row takes the fields not given from NOTIFICATION_CATEGORY_DEFAULTS", async () => {
      const user = await s.newUser()
      await s.repo.upsertSettings(user, { events: { push: false } })
      expect((await s.stored(user)).map(({ updatedAt: _, ...row }) => row)).toEqual([
        { category: "events", enabled: true, push: false, email: true },
      ])
    })

    it("T24: an existing row changes only the given fields and its updated_at", async () => {
      const user = await s.newUser()
      await s.repo.upsertSettings(user, {
        events: { push: false },
        mentions: { push: true },
      })
      const [eventsBefore, mentionsBefore] = await s.stored(user)
      expect(eventsBefore).toMatchObject({
        category: "events",
        enabled: true,
        push: false,
        email: true,
      })
      expect(mentionsBefore).toMatchObject({
        category: "mentions",
        enabled: true,
        push: true,
        email: false,
      })

      await s.repo.upsertSettings(user, { events: { email: false } })

      const [events, mentions] = await s.stored(user)
      expect(events).toMatchObject({ category: "events", enabled: true, push: false, email: false })
      expect(events!.updatedAt.getTime()).toBeGreaterThan(eventsBefore!.updatedAt.getTime())
      expect(mentions).toEqual(mentionsBefore)
    })

    it("T25: several categories are written together", async () => {
      const user = await s.newUser()
      await s.repo.upsertSettings(user, {
        events: { push: false },
        followers: { enabled: false, push: true },
      })
      expect((await s.stored(user)).map(({ updatedAt: _, ...row }) => row)).toEqual([
        { category: "events", enabled: true, push: false, email: true },
        { category: "followers", enabled: false, push: true, email: false },
      ])
    })

    it("T26: an empty patch writes nothing", async () => {
      const user = await s.newUser()
      await s.repo.upsertSettings(user, {})
      expect(await s.stored(user)).toEqual([])
    })
  })
}

let h: PgHarness

contract(
  "Drizzle, Postgres",
  () => {
    h = pg as PgHarness
    return Promise.resolve({
      repo: makeDrizzleNotificationSettingsRepository(h.sql),
      async newUser() {
        const [row] = await h.sql<{ id: string }[]>`
          INSERT INTO users (display_name, handle) VALUES ('Settings', ${testHandle()}) RETURNING id
        `
        return row!.id
      },
      async stored(userId) {
        const rows = await h.sql<
          {
            category: NotificationCategory
            enabled: boolean
            push: boolean
            email: boolean
            updated_at: Date
          }[]
        >`
          SELECT category, enabled, push, email, updated_at FROM notification_settings
          WHERE user_id = ${userId} ORDER BY category
        `
        return rows.map((r) => ({
          category: r.category,
          enabled: r.enabled,
          push: r.push,
          email: r.email,
          updatedAt: r.updated_at,
        }))
      },
    })
  },
  async () => {
    await h.teardown()
  },
  !pg,
)

contract(
  "in memory",
  () => {
    const repo = new InMemoryNotificationSettingsRepository()
    let tick = Date.parse("2026-10-01T00:00:00.000Z")
    repo.now = () => new Date((tick += 1000))
    return Promise.resolve({
      repo,
      newUser: () => Promise.resolve(randomUUID()),
      stored: (userId) =>
        Promise.resolve(
          byCategory([...repo.rows.values()].filter((r) => r.userId === userId)).map(
            ({ userId: _, ...row }) => row,
          ),
        ),
    })
  },
  () => Promise.resolve(),
  false,
)
