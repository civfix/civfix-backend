import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import {
  FEED_IN_NETWORK_POOL,
  FEED_NEARBY_POOL,
  FEED_RECENT_POOL,
  makeDrizzlePostRepository,
  nearbyRadiusDegrees,
} from "../../src/services/post-repository.drizzle.js"
import type { FeedCandidateArgs } from "../../src/services/post-repository.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"

const ARGS: FeedCandidateArgs = {
  viewerId: VIEWER,
  filter: "all",
  fallbackLat: 34.0522,
  fallbackLng: -118.2437,
  windowDays: 30,
  radiusKm: 40,
  candidateCap: 400,
}

async function emitted(over: Partial<FeedCandidateArgs> = {}) {
  const fake = makeFakeSql()
  const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
    presignMedia: () => Promise.resolve({ url: "u" }),
    presignAvatar: () => Promise.resolve("a"),
  })
  await repo.feedCandidates({ ...ARGS, ...over })
  expect(fake.statements, "feedCandidates must be exactly ONE statement (no N+1)").toHaveLength(1)
  return fake.statements[0]!
}

describe("feed candidate SQL: one bounded statement", () => {
  it("issues exactly one statement per feed request", async () => {
    await emitted()
  })

  it("parameterizes every value (no interpolated literals)", async () => {
    const stmt = await emitted()
    expect(stmt.values).toContain(VIEWER)
    expect(stmt.values).toContain(34.0522)
    expect(stmt.values).toContain(-118.2437)
    expect(stmt.sql).not.toContain(VIEWER)
  })

  it("bounds all three pools and the final result", async () => {
    const stmt = await emitted()
    expect(stmt.values).toContain(FEED_IN_NETWORK_POOL)
    expect(stmt.values).toContain(FEED_NEARBY_POOL)
    expect(stmt.values).toContain(FEED_RECENT_POOL)
    expect(stmt.values).toContain(400)
    const limits = stmt.sql.match(/LIMIT/g) ?? []
    expect(limits.length).toBeGreaterThanOrEqual(5)
  })

  it("bounds the scan by the candidate window, never the whole table", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toContain("eligible_window")
    expect(stmt.sql).toMatch(/created_at >= \(SELECT since FROM eligible_window\)/)
    expect(stmt.values).toContain(30)
  })
})

describe("feed candidate SQL: security invariants", () => {
  it("excludes non-public and soft-deleted posts in every pool", async () => {
    const stmt = await emitted()
    const visibility = stmt.sql.match(/p\.visibility = 'public'/g) ?? []
    const deleted = stmt.sql.match(/p\.deleted_at IS NULL/g) ?? []
    expect(visibility.length).toBeGreaterThanOrEqual(3)
    expect(deleted.length).toBeGreaterThanOrEqual(3)
  })

  it("excludes replies from the timeline in every pool", async () => {
    const stmt = await emitted()
    const replies = stmt.sql.match(/p\.reply_to_id IS NULL/g) ?? []
    expect(replies.length).toBeGreaterThanOrEqual(3)
  })

  it("applies the block exclusion symmetrically, inside every pool", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toContain("FROM user_blocks b")
    expect(stmt.sql).toMatch(/b\.blocker_id = \? AND b\.blocked_id = p\.author_id/)
    expect(stmt.sql).toMatch(/b\.blocker_id = p\.author_id AND b\.blocked_id = \?/)
    expect(stmt.sql.match(/FROM user_blocks b/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it("cuts the candidate pool deterministically, in-network first", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toMatch(/ORDER BY pool\.source, p\.created_at DESC, p\.id DESC/)
    expect(stmt.sql).toContain("DISTINCT ON (id)")
  })

  it("never counts a suspended or deleted organization as verified", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toMatch(/po\.deleted_at IS NULL AND po\.suspended_at IS NULL/)
    expect(stmt.sql).toContain("o.deleted_at IS NULL")
    expect(stmt.sql).toContain("o.suspended_at IS NULL")
    expect(stmt.sql).toContain("au.deleted_at IS NULL")
  })

  it("reproduces the affiliation.ts primary-org ordering exactly", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toMatch(
      /ORDER BY COALESCE\(o\.id = au\.primary_organization_id, false\) DESC, m\.joined_at ASC, o\.id ASC/,
    )
  })

  it("counts only media that will actually render", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toMatch(/ma\.status = 'ready' AND ma\.served_key IS NOT NULL/)
  })

  it("reuses the canonical ongoing-event predicate and never yields SQL NULL", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toMatch(
      /COALESCE\(ev\.status <> 'cancelled' AND ev\.ends_at > now\(\), false\) AS has_live_event/,
    )
  })
})

describe("feed candidate SQL: nearby pool uses the GIST index", () => {
  it("is a CROSS JOIN LATERAL with a KNN order, so the LIMIT stops the scan", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toContain("CROSS JOIN LATERAL")
    expect(stmt.sql).toMatch(/ORDER BY p\.geom <-> vp\.geom/)
    expect(stmt.sql).toContain("ST_DWithin(p.geom, vp.geom")
  })

  it("passes a degree radius padded for longitude convergence", async () => {
    const stmt = await emitted()
    expect(stmt.values).toContain(nearbyRadiusDegrees(40))
    expect(nearbyRadiusDegrees(40)).toBeGreaterThan(40 / 111.32)
  })

  it("falls back to the caller's approximate point when the viewer has no history", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toContain("viewer_point")
    expect(stmt.sql).toMatch(/COALESCE\(\s*\(SELECT geom FROM viewer_point\)/)
    expect(stmt.sql).toContain("ST_SetSRID")
  })

  it("casts the fallback coordinates so a NULL point is typed, not an error", async () => {
    const stmt = await emitted({ fallbackLat: null, fallbackLng: null })
    expect(stmt.sql).toContain("::double precision")
    expect(stmt.values).toContain(null)
  })

  it("returns a NULL distance for a post with no geometry", async () => {
    const stmt = await emitted()
    expect(stmt.sql).toMatch(/CASE WHEN p\.geom IS NULL THEN NULL/)
  })
})

describe("feed candidate SQL: filter tab", () => {
  it("adds no filter clause for the all tab", async () => {
    const stmt = await emitted({ filter: "all" })
    expect(stmt.sql).not.toContain("p.event_id IS NOT NULL\n")
    expect(stmt.sql).not.toContain("fr.status = 'resolved'")
  })

  it("narrows the pools themselves for the events tab", async () => {
    const stmt = await emitted({ filter: "events" })
    const clauses = stmt.sql.match(/AND p\.event_id IS NOT NULL/g) ?? []
    expect(clauses.length).toBeGreaterThanOrEqual(3)
  })

  it("narrows the pools themselves for the fixes tab", async () => {
    const stmt = await emitted({ filter: "fixes" })
    const clauses = stmt.sql.match(/fr\.status = 'resolved'/g) ?? []
    expect(clauses.length).toBeGreaterThanOrEqual(3)
  })
})
