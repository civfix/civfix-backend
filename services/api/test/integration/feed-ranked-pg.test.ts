
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING } from "@civfix/shared"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeFeedPresence } from "../../src/services/feed-presence.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  explainFeedCandidates,
  makeDrizzlePostRepository,
  FEED_NEARBY_INDEX,
  type FeedCandidateArgs,
  type PostRepository,
} from "../../src/services/post-repository.drizzle.js"
import { makePostService, type PostService } from "../../src/services/post-service.js"

const pg = await withPg()

const echoPresign = (r2Key: string, thumbKey: string | null) =>
  Promise.resolve(
    thumbKey === null ? { url: `m://${r2Key}` } : { url: `m://${r2Key}`, thumbUrl: `m://${thumbKey}` },
  )
const echoAvatar = (k: string) => Promise.resolve(`m://${k}`)

const LA = { lat: 34.0522, lng: -118.2437 }

describe.skipIf(!pg)("ranked home feed: candidate SQL (integration)", () => {
  let h: PgHarness

  function makeRepo(): PostRepository {
    return makeDrizzlePostRepository(h.sql, {
      presignMedia: echoPresign,
      presignAvatar: echoAvatar,
    })
  }

  function makeService(repo: PostRepository = makeRepo()): PostService {
    return makePostService({
      repo,
      sql: h.sql,
      feedRanking: DEFAULT_FEED_RANKING,
      feedPresence: makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: DEFAULT_FEED_RANKING,
      }),
    })
  }

  function args(over: Partial<FeedCandidateArgs> = {}): FeedCandidateArgs {
    return {
      viewerId: "00000000-0000-0000-0000-000000000000",
      filter: "all",
      fallbackLat: LA.lat,
      fallbackLng: LA.lng,
      windowDays: DEFAULT_FEED_RANKING.candidateWindowDays,
      radiusKm: DEFAULT_FEED_RANKING.nearbyRadiusKm,
      candidateCap: DEFAULT_FEED_RANKING.candidateCap,
      ...over,
    }
  }

  beforeAll(() => {
    h = pg as PgHarness
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

  async function follow(follower: string, followee: string): Promise<void> {
    await h.sql`
      INSERT INTO follows_people (follower_id, followee_id) VALUES (${follower}, ${followee})
      ON CONFLICT DO NOTHING
    `
  }

  async function block(blocker: string, blocked: string): Promise<void> {
    await h.sql`
      INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${blocker}, ${blocked})
      ON CONFLICT DO NOTHING
    `
  }

  async function setGeom(postId: string, lat: number, lng: number): Promise<void> {
    await h.sql`
      UPDATE posts SET geom = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) WHERE id = ${postId}
    `
  }

  it("returns the in-network pool for a viewer who follows someone", async () => {
    const viewer = await newUser("Net Viewer")
    const followee = await newUser("Net Followee")
    await follow(viewer, followee)
    const svc = makeService()
    const post = await svc.createPost(
      { kind: "post", body: "in network", mediaUploadIds: [], mentionedUserIds: [] },
      followee,
    )

    const rows = await makeRepo().feedCandidates(args({ viewerId: viewer }))
    const row = rows.find((r) => r.id === post.id)
    expect(row).toBeDefined()
    expect(row!.author_followed).toBe(true)
    expect(row!.author_is_viewer).toBe(false)
  })

  it("marks the viewer's own post and excludes replies from the pool", async () => {
    const viewer = await newUser("Self Viewer")
    const svc = makeService()
    const post = await svc.createPost(
      { kind: "post", body: "mine", mediaUploadIds: [], mentionedUserIds: [] },
      viewer,
    )
    const reply = await svc.createPost(
      { kind: "post", body: "a reply", replyToId: post.id, mediaUploadIds: [], mentionedUserIds: [] },
      viewer,
    )

    const rows = await makeRepo().feedCandidates(args({ viewerId: viewer }))
    expect(rows.find((r) => r.id === post.id)!.author_is_viewer).toBe(true)
    expect(rows.find((r) => r.id === reply.id)).toBeUndefined()
  })

  it("excludes a blocked pair in BOTH directions", async () => {
    const viewer = await newUser("Block Viewer")
    const other = await newUser("Block Other")
    const svc = makeService()
    const theirPost = await svc.createPost(
      { kind: "post", body: "theirs", mediaUploadIds: [], mentionedUserIds: [] },
      other,
    )

    await block(viewer, other)
    let rows = await makeRepo().feedCandidates(args({ viewerId: viewer }))
    expect(rows.find((r) => r.id === theirPost.id)).toBeUndefined()

    await h.sql`DELETE FROM user_blocks WHERE blocker_id = ${viewer} AND blocked_id = ${other}`
    await block(other, viewer)
    rows = await makeRepo().feedCandidates(args({ viewerId: viewer }))
    expect(rows.find((r) => r.id === theirPost.id)).toBeUndefined()
  })

  it("excludes a soft-deleted post and a non-public one", async () => {
    const viewer = await newUser("Vis Viewer")
    const author = await newUser("Vis Author")
    const svc = makeService()
    const deleted = await svc.createPost(
      { kind: "post", body: "gone", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const hidden = await svc.createPost(
      { kind: "post", body: "hidden", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await svc.deletePost(deleted.id, author)
    await h.sql`UPDATE posts SET visibility = 'hidden' WHERE id = ${hidden.id}`

    const rows = await makeRepo().feedCandidates(args({ viewerId: viewer }))
    expect(rows.find((r) => r.id === deleted.id)).toBeUndefined()
    expect(rows.find((r) => r.id === hidden.id)).toBeUndefined()
  })

  it("computes distance_km against the viewer point and NULL without geometry", async () => {
    const viewer = await newUser("Geo Viewer")
    const author = await newUser("Geo Author")
    const svc = makeService()
    const near = await svc.createPost(
      { kind: "post", body: "near", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const nowhere = await svc.createPost(
      { kind: "post", body: "nowhere", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await setGeom(near.id, LA.lat + 0.05, LA.lng)

    const rows = await makeRepo().feedCandidates(args({ viewerId: viewer }))
    const nearRow = rows.find((r) => r.id === near.id)!
    expect(Number(nearRow.distance_km)).toBeGreaterThan(4)
    expect(Number(nearRow.distance_km)).toBeLessThan(7)
    expect(rows.find((r) => r.id === nowhere.id)!.distance_km).toBeNull()
  })

  it("leaves distance NULL for every post when the caller has no location at all", async () => {
    const viewer = await newUser("NoGeo Viewer")
    const author = await newUser("NoGeo Author")
    const svc = makeService()
    const post = await svc.createPost(
      { kind: "post", body: "somewhere", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await setGeom(post.id, LA.lat, LA.lng)

    const rows = await makeRepo().feedCandidates(
      args({ viewerId: viewer, fallbackLat: null, fallbackLng: null }),
    )
    expect(rows.find((r) => r.id === post.id)!.distance_km).toBeNull()
  })

  it("denormalises geom from the linked report at insert time", async () => {
    const author = await newUser("Report Author")
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (reporter_user_id, category, type, description, geom, geom_source, status, visibility)
      VALUES (
        ${author}, 'graffiti', 'graffiti', 'tag',
        ST_SetSRID(ST_MakePoint(${LA.lng}, ${LA.lat}), 4326), 'manual', 'published', 'public'
      )
      RETURNING id
    `
    const svc = makeService()
    const post = await svc.createPost(
      {
        kind: "post",
        body: "about this report",
        reportId: report!.id,
        mediaUploadIds: [],
        mentionedUserIds: [],
      },
      author,
    )

    const [row] = await h.sql<{ lat: number; lng: number }[]>`
      SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng FROM posts WHERE id = ${post.id}
    `
    expect(Number(row!.lat)).toBeCloseTo(LA.lat, 5)
    expect(Number(row!.lng)).toBeCloseTo(LA.lng, 5)
  })

  it("respects the candidate window, excluding an older post", async () => {
    const viewer = await newUser("Window Viewer")
    const author = await newUser("Window Author")
    const svc = makeService()
    const old = await svc.createPost(
      { kind: "post", body: "ancient", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await h.sql`UPDATE posts SET created_at = now() - interval '90 days' WHERE id = ${old.id}`

    const rows = await makeRepo().feedCandidates(args({ viewerId: viewer, windowDays: 30 }))
    expect(rows.find((r) => r.id === old.id)).toBeUndefined()
  })

  it("honours the candidate cap", async () => {
    const viewer = await newUser("Cap Viewer")
    const author = await newUser("Cap Author")
    const svc = makeService()
    for (let i = 0; i < 6; i += 1) {
      await svc.createPost(
        { kind: "post", body: `cap ${i}`, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      )
    }
    const rows = await makeRepo().feedCandidates(args({ viewerId: viewer, candidateCap: 3 }))
    expect(rows.length).toBeLessThanOrEqual(3)
  })

  async function explainWithIndexPlan(viewerId: string): Promise<string> {
    await h.sql`ANALYZE posts`
    await h.sql`ANALYZE follows_people`
    return h.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`
      await tx`SET LOCAL enable_bitmapscan = off`
      return explainFeedCandidates(tx, args({ viewerId }))
    })
  }

  it("has an index path available for the nearby pool, and never falls back to a posts seq scan", async () => {
    const viewer = await newUser("Explain Viewer")
    const plan = await explainWithIndexPlan(viewer)
    expect(plan, `${FEED_NEARBY_INDEX} missing from:\n${plan}`).toContain(FEED_NEARBY_INDEX)
    expect(plan, plan).not.toMatch(/Seq Scan on posts/)
  })

  it("pages the ranked feed over every seeded post exactly once", async () => {
    const viewer = await newUser("Page Viewer")
    const author = await newUser("Page Author")
    await follow(viewer, author)
    const svc = makeService()
    const created: string[] = []
    for (let i = 0; i < 25; i += 1) {
      const post = await svc.createPost(
        { kind: "post", body: `page ${i}`, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      )
      created.push(post.id)
    }

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 6; page += 1) {
      const result = await svc.homeFeed(
        viewer,
        { filter: "all", limit: 10, ...(cursor === undefined ? {} : { cursor }) },
        LA,
      )
      seen.push(...result.items.map((item) => item.id))
      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }

    const mine = seen.filter((id) => created.includes(id))
    expect(new Set(mine).size).toBe(mine.length)
    expect(new Set(mine).size).toBe(created.length)
  })

  it("serves a legacy ISO cursor through the untouched chronological query", async () => {
    const viewer = await newUser("Legacy Viewer")
    const author = await newUser("Legacy Author")
    await follow(viewer, author)
    const svc = makeService()
    for (let i = 0; i < 3; i += 1) {
      await svc.createPost(
        { kind: "post", body: `legacy ${i}`, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      )
    }

    const legacyCursor = `${new Date().toISOString()}|ffffffff-ffff-ffff-ffff-ffffffffffff`
    const page = await svc.homeFeed(viewer, { filter: "all", limit: 10, cursor: legacyCursor }, LA)
    expect(page.items.length).toBeGreaterThan(0)
  })

  it("returns counts only for posts the caller may read", async () => {
    const viewer = await newUser("Counts Viewer")
    const author = await newUser("Counts Author")
    const blocker = await newUser("Counts Blocker")
    const svc = makeService()
    const readable = await svc.createPost(
      { kind: "post", body: "readable", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const blocked = await svc.createPost(
      { kind: "post", body: "blocked", mediaUploadIds: [], mentionedUserIds: [] },
      blocker,
    )
    const hidden = await svc.createPost(
      { kind: "post", body: "hidden", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await h.sql`UPDATE posts SET visibility = 'hidden' WHERE id = ${hidden.id}`
    await block(blocker, viewer)
    await svc.likePost(readable.id, viewer)

    const result = await svc.getFeedCounts([readable.id, blocked.id, hidden.id], viewer)
    expect(result.items.map((item) => item.id)).toEqual([readable.id])
    expect(result.items[0]!.counts.likes).toBe(1)
  })
})
