/**
 * HTTP-layer tests for the 13 social-feed post routes (routes-core test gap: posts.routes.ts had NO
 * route-level coverage — route-coverage.test.ts only asserts the endpoints are REGISTERED, and
 * post-service.test.ts calls the service directly, so nothing exercised auth, CSRF, `:id`/query
 * validation, the status codes or the serialized DTO).
 *
 * Everything runs through the real Fastify stack (`app.inject`) with a real `makePostService` over an
 * in-memory PostRepository, so the route -> service -> repo path is genuine; only the SQL is replaced.
 *
 * SEAM: posts.routes.ts reads `container.getPostService()` and has no `app.*Overrides` hook, so the
 * container getter IS the injection point — the harness swaps that one method on the container it passes
 * to buildServer. `sql` is a throwing stub: `resolveMentionTargets` short-circuits on an empty
 * `mentionedUserIds`, so every path here provably needs no database.
 */

import { describe, it, expect, afterEach } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import type { PersonDTO, PostDTO } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { Sql } from "../../src/db/client.js"
import { paginate, parseTimeCursor } from "../../src/db/cursor-helpers.js"
import { makePostService } from "../../src/services/post-service.js"
import type {
  CreatePostArgs,
  FeedPage,
  PostBrief,
  PostListArgs,
  PostRepository,
} from "../../src/services/post-repository.drizzle.js"

const throwingSql = (() => {
  throw new Error("posts-routes.test: no SQL may be issued on these paths")
}) as unknown as Sql

// ---------------------------------------------------------------------------
// In-memory PostRepository (a behavioral fake, not a stub: counts and viewer
// flags are derived from stored state so the serialized DTO is meaningful)
// ---------------------------------------------------------------------------

interface StoredPost {
  id: string
  authorId: string
  kind: "post" | "quote" | "reply" | "repost"
  body: string | null
  replyToId: string | null
  repostOfId: string | null
  eventId: string | null
  reportId: string | null
  mentionedUserIds: string[]
  createdAt: Date
  deletedAt: Date | null
  likes: Set<string>
  reposts: Set<string>
  saves: Set<string>
}

class InMemoryPostRepository implements PostRepository {
  readonly posts = new Map<string, StoredPost>()
  readonly names = new Map<string, string>()
  /** `${eventId}:${userId}` pairs the author may attach. */
  readonly eventMembers = new Set<string>()
  readonly attachableReports = new Set<string>()
  private seq = 0

  /** Insert a post directly (seeding), returning its id. */
  seed(post: Partial<StoredPost> & { authorId: string }): string {
    const id = post.id ?? randomUUID()
    this.seq += 1
    this.posts.set(id, {
      id,
      authorId: post.authorId,
      kind: post.kind ?? "post",
      // An OMITTED body gets the seeding default; an EXPLICIT null stays null, so an attachment-only
      // post (and a bodyless repost) round-trips faithfully.
      body: "body" in post ? (post.body ?? null) : "seeded",
      replyToId: post.replyToId ?? null,
      repostOfId: post.repostOfId ?? null,
      eventId: post.eventId ?? null,
      reportId: post.reportId ?? null,
      mentionedUserIds: post.mentionedUserIds ?? [],
      createdAt: post.createdAt ?? new Date(Date.UTC(2026, 6, 24, 0, 0, this.seq)),
      deletedAt: post.deletedAt ?? null,
      likes: post.likes ?? new Set(),
      reposts: post.reposts ?? new Set(),
      saves: post.saves ?? new Set(),
    })
    return id
  }

  private live(id: string): StoredPost | null {
    const p = this.posts.get(id)
    return p && p.deletedAt === null ? p : null
  }

  private replyCount(id: string): number {
    let n = 0
    for (const p of this.posts.values()) {
      if (p.replyToId === id && p.deletedAt === null) n += 1
    }
    return n
  }

  private person(userId: string): PersonDTO {
    return {
      id: userId,
      name: this.names.get(userId) ?? "Someone",
      handle: (this.names.get(userId) ?? "someone").toLowerCase().replace(/\W/g, "_"),
      bio: null,
      avatar: ["#101010", "#202020"],
      followers: 0,
      following: 0,
      isFollowing: false,
    }
  }

  private dto(post: StoredPost, viewerId: string): PostDTO {
    return {
      id: post.id,
      author: this.person(post.authorId),
      kind: post.kind === "repost" ? "post" : post.kind,
      body: post.body,
      createdAt: post.createdAt.toISOString(),
      editedAt: null,
      counts: {
        likes: post.likes.size,
        reposts: post.reposts.size,
        replies: this.replyCount(post.id),
        saves: post.saves.size,
      },
      viewer: {
        liked: post.likes.has(viewerId),
        reposted: post.reposts.has(viewerId),
        saved: post.saves.has(viewerId),
      },
      media: [],
      mentions: [],
      event: null,
      report: null,
      repostOf: null,
      replyToId: post.replyToId,
      threadRootId: post.replyToId,
    }
  }

  /** Newest-first keyset page over the canonical cursor helpers (the real repo's contract). */
  private page(rows: StoredPost[], viewerId: string, args: { cursor: string | null; limit: number }): FeedPage {
    const sorted = [...rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
    )
    const anchor = parseTimeCursor(args.cursor)
    const after =
      anchor === null
        ? sorted
        : sorted.filter(
            (p) =>
              p.createdAt.getTime() < anchor.at.getTime() ||
              (p.createdAt.getTime() === anchor.at.getTime() && p.id < anchor.id),
          )
    const paged = paginate(after.slice(0, args.limit + 1), args.limit, (p) => ({
      createdAt: p.createdAt,
      id: p.id,
    }))
    return { items: paged.items.map((p) => this.dto(p, viewerId)), nextCursor: paged.nextCursor }
  }

  getPostBrief(id: string): Promise<PostBrief | null> {
    const p = this.posts.get(id)
    if (!p) return Promise.resolve(null)
    return Promise.resolve({
      id: p.id,
      authorId: p.authorId,
      kind: p.kind,
      replyToId: p.replyToId,
      repostOfId: p.repostOfId,
      deletedAt: p.deletedAt,
    })
  }

  actorNameOf(userId: string): Promise<string> {
    return Promise.resolve(this.names.get(userId) ?? "Someone")
  }

  isEventMember(eventId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.eventMembers.has(`${eventId}:${userId}`))
  }

  isReportAttachable(reportId: string): Promise<boolean> {
    return Promise.resolve(this.attachableReports.has(reportId))
  }

  createPost(args: CreatePostArgs): Promise<string> {
    return Promise.resolve(
      this.seed({
        authorId: args.authorId,
        kind: args.kind,
        body: args.body,
        replyToId: args.replyToId,
        repostOfId: args.repostOfId,
        eventId: args.eventId,
        reportId: args.reportId,
        mentionedUserIds: args.mentionedUserIds,
      }),
    )
  }

  softDeletePost(postId: string): Promise<void> {
    const p = this.posts.get(postId)
    if (p) p.deletedAt = new Date()
    return Promise.resolve()
  }

  like(postId: string, userId: string): Promise<boolean> {
    const p = this.live(postId)
    if (!p || p.likes.has(userId)) return Promise.resolve(false)
    p.likes.add(userId)
    return Promise.resolve(true)
  }

  unlike(postId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.live(postId)?.likes.delete(userId) ?? false)
  }

  save(postId: string, userId: string): Promise<boolean> {
    const p = this.live(postId)
    if (!p || p.saves.has(userId)) return Promise.resolve(false)
    p.saves.add(userId)
    return Promise.resolve(true)
  }

  unsave(postId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.live(postId)?.saves.delete(userId) ?? false)
  }

  /** Walks a pure-repost chain to the ORIGINAL, exactly as the SQL does. */
  private targetOf(postId: string): string {
    const p = this.posts.get(postId)
    return p && p.kind === "repost" && p.repostOfId !== null ? p.repostOfId : postId
  }

  repost(postId: string, userId: string): Promise<{ targetId: string; created: boolean }> {
    const targetId = this.targetOf(postId)
    const target = this.live(targetId)
    if (!target) return Promise.resolve({ targetId, created: false })
    const created = !target.reposts.has(userId)
    target.reposts.add(userId)
    return Promise.resolve({ targetId, created })
  }

  unrepost(postId: string, userId: string): Promise<{ targetId: string; removed: boolean }> {
    const targetId = this.targetOf(postId)
    return Promise.resolve({ targetId, removed: this.live(targetId)?.reposts.delete(userId) ?? false })
  }

  getPostDTO(id: string, viewerId: string): Promise<PostDTO | null> {
    const p = this.live(id)
    return Promise.resolve(p ? this.dto(p, viewerId) : null)
  }

  /**
   * The shared source for BOTH timeline feeds, so the reply exclusion below lands on each of them at
   * once — exactly as `AND p.reply_to_id IS NULL` does in the two SQL queries.
   */
  private byFilter(filter: "all" | "events" | "fixes"): StoredPost[] {
    return [...this.posts.values()].filter((p) => {
      if (p.deletedAt !== null) return false
      // Both byFilter feeds are TOP-LEVEL only, matching `reply_to_id IS NULL` in homeFeed + publicFeed.
      // A reply is thread content and belongs to listReplies, not the timeline. Note this fake had drifted
      // BOTH ways: publicFeed's SQL always carried the predicate and the fake never did, while homeFeed's
      // SQL was missing it entirely (the bug) — so the route suite was certifying a reply dump.
      if (p.replyToId !== null) return false
      if (filter === "events") return p.eventId !== null
      if (filter === "fixes") return p.reportId !== null
      return true
    })
  }

  homeFeed(args: { viewerId: string; filter: "all" | "events" | "fixes"; cursor: string | null; limit: number }): Promise<FeedPage> {
    return Promise.resolve(this.page(this.byFilter(args.filter), args.viewerId, args))
  }

  publicFeed(args: { filter: "all" | "events" | "fixes"; cursor: string | null; limit: number }): Promise<FeedPage> {
    // NIL viewer: every viewer flag must come back false for a signed-out reader.
    return Promise.resolve(this.page(this.byFilter(args.filter), "", args))
  }

  listReplies(postId: string, args: PostListArgs): Promise<FeedPage> {
    const rows = [...this.posts.values()].filter((p) => p.replyToId === postId && p.deletedAt === null)
    return Promise.resolve(this.page(rows, args.viewerId, args))
  }

  listUserPosts(authorId: string, args: PostListArgs): Promise<FeedPage> {
    // `kind !== "reply"`, matching the SQL's `AND p.kind <> 'reply'` — the profile "Posts" tab is the
    // Twitter Posts-vs-Replies split. The fake had omitted this, so the profile-tab test below could have
    // certified a reply the real query rejects.
    const rows = [...this.posts.values()].filter(
      (p) => p.authorId === authorId && p.deletedAt === null && p.kind !== "reply",
    )
    return Promise.resolve(this.page(rows, args.viewerId, args))
  }

  /** NO reply exclusion, matching the SQL: the viewer explicitly bookmarked that reply. */
  listSaves(args: PostListArgs): Promise<FeedPage> {
    const rows = [...this.posts.values()].filter(
      (p) => p.saves.has(args.viewerId) && p.deletedAt === null,
    )
    return Promise.resolve(this.page(rows, args.viewerId, args))
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A mobile (bearer) session: CSRF-exempt, used for everything except the CSRF suite. */
interface Session {
  userId: string
  token: string
}

/** A web (cookie) session plus its session-BOUND CSRF token. */
interface WebSession {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  app: FastifyInstance
  repo: InMemoryPostRepository
  /** Pairs blocked either way: `${a}:${b}`. */
  blocked: Set<string>
  /**
   * Sign in once per email. One sign-in per address is all the harness gets: `POST /auth/otp/request`
   * enforces a 60s per-email cooldown, so a second request for the same address returns no new code.
   */
  signIn(email: string, name: string): Promise<Session>
  signInWeb(email: string, name: string): Promise<WebSession>
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const repo = new InMemoryPostRepository()
  const blocked = new Set<string>()
  const service = makePostService({
    repo,
    sql: throwingSql,
    isBlockedEitherWay: (a, b) => Promise.resolve(blocked.has(`${a}:${b}`) || blocked.has(`${b}:${a}`)),
  })

  const container = buildContainer(env)
  // The only seam posts.routes.ts offers (see the file header).
  Object.assign(container, { getPostService: () => service } satisfies Partial<Container>)

  const app = await buildServer({ env, container, authServices })

  /** Run the OTP request/verify pair for `email` on the given transport. */
  async function verify(email: string, name: string, client: "mobile" | "web") {
    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email },
    })
    expect(requested.statusCode).toBe(200)
    const code = mailer.lastOtpFor(email)!
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": client },
      payload: { email, code },
    })
    expect(res.statusCode).toBe(200)
    const userId = res.json().user.id as string
    repo.names.set(userId, name)
    return { res, userId }
  }

  const h: Harness = {
    app,
    repo,
    blocked,
    async signIn(email: string, name: string) {
      const { res, userId } = await verify(email, name, "mobile")
      return { userId, token: res.json().token as string }
    },
    async signInWeb(email: string, name: string) {
      const { res, userId } = await verify(email, name, "web")
      const setCookie = res.headers["set-cookie"]
      const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
      const cookie = lines.find((l) => l.startsWith("civfix_session="))!.split(";")[0]!
      return { userId, cookie, csrfToken: res.json().csrfToken as string }
    },
  }
  current = h
  return h
}

/** Bearer headers (CSRF-exempt mobile transport). */
function bearer(s: Session): Record<string, string> {
  return { authorization: `Bearer ${s.token}`, "x-client": "mobile" }
}

const UNKNOWN_ID = "11111111-2222-4333-8444-555555555555"

/** Every route that mutates state, with a body where one is required. */
const MUTATIONS = (id: string): ReadonlyArray<{
  method: "POST" | "DELETE"
  url: string
  payload?: Record<string, unknown>
}> => [
  { method: "POST", url: "/v1/posts", payload: { kind: "post", body: "hi" } },
  { method: "DELETE", url: `/v1/posts/${id}` },
  { method: "POST", url: `/v1/posts/${id}/repost` },
  { method: "DELETE", url: `/v1/posts/${id}/repost` },
  { method: "POST", url: `/v1/posts/${id}/like` },
  { method: "DELETE", url: `/v1/posts/${id}/like` },
  { method: "POST", url: `/v1/posts/${id}/save` },
  { method: "DELETE", url: `/v1/posts/${id}/save` },
]

const READS = (id: string, authorId: string): ReadonlyArray<{ method: "GET"; url: string }> => [
  { method: "GET", url: `/v1/posts/${id}` },
  { method: "GET", url: `/v1/posts/${id}/replies` },
  { method: "GET", url: `/v1/people/${authorId}/posts` },
  { method: "GET", url: "/v1/me/saves" },
]

describe("posts routes: auth", () => {
  it("401s every auth-required post endpoint anonymously (12 of 13)", async () => {
    const h = await makeHarness()
    const id = h.repo.seed({ authorId: UNKNOWN_ID })
    for (const r of [...MUTATIONS(id), ...READS(id, UNKNOWN_ID)]) {
      const res = await h.app.inject({
        method: r.method,
        url: r.url,
        ...("payload" in r && r.payload ? { payload: r.payload } : {}),
      })
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401)
      expect(res.json().code, `${r.method} ${r.url}`).toBe("UNAUTHORIZED")
    }
  })

  it("serves GET /feed/home to a SIGNED-OUT reader (the one auth:optional endpoint)", async () => {
    const h = await makeHarness()
    const author = await h.signIn("author@example.com", "Author")
    const postId = h.repo.seed({ authorId: author.userId, body: "public" })
    // The author liked + saved their own post: a signed-out reader must still see all viewer flags false.
    h.repo.posts.get(postId)!.likes.add(author.userId)
    h.repo.posts.get(postId)!.saves.add(author.userId)

    const res = await h.app.inject({ method: "GET", url: "/v1/feed/home" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.map((p: PostDTO) => p.id)).toContain(postId)
    const dto = body.items.find((p: PostDTO) => p.id === postId)!
    expect(dto.viewer).toEqual({ liked: false, reposted: false, saved: false })
    expect(dto.counts.likes).toBe(1) // the counts are public; only the viewer flags are personal
    expect(body.nextCursor).toBeNull()
  })

  it("serves the VIEWER-SCOPED feed to a signed-in reader (flags reflect their own interactions)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("me@example.com", "Me")
    const postId = h.repo.seed({ authorId: me.userId, body: "mine" })
    h.repo.posts.get(postId)!.likes.add(me.userId)

    const res = await h.app.inject({ method: "GET", url: "/v1/feed/home", headers: bearer(me) })
    expect(res.statusCode).toBe(200)
    const dto = res.json().items.find((p: PostDTO) => p.id === postId)!
    expect(dto.viewer.liked).toBe(true)
  })
})

describe("posts routes: CSRF (cookie transport)", () => {
  it("403s EVERY mutation on a cookie session with no X-CSRF-Token", async () => {
    const h = await makeHarness()
    const me = await h.signInWeb("csrf@example.com", "Csrf")
    const id = h.repo.seed({ authorId: me.userId })
    for (const r of MUTATIONS(id)) {
      const res = await h.app.inject({
        method: r.method,
        url: r.url,
        headers: { cookie: me.cookie },
        ...(r.payload ? { payload: r.payload } : {}),
      })
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403)
      expect(res.json().message, `${r.method} ${r.url}`).toMatch(/CSRF/i)
    }
  })

  it("403s a mutation whose CSRF token belongs to a DIFFERENT session", async () => {
    const h = await makeHarness()
    const me = await h.signInWeb("a@example.com", "A")
    const other = await h.signInWeb("b@example.com", "B")
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { cookie: me.cookie, "x-csrf-token": other.csrfToken },
      payload: { kind: "post", body: "hi" },
    })
    expect(res.statusCode).toBe(403)
  })

  it("accepts the mutation once the session-bound token is echoed", async () => {
    const h = await makeHarness()
    const me = await h.signInWeb("ok@example.com", "Ok")
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { cookie: me.cookie, "x-csrf-token": me.csrfToken },
      payload: { kind: "post", body: "via cookies" },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().body).toBe("via cookies")
  })

  it("does NOT require CSRF on the read endpoints (a cookie GET works bare)", async () => {
    const h = await makeHarness()
    const me = await h.signInWeb("read@example.com", "Read")
    const id = h.repo.seed({ authorId: me.userId })
    for (const r of READS(id, me.userId)) {
      const res = await h.app.inject({ method: r.method, url: r.url, headers: { cookie: me.cookie } })
      expect(res.statusCode, r.url).toBe(200)
    }
  })
})

describe("POST /posts (createPost)", () => {
  it("201s with the serialized PostDTO", async () => {
    const h = await makeHarness()
    const me = await h.signIn("compose@example.com", "Alex Rivera")
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", body: "First post" },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto).toMatchObject({
      kind: "post",
      body: "First post",
      counts: { likes: 0, reposts: 0, replies: 0, saves: 0 },
      viewer: { liked: false, reposted: false, saved: false },
      author: { id: me.userId, name: "Alex Rivera" },
      replyToId: null,
      editedAt: null,
    })
    expect(typeof dto.id).toBe("string")
    expect(new Date(dto.createdAt).toString()).not.toBe("Invalid Date")
    // It really landed in the store.
    expect(h.repo.posts.get(dto.id)?.authorId).toBe(me.userId)
  })

  it("422s an unknown key (strict schema), an over-long body, and an empty post", async () => {
    const h = await makeHarness()
    const me = await h.signIn("bad@example.com", "Bad")
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown key", { kind: "post", body: "hi", bogus: true }],
      ["body > 2000", { kind: "post", body: "x".repeat(2001) }],
      ["no body/media/attachment", { kind: "post" }],
      ["non-uuid mention", { kind: "post", body: "hi", mentionedUserIds: ["nope"] }],
      ["reply without replyToId", { kind: "reply", body: "hi" }],
      ["non-uuid replyToId", { kind: "reply", body: "hi", replyToId: "nope" }],
    ]
    for (const [label, payload] of cases) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/posts",
        headers: bearer(me),
        payload,
      })
      expect(res.statusCode, label).toBe(422)
      expect(res.json().code, label).toBe("VALIDATION")
    }
    expect(h.repo.posts.size).toBe(0)
  })

  it("422s kind:'repost' — the toggle has its own route", async () => {
    const h = await makeHarness()
    const me = await h.signIn("rp@example.com", "Rp")
    const target = h.repo.seed({ authorId: me.userId })
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "repost", body: "x", repostOfId: target },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().fields.kind).toMatch(/repost/i)
  })

  it("403s attaching an event the author neither hosts nor attends, 201s once they are a member", async () => {
    const h = await makeHarness()
    const me = await h.signIn("ev@example.com", "Ev")
    const eventId = randomUUID()

    const denied = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", body: "come along", eventId },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe("FORBIDDEN")
    expect(h.repo.posts.size).toBe(0)

    h.repo.eventMembers.add(`${eventId}:${me.userId}`)
    const allowed = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", body: "come along", eventId },
    })
    expect(allowed.statusCode).toBe(201)
  })

  it("404s attaching a report that is not publicly attachable", async () => {
    const h = await makeHarness()
    const me = await h.signIn("rep@example.com", "Rep")
    const reportId = randomUUID()
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", body: "see this", reportId },
    })
    expect(res.statusCode).toBe(404)

    h.repo.attachableReports.add(reportId)
    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", body: "see this", reportId },
    })
    expect(ok.statusCode).toBe(201)
  })

  // --- content filter + rate limit (the "post to feed" hardening) ---------------------------------

  it("422s a body containing a slur, on every post kind that carries one", async () => {
    const h = await makeHarness()
    const me = await h.signIn("slur@example.com", "Slur")
    const parent = h.repo.seed({ authorId: me.userId, body: "parent" })

    const cases: Array<[string, Record<string, unknown>]> = [
      ["bare post", { kind: "post", body: "you are a retard" }],
      ["obfuscated", { kind: "post", body: "f4ggot" }],
      ["reply", { kind: "reply", body: "retards", replyToId: parent }],
      ["quote", { kind: "quote", body: "n.i.g.g.e.r", repostOfId: parent }],
    ]
    for (const [label, payload] of cases) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/posts",
        headers: bearer(me),
        payload,
      })
      expect(res.statusCode, label).toBe(422)
      expect(res.json().code, label).toBe("VALIDATION")
      expect(res.json().fields.body, label).toMatch(/isn't allowed/i)
    }
    // The seeded parent is the only row: nothing slurred was written.
    expect(h.repo.posts.size).toBe(1)

    // General profanity is explicitly OUT of scope for the filter — this must still post.
    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", body: "this damn pothole again" },
    })
    expect(ok.statusCode).toBe(201)
  })

  it("201s an attachment-only post with NO body (assertNoSlur(null) is a no-op)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("attach@example.com", "Attach")
    const reportId = randomUUID()
    h.repo.attachableReports.add(reportId)

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "post", reportId, mediaUploadIds: [], mentionedUserIds: [] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().body).toBeNull()
    expect(h.repo.posts.get(res.json().id)?.reportId).toBe(reportId)
  })

  it("rate limits createPost at 120/min PER IP (the route carries its own config.rateLimit bucket)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("burst@example.com", "Burst")
    const post = () =>
      h.app.inject({
        method: "POST",
        url: "/v1/posts",
        headers: bearer(me),
        payload: { kind: "post", body: "burst" },
      })

    for (let i = 0; i < 120; i += 1) {
      expect((await post()).statusCode, `request ${i + 1}`).toBe(201)
    }
    // Without the route bucket this would sit at the global 300/min and return a 121st 201. The bucket is
    // keyed by IP (the inherited global keyGenerator), so it is shared by every user behind one exit -
    // which is why it is 120 and not the 20-30 the other creates use: this endpoint carries thread
    // replies, and a whole crew replying from one venue Wi-Fi must not 429 each other.
    expect((await post()).statusCode).toBe(429)
  })

  it("404s a reply whose parent does not exist, and bumps counts.replies when it does", async () => {
    const h = await makeHarness()
    const me = await h.signIn("reply@example.com", "Reply")
    const missing = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "reply", body: "hi", replyToId: UNKNOWN_ID },
    })
    expect(missing.statusCode).toBe(404)

    const parent = h.repo.seed({ authorId: me.userId, body: "parent" })
    const reply = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: bearer(me),
      payload: { kind: "reply", body: "child", replyToId: parent },
    })
    expect(reply.statusCode).toBe(201)
    expect(reply.json().replyToId).toBe(parent)

    const parentRes = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${parent}`,
      headers: bearer(me),
    })
    expect(parentRes.json().counts.replies).toBe(1)
  })
})

describe("GET /posts/:id (getPost) + DELETE /posts/:id (deletePost)", () => {
  it("200s the DTO, 422s a non-uuid id, 404s an unknown id", async () => {
    const h = await makeHarness()
    const me = await h.signIn("get@example.com", "Get")
    const id = h.repo.seed({ authorId: me.userId, body: "readable" })

    const ok = await h.app.inject({ method: "GET", url: `/v1/posts/${id}`, headers: bearer(me) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ id, body: "readable" })

    const bad = await h.app.inject({ method: "GET", url: "/v1/posts/not-a-uuid", headers: bearer(me) })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().fields.id).toBeDefined()

    const missing = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${UNKNOWN_ID}`,
      headers: bearer(me),
    })
    expect(missing.statusCode).toBe(404)
  })

  it("404s a post whose author has blocked the viewer (either direction)", async () => {
    const h = await makeHarness()
    const author = await h.signIn("blocker@example.com", "Blocker")
    const viewer = await h.signIn("viewer@example.com", "Viewer")
    const id = h.repo.seed({ authorId: author.userId })
    h.blocked.add(`${author.userId}:${viewer.userId}`)

    const res = await h.app.inject({ method: "GET", url: `/v1/posts/${id}`, headers: bearer(viewer) })
    expect(res.statusCode).toBe(404)
    // The author still sees their own post.
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/posts/${id}`, headers: bearer(author) })).statusCode,
    ).toBe(200)
  })

  it("deletes only your own post: 200 {ok:true} for the author, 403 for anyone else", async () => {
    const h = await makeHarness()
    const author = await h.signIn("owner@example.com", "Owner")
    const other = await h.signIn("nosy@example.com", "Nosy")
    const id = h.repo.seed({ authorId: author.userId })

    const forbidden = await h.app.inject({
      method: "DELETE",
      url: `/v1/posts/${id}`,
      headers: bearer(other),
    })
    expect(forbidden.statusCode).toBe(403)
    expect(h.repo.posts.get(id)!.deletedAt).toBeNull()

    const ok = await h.app.inject({
      method: "DELETE",
      url: `/v1/posts/${id}`,
      headers: bearer(author),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })
    expect(h.repo.posts.get(id)!.deletedAt).not.toBeNull()

    // A second delete (and a read) of the tombstoned post is a 404.
    expect(
      (await h.app.inject({ method: "DELETE", url: `/v1/posts/${id}`, headers: bearer(author) }))
        .statusCode,
    ).toBe(404)
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/posts/${id}`, headers: bearer(author) }))
        .statusCode,
    ).toBe(404)
  })
})

describe("interaction toggles (like / save / repost)", () => {
  it("like then unlike moves counts.likes and viewer.liked in both directions", async () => {
    const h = await makeHarness()
    const author = await h.signIn("la@example.com", "LA")
    const fan = await h.signIn("fan@example.com", "Fan")
    const id = h.repo.seed({ authorId: author.userId })

    const liked = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${id}/like`,
      headers: bearer(fan),
    })
    expect(liked.statusCode).toBe(200)
    expect(liked.json()).toMatchObject({ id, counts: { likes: 1 }, viewer: { liked: true } })

    // Idempotent: a second like does not double-count.
    const again = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${id}/like`,
      headers: bearer(fan),
    })
    expect(again.json().counts.likes).toBe(1)

    const unliked = await h.app.inject({
      method: "DELETE",
      url: `/v1/posts/${id}/like`,
      headers: bearer(fan),
    })
    expect(unliked.statusCode).toBe(200)
    expect(unliked.json()).toMatchObject({ counts: { likes: 0 }, viewer: { liked: false } })

    // The author's own view sees the count but not the fan's flag.
    const asAuthor = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${id}/like`,
      headers: bearer(fan),
    })
    expect(asAuthor.json().counts.likes).toBe(1)
    const authorView = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${id}`,
      headers: bearer(author),
    })
    expect(authorView.json()).toMatchObject({ counts: { likes: 1 }, viewer: { liked: false } })
  })

  it("save then unsave toggles viewer.saved AND membership of GET /me/saves", async () => {
    const h = await makeHarness()
    const me = await h.signIn("saver@example.com", "Saver")
    const id = h.repo.seed({ authorId: me.userId })

    expect((await h.app.inject({ method: "GET", url: "/v1/me/saves", headers: bearer(me) })).json())
      .toEqual({ items: [], nextCursor: null })

    const saved = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${id}/save`,
      headers: bearer(me),
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ counts: { saves: 1 }, viewer: { saved: true } })

    const list = await h.app.inject({ method: "GET", url: "/v1/me/saves", headers: bearer(me) })
    expect(list.json().items.map((p: PostDTO) => p.id)).toEqual([id])

    const unsaved = await h.app.inject({
      method: "DELETE",
      url: `/v1/posts/${id}/save`,
      headers: bearer(me),
    })
    expect(unsaved.json()).toMatchObject({ counts: { saves: 0 }, viewer: { saved: false } })
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/me/saves", headers: bearer(me) })).json().items,
    ).toEqual([])

    // Another account's saves are not visible in mine.
    const other = await h.signIn("other-saver@example.com", "Other")
    await h.app.inject({ method: "POST", url: `/v1/posts/${id}/save`, headers: bearer(other) })
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/me/saves", headers: bearer(me) })).json().items,
    ).toEqual([])
  })

  it("repost returns the ORIGINAL target's DTO, and unrepost reverses it", async () => {
    const h = await makeHarness()
    const author = await h.signIn("orig@example.com", "Orig")
    const sharer = await h.signIn("sharer@example.com", "Sharer")
    const original = h.repo.seed({ authorId: author.userId, body: "original" })
    // A pure repost row pointing at the original: reposting THAT must resolve to the original.
    const bounce = h.repo.seed({ authorId: sharer.userId, kind: "repost", repostOfId: original, body: null })

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${bounce}/repost`,
      headers: bearer(sharer),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: original,
      body: "original",
      counts: { reposts: 1 },
      viewer: { reposted: true },
    })

    const undone = await h.app.inject({
      method: "DELETE",
      url: `/v1/posts/${bounce}/repost`,
      headers: bearer(sharer),
    })
    expect(undone.statusCode).toBe(200)
    expect(undone.json()).toMatchObject({ id: original, counts: { reposts: 0 }, viewer: { reposted: false } })
  })

  it("404s every toggle against an unknown post and 422s a non-uuid id", async () => {
    const h = await makeHarness()
    const me = await h.signIn("toggles@example.com", "T")
    for (const [method, suffix] of [
      ["POST", "like"],
      ["DELETE", "like"],
      ["POST", "save"],
      ["DELETE", "save"],
      ["POST", "repost"],
      ["DELETE", "repost"],
    ] as const) {
      const missing = await h.app.inject({
        method,
        url: `/v1/posts/${UNKNOWN_ID}/${suffix}`,
        headers: bearer(me),
      })
      expect(missing.statusCode, `${method} ${suffix} unknown`).toBe(404)
      const bad = await h.app.inject({
        method,
        url: `/v1/posts/nope/${suffix}`,
        headers: bearer(me),
      })
      expect(bad.statusCode, `${method} ${suffix} non-uuid`).toBe(422)
    }
  })
})

describe("list endpoints: replies / user posts / saves / home feed", () => {
  it("lists replies newest-first, scoped to the parent", async () => {
    const h = await makeHarness()
    const me = await h.signIn("threads@example.com", "Th")
    const parent = h.repo.seed({ authorId: me.userId, body: "parent" })
    const otherParent = h.repo.seed({ authorId: me.userId, body: "unrelated" })
    const first = h.repo.seed({ authorId: me.userId, kind: "reply", replyToId: parent, body: "one" })
    const second = h.repo.seed({ authorId: me.userId, kind: "reply", replyToId: parent, body: "two" })
    h.repo.seed({ authorId: me.userId, kind: "reply", replyToId: otherParent, body: "elsewhere" })

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${parent}/replies`,
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((p: PostDTO) => p.id)).toEqual([second, first])
    expect(res.json().nextCursor).toBeNull()
  })

  it("pages replies with the cursor it advertised (no duplicates, no gaps)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("page@example.com", "Page")
    const parent = h.repo.seed({ authorId: me.userId })
    const ids = [0, 1, 2].map((i) =>
      h.repo.seed({ authorId: me.userId, kind: "reply", replyToId: parent, body: `r${i}` }),
    )

    const page1 = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${parent}/replies?limit=2`,
      headers: bearer(me),
    })
    expect(page1.statusCode).toBe(200)
    expect(page1.json().items.map((p: PostDTO) => p.id)).toEqual([ids[2], ids[1]])
    const cursor = page1.json().nextCursor as string
    expect(cursor).toBeTruthy()

    const page2 = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${parent}/replies?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: bearer(me),
    })
    expect(page2.json().items.map((p: PostDTO) => p.id)).toEqual([ids[0]])
    expect(page2.json().nextCursor).toBeNull()
  })

  it("404s replies of a post the viewer cannot read", async () => {
    const h = await makeHarness()
    const me = await h.signIn("nope@example.com", "N")
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${UNKNOWN_ID}/replies`,
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(404)
  })

  it("lists an author's posts, and returns EMPTY (not 404) across a block", async () => {
    const h = await makeHarness()
    const author = await h.signIn("prolific@example.com", "Prolific")
    const viewer = await h.signIn("reader@example.com", "Reader")
    const a = h.repo.seed({ authorId: author.userId, body: "a" })
    const b = h.repo.seed({ authorId: author.userId, body: "b" })
    h.repo.seed({ authorId: viewer.userId, body: "not mine" })

    const ok = await h.app.inject({
      method: "GET",
      url: `/v1/people/${author.userId}/posts`,
      headers: bearer(viewer),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().items.map((p: PostDTO) => p.id)).toEqual([b, a])

    h.blocked.add(`${viewer.userId}:${author.userId}`)
    const blocked = await h.app.inject({
      method: "GET",
      url: `/v1/people/${author.userId}/posts`,
      headers: bearer(viewer),
    })
    expect(blocked.statusCode).toBe(200)
    expect(blocked.json()).toEqual({ items: [], nextCursor: null })
  })

  it("422s an out-of-range pagination limit on every list endpoint", async () => {
    const h = await makeHarness()
    const me = await h.signIn("limits@example.com", "L")
    const id = h.repo.seed({ authorId: me.userId })
    for (const url of [
      `/v1/posts/${id}/replies`,
      `/v1/people/${me.userId}/posts`,
      "/v1/me/saves",
      "/v1/feed/home",
    ]) {
      for (const limit of ["0", "51", "abc"]) {
        const res = await h.app.inject({
          method: "GET",
          url: `${url}?limit=${limit}`,
          headers: bearer(me),
        })
        expect(res.statusCode, `${url}?limit=${limit}`).toBe(422)
        expect(res.json().fields.limit, `${url}?limit=${limit}`).toBeDefined()
      }
    }
  })

  it("honors the home-feed filter and 422s an unknown one", async () => {
    const h = await makeHarness()
    const me = await h.signIn("filter@example.com", "F")
    const eventId = randomUUID()
    const reportId = randomUUID()
    const plain = h.repo.seed({ authorId: me.userId, body: "plain" })
    const withEvent = h.repo.seed({ authorId: me.userId, body: "event", eventId })
    const withReport = h.repo.seed({ authorId: me.userId, body: "report", reportId })

    const all = await h.app.inject({ method: "GET", url: "/v1/feed/home", headers: bearer(me) })
    expect(all.json().items.map((p: PostDTO) => p.id).sort()).toEqual(
      [plain, withEvent, withReport].sort(),
    )

    const events = await h.app.inject({
      method: "GET",
      url: "/v1/feed/home?filter=events",
      headers: bearer(me),
    })
    expect(events.json().items.map((p: PostDTO) => p.id)).toEqual([withEvent])

    const fixes = await h.app.inject({
      method: "GET",
      url: "/v1/feed/home?filter=fixes",
      headers: bearer(me),
    })
    expect(fixes.json().items.map((p: PostDTO) => p.id)).toEqual([withReport])

    const bad = await h.app.inject({
      method: "GET",
      url: "/v1/feed/home?filter=following",
      headers: bearer(me),
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().fields.filter).toBeDefined()
  })

  // REGRESSION: the home timeline used to include replies. `homeFeed`'s SQL was missing the
  // `AND p.reply_to_id IS NULL` term that `publicFeed` shipped with, so a signed-OUT reader got a clean
  // timeline while a signed-IN reader got a reply dump. This is the route-level guard; the real-SQL proof
  // lives in test/integration/posts.test.ts. Both are needed: this one only exercises the fake, and the
  // fake's byFilter had drifted from the SQL in exactly the way that let the bug hide.
  it("keeps replies OFF the home timeline while the thread, saves and reposts-of-a-reply still show them", async () => {
    const h = await makeHarness()
    const me = await h.signIn("noreplies@example.com", "NoReplies")
    const parent = h.repo.seed({ authorId: me.userId, body: "the original thought" })
    const reply = h.repo.seed({ authorId: me.userId, kind: "reply", replyToId: parent, body: "count me in" })
    // A repost of the reply: its OWN row is top-level (repost never sets replyToId), so it MUST survive —
    // amplifying is a deliberate act, and this is the documented carve-out, not an oversight.
    const repostOfReply = h.repo.seed({ authorId: me.userId, kind: "repost", repostOfId: reply, body: null })

    const home = await h.app.inject({ method: "GET", url: "/v1/feed/home", headers: bearer(me) })
    expect(home.statusCode).toBe(200)
    const homeIds = home.json().items.map((p: PostDTO) => p.id)
    expect(homeIds).toContain(parent)
    expect(homeIds).not.toContain(reply)
    expect(homeIds).toContain(repostOfReply)

    // Signed-out reads the SAME shape — the whole point of using publicFeed's exact predicate.
    const publicIds = (await h.app.inject({ method: "GET", url: "/v1/feed/home" })).json()
      .items.map((p: PostDTO) => p.id)
    expect(publicIds).toContain(parent)
    expect(publicIds).not.toContain(reply)

    // The thread is untouched: the reply is still there, and still readable by permalink.
    const replies = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${parent}/replies`,
      headers: bearer(me),
    })
    expect(replies.statusCode).toBe(200)
    expect(replies.json().items.map((p: PostDTO) => p.id)).toEqual([reply])
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/posts/${reply}`, headers: bearer(me) })).json().id,
    ).toBe(reply)

    // The profile "Posts" tab excludes it too (`kind <> 'reply'`), but a BOOKMARKED reply still shows:
    // the viewer asked for that one by name.
    expect(
      (await h.app.inject({
        method: "GET",
        url: `/v1/people/${me.userId}/posts`,
        headers: bearer(me),
      })).json().items.map((p: PostDTO) => p.id),
    ).not.toContain(reply)
    await h.app.inject({ method: "POST", url: `/v1/posts/${reply}/save`, headers: bearer(me) })
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/me/saves", headers: bearer(me) })).json()
        .items.map((p: PostDTO) => p.id),
    ).toContain(reply)
  })

  it("omits soft-deleted posts from every list surface", async () => {
    const h = await makeHarness()
    const me = await h.signIn("tomb@example.com", "Tomb")
    const kept = h.repo.seed({ authorId: me.userId, body: "kept" })
    const gone = h.repo.seed({ authorId: me.userId, body: "gone" })
    await h.app.inject({ method: "POST", url: `/v1/posts/${gone}/save`, headers: bearer(me) })
    await h.app.inject({ method: "DELETE", url: `/v1/posts/${gone}`, headers: bearer(me) })

    for (const url of ["/v1/feed/home", `/v1/people/${me.userId}/posts`, "/v1/me/saves"]) {
      const res = await h.app.inject({ method: "GET", url, headers: bearer(me) })
      const ids = res.json().items.map((p: PostDTO) => p.id)
      expect(ids, url).not.toContain(gone)
    }
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/feed/home", headers: bearer(me) }))
        .json()
        .items.map((p: PostDTO) => p.id),
    ).toEqual([kept])
  })
})
