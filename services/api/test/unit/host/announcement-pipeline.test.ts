import { describe, expect, it } from "vitest"
import { ANNOUNCEMENT_BROADCAST_KIND } from "@civfix/shared"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"
import { makeDrizzleBroadcastRepository } from "../../../src/services/host/broadcast-repository.drizzle.js"
import { InMemoryBroadcastRepository } from "../../../src/services/host/broadcast-repository.memory.js"
import {
  KIND_NOTIFICATION_TYPE,
  announcementPath,
  notificationLink,
} from "../../../src/services/host/broadcast-pipeline.js"
import {
  CRITICAL_BROADCAST_KINDS,
  HOST_COMPOSED_BROADCAST_KINDS,
} from "../../../src/services/host/broadcast-types.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const ANNOUNCEMENT = "00000000-0000-0000-0000-0000000000a1"

describe("announcement notification routing", () => {
  it("emits exactly the path the mobile deep-link allowlist accepts", () => {
    expect(announcementPath(EVENT, ANNOUNCEMENT)).toBe(
      `/cleanups/${EVENT}/announcements/${ANNOUNCEMENT}`,
    )
  })

  it("links an announcement to itself, not to the event page", () => {
    const link = notificationLink(
      { id: ANNOUNCEMENT, kind: ANNOUNCEMENT_BROADCAST_KIND, cleanupId: EVENT },
      { pageSlug: "beach-cleanup" },
    )
    expect(link).toBe(`/cleanups/${EVENT}/announcements/${ANNOUNCEMENT}`)
  })

  it("leaves every other broadcast kind pointing at the event page", () => {
    expect(
      notificationLink(
        { id: ANNOUNCEMENT, kind: "host_broadcast", cleanupId: EVENT },
        { pageSlug: "beach-cleanup" },
      ),
    ).toBe("/e/beach-cleanup")
  })

  it("reuses the event_broadcast notification type so the existing prefs plumbing applies", () => {
    expect(KIND_NOTIFICATION_TYPE[ANNOUNCEMENT_BROADCAST_KIND]).toBe("event_broadcast")
  })
})

describe("announcement audience gates", () => {
  it("is host-composed, so the hostBroadcasts preference opts a recipient out", () => {
    expect(HOST_COMPOSED_BROADCAST_KINDS.has(ANNOUNCEMENT_BROADCAST_KIND)).toBe(true)
  })

  it("is not critical, so unsubscribes and per-event mutes are honored", () => {
    expect(CRITICAL_BROADCAST_KINDS.has(ANNOUNCEMENT_BROADCAST_KIND)).toBe(false)
  })
})

describe("retention: announcements are permanent public content", () => {
  it("the in-memory scrub skips announcements and still scrubs a host broadcast", async () => {
    const repo = new InMemoryBroadcastRepository()
    const finished = new Date("2026-01-01T00:00:00Z")
    const announcement = await repo.create({
      cleanupId: EVENT,
      createdBy: null,
      kind: ANNOUNCEMENT_BROADCAST_KIND,
      subject: "Pizza is here",
      bodyMd: "Meet at the pavilion.",
      segment: { kind: "all_registered" },
      channels: ["inapp", "push", "email"],
    })
    const broadcast = await repo.create({
      cleanupId: EVENT,
      createdBy: null,
      kind: "host_broadcast",
      subject: "Bring gloves",
      bodyMd: "See you there.",
      segment: { kind: "all_registered" },
      channels: ["email"],
    })
    await repo.transition(announcement.id, ["draft"], "sent", { finishedAt: finished })
    await repo.transition(broadcast.id, ["draft"], "sent", { finishedAt: finished })

    const scrubbed = await repo.scrubBroadcastContent(new Date("2026-06-01T00:00:00Z"), 100)

    expect(scrubbed).toBe(1)
    expect((await repo.findById(announcement.id))?.bodyMd).toBe("Meet at the pavilion.")
    expect((await repo.findById(broadcast.id))?.bodyMd).toBeNull()
  })

  it("the drizzle scrub statement carries the announcement exemption predicate", async () => {
    const fake = makeFakeSql([{ match: /UPDATE broadcasts/, rows: [] }])

    await makeDrizzleBroadcastRepository(fake.sql as unknown as Sql).scrubBroadcastContent(
      new Date("2026-06-01T00:00:00Z"),
      100,
    )

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(/kind <> \?/)
    expect(statement.values).toContain(ANNOUNCEMENT_BROADCAST_KIND)
  })
})

describe("announcement listing SQL", () => {
  it("filters to the announcement kind and the publicly visible statuses, newest first", async () => {
    const fake = makeFakeSql([{ match: /FROM broadcasts/, rows: [] }])

    await makeDrizzleBroadcastRepository(fake.sql as unknown as Sql).listAnnouncements({
      cleanupId: EVENT,
      cursor: null,
      limit: 21,
    })

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(/kind = \?/)
    expect(statement.sql).toMatch(/status = ANY\(\?::text\[\]\)/)
    expect(statement.sql).toMatch(/ORDER BY created_at DESC, id DESC/)
    expect(statement.values).toContain(ANNOUNCEMENT_BROADCAST_KIND)
    expect(statement.values).toContain(21)
  })

  it("keyset-pages on (created_at, id) when a cursor is supplied", async () => {
    const fake = makeFakeSql([{ match: /FROM broadcasts/, rows: [] }])
    const at = new Date("2026-01-20T12:00:00Z")

    await makeDrizzleBroadcastRepository(fake.sql as unknown as Sql).listAnnouncements({
      cleanupId: EVENT,
      cursor: { at, atText: at.toISOString(), id: ANNOUNCEMENT },
      limit: 21,
    })

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(/\(created_at, id\) < \(\?::timestamptz, \?::uuid\)/)
    expect(statement.values).toContain(ANNOUNCEMENT)
  })

  it("counts only non-draft announcements inside the rolling window", async () => {
    const fake = makeFakeSql([{ match: /count\(\*\)::int AS n FROM broadcasts/, rows: [{ n: 3 }] }])
    const since = new Date("2026-01-19T12:00:00Z")

    const used = await makeDrizzleBroadcastRepository(
      fake.sql as unknown as Sql,
    ).countAnnouncementsSince(EVENT, since)

    expect(used).toBe(3)
    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(/status <> 'draft'/)
    expect(statement.sql).toMatch(/created_at >= \?/)
    expect(statement.values).toContain(since)
  })
})
