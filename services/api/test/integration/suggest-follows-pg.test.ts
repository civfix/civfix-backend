import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  explainSuggestFollows,
  makeDrizzleSocialRepository,
  SUGGEST_KNN_INDEX,
  SUGGEST_RECENCY_INDEX,
} from "../../src/services/social-repository.drizzle.js"
import { backfillUserActivity } from "../../src/db/backfill-user-activity-core.js"
import { touchUserActivity } from "../../src/db/sql/user-activity.js"
import type { SocialRepository } from "../../src/services/social-service.js"

const pg = await withPg()

const LA = { lat: 34.05, lng: -118.24 }
const NY = { lat: 40.71, lng: -74.0 }

describe.skipIf(!pg)("H18: follow suggestions are bounded before ranking", () => {
  let h: PgHarness
  let repo: SocialRepository

  beforeAll(async () => {
    h = pg as PgHarness
    repo = makeDrizzleSocialRepository(h.sql)
    await h.sql`
      CREATE INDEX IF NOT EXISTS users_last_activity_gist
        ON users USING gist (last_activity_geom)
        WHERE last_activity_geom IS NOT NULL AND deleted_at IS NULL
    `
    await h.sql`
      CREATE INDEX IF NOT EXISTS users_last_activity_at_idx
        ON users (last_activity_at DESC)
        WHERE last_activity_at IS NOT NULL AND deleted_at IS NULL
    `
  })

  beforeEach(async () => {
    await h.sql`DELETE FROM follows_people`
    await h.sql`UPDATE users SET last_activity_geom = NULL, last_activity_at = NULL`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  const NEWEST_POOL_INDEX = "users_created_id_idx"

  async function explainWithIndexPlan(viewerId: string): Promise<string> {
    await h.sql`ANALYZE users`
    await h.sql`ANALYZE cleanups`
    return h.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`
      await tx`SET LOCAL enable_bitmapscan = off`
      return explainSuggestFollows(tx, { viewerId, limit: 10 })
    })
  }

  const CHILD_NODE_LINE = /^\s*->/

  function nodeDetail(lines: string[], nodeAt: number): string {
    const nodeIndent = (lines[nodeAt] ?? "").search(/\S/)
    const detail: string[] = []
    for (let i = nodeAt + 1; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (line.trim() === "") break
      if (CHILD_NODE_LINE.test(line) || line.search(/\S/) <= nodeIndent) break
      detail.push(line)
    }
    return detail.join("\n")
  }

  it("plans the REAL statement's nearby pool as a KNN index scan with an Order By on the GiST index", async () => {
    const viewer = await newUser("Viewer")
    await touchUserActivity(h.sql, { userId: viewer, ...LA, at: new Date("2026-08-01T00:00:00Z") })
    await seedOrganizedEvent(viewer, LA)

    const text = await explainWithIndexPlan(viewer)

    const lines = text.split("\n")
    const knnScan = lines.findIndex((line) =>
      line.includes(`Index Scan using ${SUGGEST_KNN_INDEX}`),
    )
    expect(knnScan, `no Index Scan using ${SUGGEST_KNN_INDEX} in:\n${text}`).toBeGreaterThan(-1)
    expect(nodeDetail(lines, knnScan), `KNN scan without an Order By in:\n${text}`).toContain(
      "Order By:",
    )
    expect(nodeDetail(lines, knnScan)).toContain("last_activity_geom <->")
  })

  it("plans the recency fallback pool of the REAL statement on the recency index", async () => {
    const viewer = await newUser("Viewer")
    const text = await explainWithIndexPlan(viewer)
    expect(text, text).toContain(SUGGEST_RECENCY_INDEX)
  })

  it("has an index path available for all three pools", async () => {
    const viewer = await newUser("Viewer")
    await touchUserActivity(h.sql, { userId: viewer, ...LA, at: new Date("2026-08-01T00:00:00Z") })
    await seedOrganizedEvent(viewer, LA)
    const text = await explainWithIndexPlan(viewer)
    for (const index of [SUGGEST_KNN_INDEX, SUGGEST_RECENCY_INDEX, NEWEST_POOL_INDEX]) {
      expect(text, `${index} missing from:\n${text}`).toContain(index)
    }
  })

  it("ranks a nearby activity point ahead of a far one, from the materialized column alone", async () => {
    const viewer = await newUser("Viewer")
    const near = await newUser("Near")
    const far = await newUser("Far")
    const at = new Date("2026-08-01T00:00:00Z")
    await touchUserActivity(h.sql, { userId: viewer, ...LA, at })
    await touchUserActivity(h.sql, { userId: near, lat: LA.lat + 0.05, lng: LA.lng + 0.05, at })
    await touchUserActivity(h.sql, { userId: far, ...NY, at })

    await seedOrganizedEvent(viewer, LA)

    const results = await repo.suggestFollows({ viewerId: viewer, limit: 10 })
    const ids = results.map((r) => r.id)
    expect(ids).toContain(near)
    expect(ids).toContain(far)
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far))
    expect(ids).not.toContain(viewer)
  })

  it("returns a bounded page for a viewer with no location at all", async () => {
    const viewer = await newUser("Rootless")
    for (let i = 0; i < 25; i++) await newUser(`Person ${i}`)
    const results = await repo.suggestFollows({ viewerId: viewer, limit: 10 })
    const ids = results.map((r) => r.id)
    expect(ids).toHaveLength(10)
    expect(new Set(ids).size).toBe(10)
    expect(ids).not.toContain(viewer)
  })

  it("backfills the pair from existing events and never moves it backwards on a re-run", async () => {
    const organizer = await newUser("Organizer")
    const created = await seedOrganizedEvent(organizer, LA)

    const first = await backfillUserActivity(h.sql, { batchSize: 5, log: () => undefined })
    expect(first.filled).toBeGreaterThanOrEqual(1)
    const [row] = await h.sql<{ at: Date | null; lng: number | null }[]>`
      SELECT last_activity_at AS at, ST_X(last_activity_geom) AS lng
      FROM users WHERE id = ${organizer}
    `
    expect(row!.at?.toISOString()).toBe(created.toISOString())
    expect(row!.lng).toBeCloseTo(LA.lng, 5)

    const newer = new Date(created.getTime() + 60_000)
    await touchUserActivity(h.sql, { userId: organizer, ...NY, at: newer })
    const second = await backfillUserActivity(h.sql, { batchSize: 5, log: () => undefined })
    expect(second.scanned).toBeGreaterThan(0)
    const [after] = await h.sql<{ at: Date | null; lng: number | null }[]>`
      SELECT last_activity_at AS at, ST_X(last_activity_geom) AS lng
      FROM users WHERE id = ${organizer}
    `
    expect(after!.at?.toISOString()).toBe(newer.toISOString())
    expect(after!.lng).toBeCloseTo(NY.lng, 5)
  })

  async function seedOrganizedEvent(
    organizerId: string,
    at: { lat: number; lng: number },
  ): Promise<Date> {
    const id = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Sweep",
      lng: at.lng,
      lat: at.lat,
    })
    const [row] = await h.sql<{ created_at: Date }[]>`
      SELECT created_at FROM cleanups WHERE id = ${id}
    `
    return row!.created_at
  }
})
