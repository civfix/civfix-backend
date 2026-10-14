import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { writeAll } from "../../src/db/seed-demo-la.js"
import type { TransactionSql } from "../../src/db/client.js"

type SeedData = Parameters<typeof writeAll>[1]

const NOW = new Date("2026-09-20T12:00:00Z")
const USER_ID = "66666666-6666-6666-6666-666666666666"
const EVENT_ID = "77777777-7777-7777-7777-777777777777"
const REPORT_ID = "88888888-8888-8888-8888-888888888888"
const POST_ID = "99999999-9999-9999-9999-999999999999"

function seedData(): SeedData {
  const user = {
    id: USER_ID,
    displayName: "Demo",
    handle: "demo",
    email: "demo@demo.example",
    bio: null,
    locale: "en",
    createdAt: new Date("2026-03-01T12:00:00Z"),
    showVolunteerHours: null,
    allowDirectMessages: true,
    instagram: null,
    followerCount: 0,
    followingCount: 0,
  }
  const hood = { name: "Echo Park" }
  return {
    now: NOW,
    users: [user],
    follows: [],
    events: [
      {
        id: EVENT_ID,
        organizer: user,
        cohost: null,
        title: "Park cleanup",
        description: "Bring gloves",
        lat: 34.07,
        lng: -118.26,
        address: "Echo Park Lake",
        scheduledAt: new Date("2026-10-03T16:00:00Z"),
        endsAt: new Date("2026-10-03T19:00:00Z"),
        createdAt: new Date("2026-09-10T12:00:00Z"),
        status: "upcoming",
        bring: [],
        capacity: null,
        bags: 0,
        members: [{ user, role: "organizer", joinedAt: new Date("2026-09-10T12:00:00Z") }],
        slots: [],
        claims: [],
        hood,
      },
    ],
    reports: [
      {
        id: REPORT_ID,
        reporter: user,
        type: "graffiti",
        title: "Tag on the wall",
        description: "Fresh tag",
        addr: "1 Main St",
        lat: 34.08,
        lng: -118.27,
        status: "published",
        createdAt: new Date("2026-09-12T12:00:00Z"),
        publishedAt: new Date("2026-09-12T12:00:00Z"),
        geomSource: "device",
        timeline: [],
        hood,
      },
    ],
    posts: [
      {
        id: POST_ID,
        author: user,
        kind: "post",
        body: "Look at this",
        replyTo: null,
        threadRoot: null,
        repostOf: null,
        eventId: null,
        reportId: REPORT_ID,
        createdAt: new Date("2026-09-12T13:00:00Z"),
        depth: 0,
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        saveCount: 0,
        mentions: [],
      },
    ],
    likes: [],
    saves: [],
    hours: [],
    hashFor: (seatId: string) => `hash:${seatId}`,
  } as unknown as SeedData
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

describe("seed-demo-la writes rows the way the live paths do", () => {
  it("adds registrations, post geometry, user activity and address provenance", async () => {
    const fake = makeFakeSql([
      { match: /INSERT INTO reference_counters/, rows: [{ next_val: 1 }] },
      { match: /INSERT INTO cleanup_registrations/, rows: [{ id: "registration-1" }] },
    ])
    const tx = Object.assign(fake.sql, { unsafe: () => Promise.resolve([]) })
    await writeAll(tx as unknown as TransactionSql, seedData())
    const statements = fake.statements.map((s) => ({ sql: flat(s.sql), values: s.values }))

    const registration = statements.find((s) =>
      s.sql.startsWith("INSERT INTO cleanup_registrations"),
    )
    expect(registration?.values).toContain(USER_ID)
    expect(statements.some((s) => s.sql.startsWith("INSERT INTO cleanup_registration_seats"))).toBe(
      true,
    )

    const postGeom = statements.find((s) => s.sql.startsWith("UPDATE posts p SET geom = COALESCE"))
    expect(postGeom).toBeDefined()

    const activity = statements.filter((s) => s.sql.includes("SET last_activity_geom"))
    expect(activity.length).toBeGreaterThanOrEqual(2)

    const report = statements.find((s) => s.sql.startsWith("INSERT INTO reports"))
    expect(report?.sql).toContain("addr_source")
    expect(report?.values).toContain("user")
    const event = statements.find((s) => s.sql.startsWith("INSERT INTO cleanups"))
    expect(event?.sql).toContain("address_source")
    expect(event?.values).toContain("manual")
  })

  it("mints no seat for a member of an event that has already ended", async () => {
    const data = seedData()
    const [event] = data.events
    event!.scheduledAt = new Date("2026-08-01T16:00:00Z")
    event!.endsAt = new Date("2026-08-01T19:00:00Z")
    event!.status = "done"
    const fake = makeFakeSql([{ match: /INSERT INTO reference_counters/, rows: [{ next_val: 1 }] }])
    const tx = Object.assign(fake.sql, { unsafe: () => Promise.resolve([]) })
    await writeAll(tx as unknown as TransactionSql, data)
    expect(fake.statements.some((s) => /INSERT INTO cleanup_registrations/.test(s.sql))).toBe(false)
  })
})
