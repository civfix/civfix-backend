
import { describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import type { PostComposeInput, PostDTO } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import {
  makeDrizzlePostRepository,
  type CreatePostArgs,
  type PostBrief,
  type PostRepository,
} from "../../src/services/post-repository.drizzle.js"
import type { PostNotifier } from "../../src/services/notification-service.js"

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

interface FakeConfig {
  briefs?: Record<string, PostBrief>
  members?: Set<string>
  attachableReports?: Set<string>
  /** `${organizationId}:${userId}` pairs the author may publish as. */
  orgMembers?: Set<string>
  likeCreated?: boolean
}

function fakeRepo(cfg: FakeConfig = {}): PostRepository & { created: CreatePostArgs[]; deleted: string[] } {
  const created: CreatePostArgs[] = []
  const deleted: string[] = []
  const dto = (id: string): PostDTO => ({
    id,
    author: {
      id: "author",
      name: "Author",
      handle: "author",
      bio: null,
      avatar: ["#000000", "#111111"],
      followers: 0,
      following: 0,
      isFollowing: false,
    },
    kind: "post",
    body: "hi",
    createdAt: new Date().toISOString(),
    editedAt: null,
    counts: { likes: 0, reposts: 0, replies: 0, saves: 0 },
    viewer: { liked: false, reposted: false, saved: false },
    media: [],
    mentions: [],
    event: null,
    report: null,
    repostOf: null,
    replyToId: null,
    threadRootId: null,
  })
  return {
    created,
    deleted,
    getPostBrief: (id) => Promise.resolve(cfg.briefs?.[id] ?? null),
    actorNameOf: () => Promise.resolve("Actor Zed"),
    canPostAsOrganization: (organizationId: string, userId: string) =>
      Promise.resolve(cfg.orgMembers?.has(`${organizationId}:${userId}`) ?? false),
    isEventMember: (eventId, userId) =>
      Promise.resolve(cfg.members?.has(`${eventId}:${userId}`) ?? false),
    isReportAttachable: (reportId) => Promise.resolve(cfg.attachableReports?.has(reportId) ?? false),
    createPost: (args) => {
      created.push(args)
      return Promise.resolve("new-post-id")
    },
    softDeletePost: (id) => {
      deleted.push(id)
      return Promise.resolve()
    },
    like: () => Promise.resolve(cfg.likeCreated ?? true),
    unlike: () => Promise.resolve(true),
    save: () => Promise.resolve(true),
    unsave: () => Promise.resolve(true),
    repost: (id) => Promise.resolve({ targetId: id, created: true }),
    unrepost: (id) => Promise.resolve({ targetId: id, removed: true }),
    getPostDTO: (id) => Promise.resolve(dto(id)),
    homeFeed: () => Promise.resolve({ items: [], nextCursor: null }),
    publicFeed: () => Promise.resolve({ items: [], nextCursor: null }),
    listReplies: () => Promise.resolve({ items: [], nextCursor: null }),
    listUserPosts: () => Promise.resolve({ items: [], nextCursor: null }),
    listSaves: () => Promise.resolve({ items: [], nextCursor: null }),
  }
}

interface Spy {
  notifier: PostNotifier
  likes: Array<{ recipientId: string; postId: string }>
  replies: Array<{ recipientId: string; postId: string }>
  reposts: Array<{ recipientId: string; postId: string }>
  quotes: Array<{ recipientId: string; postId: string }>
  mentions: Array<{ recipientId: string; postId: string }>
}
function spyNotifier(): Spy {
  const s: Spy = {
    likes: [],
    replies: [],
    reposts: [],
    quotes: [],
    mentions: [],
    notifier: undefined as unknown as PostNotifier,
  }
  s.notifier = {
    onPostLike: (a) => (s.likes.push(a), Promise.resolve()),
    onPostReply: (a) => (s.replies.push(a), Promise.resolve()),
    onPostRepost: (a) => (s.reposts.push(a), Promise.resolve()),
    onPostQuote: (a) => (s.quotes.push(a), Promise.resolve()),
    onPostMention: (a) => (s.mentions.push(a), Promise.resolve()),
  }
  return s
}

describe("PostService validation + authorization", () => {
  it("rejects kind:'repost' on createPost (repost has its own route)", async () => {
    const svc = makePostService({ repo: fakeRepo(), sql: throwingSql })
    await expect(
      svc.createPost(
        {
          kind: "repost",
          repostOfId: "t",
          body: undefined,
          mediaUploadIds: [],
          mentionedUserIds: [],
        } as never,
        "u1",
      ),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("publicFeed serves the global feed with no viewer (you don't need an account to read)", async () => {
    const calls: Array<{ filter: string; cursor: string | null; limit: number }> = []
    const repo = {
      ...fakeRepo(),
      publicFeed: (args: { filter: "all" | "events" | "fixes"; cursor: string | null; limit: number }) => {
        calls.push(args)
        return Promise.resolve({ items: [], nextCursor: null })
      },
    }
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.publicFeed({ filter: "all" })
    expect(calls).toEqual([{ filter: "all", cursor: null, limit: 20 }])
  })

  it("rejects an attached event the author does not host/attend (403)", async () => {
    const repo = fakeRepo({ members: new Set() })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(
      svc.createPost(
        { kind: "post", body: "x", eventId: "evt-1", mediaUploadIds: [], mentionedUserIds: [] },
        "u1",
      ),
    ).rejects.toMatchObject({ httpStatus: 403 })
    expect(repo.created).toHaveLength(0)
  })

  it("allows an attached event the author is a member of", async () => {
    const repo = fakeRepo({ members: new Set(["evt-1:u1"]) })
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.createPost(
      { kind: "post", body: "x", eventId: "evt-1", mediaUploadIds: [], mentionedUserIds: [] },
      "u1",
    )
    expect(repo.created).toHaveLength(1)
    expect(repo.created[0]!.eventId).toBe("evt-1")
  })

  it("posts as an organization the author belongs to, and persists the link", async () => {
    const repo = fakeRepo({ orgMembers: new Set(["org-1:u1"]) })
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.createPost(
      {
        kind: "post",
        body: "x",
        organizationId: "org-1",
        mediaUploadIds: [],
        mentionedUserIds: [],
      },
      "u1",
    )
    expect(repo.created).toHaveLength(1)
    expect(repo.created[0]!.organizationId).toBe("org-1")
    expect(repo.created[0]!.authorId).toBe("u1")
  })

  it("403s posting as an organization the author does not belong to, and writes nothing", async () => {
    const repo = fakeRepo({ orgMembers: new Set(["org-1:someone-else"]) })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(
      svc.createPost(
        {
          kind: "post",
          body: "x",
          organizationId: "org-1",
          mediaUploadIds: [],
          mentionedUserIds: [],
        },
        "u1",
      ),
    ).rejects.toMatchObject({ httpStatus: 403 })
    expect(repo.created).toHaveLength(0)
  })

  it("leaves organizationId null on a personal post", async () => {
    const repo = fakeRepo()
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.createPost(
      { kind: "post", body: "x", mediaUploadIds: [], mentionedUserIds: [] },
      "u1",
    )
    expect(repo.created[0]!.organizationId).toBeNull()
  })

  it("rejects an attached report that is not attachable (404)", async () => {
    const repo = fakeRepo({ attachableReports: new Set() })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(
      svc.createPost(
        { kind: "post", body: "x", reportId: "rep-1", mediaUploadIds: [], mentionedUserIds: [] },
        "u1",
      ),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("deletePost is author-only: 403 for another user, ok for the author", async () => {
    const brief: PostBrief = {
      id: "p1",
      authorId: "owner",
      kind: "post",
      replyToId: null,
      repostOfId: null,
      deletedAt: null,
      visibility: "public",
    }
    const repo = fakeRepo({ briefs: { p1: brief } })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.deletePost("p1", "intruder")).rejects.toMatchObject({ httpStatus: 403 })
    expect(repo.deleted).toHaveLength(0)
    await expect(svc.deletePost("p1", "owner")).resolves.toEqual({ ok: true })
    expect(repo.deleted).toEqual(["p1"])
  })

  it("repostPost rejects a self-repost and never writes a repost row", async () => {
    const reposted: Array<{ postId: string; userId: string }> = []
    const repo = {
      ...fakeRepo({
        briefs: {
          p1: { id: "p1", authorId: "self", kind: "post", replyToId: null, repostOfId: null, deletedAt: null, visibility: "public" },
        },
      }),
      repost: (postId: string, userId: string) => {
        reposted.push({ postId, userId })
        return Promise.resolve({ targetId: postId, created: true })
      },
    }
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.repostPost("p1", "self")).rejects.toMatchObject({ httpStatus: 422 })
    expect(reposted).toHaveLength(0)
    await expect(svc.repostPost("p1", "other")).resolves.toMatchObject({ id: "p1" })
    expect(reposted).toEqual([{ postId: "p1", userId: "other" }])
  })

  it("repostPost resolves a repost shell to its original before the self-repost check", async () => {
    const reposted: Array<{ postId: string; userId: string }> = []
    const repo = {
      ...fakeRepo({
        briefs: {
          shell: { id: "shell", authorId: "booster", kind: "repost", replyToId: null, repostOfId: "orig", deletedAt: null, visibility: "public" },
          orig: { id: "orig", authorId: "self", kind: "post", replyToId: null, repostOfId: null, deletedAt: null, visibility: "public" },
        },
      }),
      repost: (postId: string, userId: string) => {
        reposted.push({ postId, userId })
        return Promise.resolve({ targetId: "orig", created: true })
      },
    }
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.repostPost("shell", "self")).rejects.toMatchObject({ httpStatus: 422 })
    expect(reposted).toHaveLength(0)
    await expect(svc.repostPost("shell", "other")).resolves.toMatchObject({ id: "orig" })
    expect(reposted).toEqual([{ postId: "shell", userId: "other" }])
  })
})

describe("PostService notification fan-out", () => {
  const brief = (over: Partial<PostBrief>): PostBrief => ({
    id: "p1",
    authorId: "author",
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "public",
    ...over,
  })

  it("like notifies the post's author (not the actor)", async () => {
    const repo = fakeRepo({ briefs: { p1: brief({ authorId: "author" }) }, likeCreated: true })
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.likePost("p1", "liker")
    expect(spy.likes).toEqual([{ recipientId: "author", actorName: "Actor Zed", postId: "p1" }])
  })

  it("does NOT notify on a self-like", async () => {
    const repo = fakeRepo({ briefs: { p1: brief({ authorId: "self" }) }, likeCreated: true })
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.likePost("p1", "self")
    expect(spy.likes).toHaveLength(0)
  })

  it("hides a blocked author's post from like interactions", async () => {
    const repo = fakeRepo({ briefs: { p1: brief({ authorId: "author" }) }, likeCreated: true })
    const spy = spyNotifier()
    const svc = makePostService({
      repo,
      sql: throwingSql,
      notifier: spy.notifier,
      isBlockedEitherWay: () => Promise.resolve(true),
    })
    await expect(svc.likePost("p1", "liker")).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(spy.likes).toHaveLength(0)
  })

  it("does NOT notify when the like was already present (not newly created)", async () => {
    const repo = fakeRepo({ briefs: { p1: brief({ authorId: "author" }) }, likeCreated: false })
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.likePost("p1", "liker")
    expect(spy.likes).toHaveLength(0)
  })

  it("a reply notifies the parent's author", async () => {
    const parent = brief({ id: "parent", authorId: "parentAuthor" })
    const repo = fakeRepo({ briefs: { parent } })
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.createPost(
      { kind: "reply", replyToId: "parent", body: "nice", mediaUploadIds: [], mentionedUserIds: [] },
      "replier",
    )
    expect(spy.replies).toEqual([
      { recipientId: "parentAuthor", actorName: "Actor Zed", postId: "new-post-id" },
    ])
  })

  it("liking a repost shell resolves to the original: like lands on the original and notifies its author", async () => {
    const shell = brief({ id: "shell", authorId: "reposter", kind: "repost", repostOfId: "orig" })
    const orig = brief({ id: "orig", authorId: "origAuthor", kind: "post" })
    const base = fakeRepo({ briefs: { shell, orig }, likeCreated: true })
    const likeCalls: string[] = []
    const repo: typeof base = { ...base, like: (id: string) => (likeCalls.push(id), Promise.resolve(true)) }
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.likePost("shell", "liker")
    expect(likeCalls).toEqual(["orig"])
    expect(spy.likes).toEqual([{ recipientId: "origAuthor", actorName: "Actor Zed", postId: "orig" }])
  })
})

describe("PostService: replyToId alone makes a reply, whatever `kind` claims", () => {
  const parentBrief: PostBrief = {
    id: "parent",
    authorId: "parentAuthor",
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "public",
  }

  const kindlessReply = (): PostComposeInput => ({
    kind: "post",
    replyToId: "parent",
    body: "sneaky",
    mediaUploadIds: [],
    mentionedUserIds: [],
  })

  it("rejects a blocked user replying to their blocker's post", async () => {
    const repo = fakeRepo({ briefs: { parent: parentBrief } })
    const svc = makePostService({
      repo,
      sql: throwingSql,
      isBlockedEitherWay: () => Promise.resolve(true),
    })
    await expect(svc.createPost(kindlessReply(), "blocked")).rejects.toMatchObject({
      httpStatus: 404,
    })
    expect(repo.created).toHaveLength(0)
  })

  it("rejects a reply to a soft-deleted parent", async () => {
    const repo = fakeRepo({
      briefs: { parent: { ...parentBrief, deletedAt: new Date() } },
    })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.createPost(kindlessReply(), "replier")).rejects.toMatchObject({
      httpStatus: 404,
    })
    expect(repo.created).toHaveLength(0)
  })

  it("404s an unknown replyToId instead of letting the FK surface as a 500", async () => {
    const repo = fakeRepo()
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(
      svc.createPost({ ...kindlessReply(), replyToId: "ghost" }, "replier"),
    ).rejects.toMatchObject({ httpStatus: 404 })
    expect(repo.created).toHaveLength(0)
  })

  it("persists kind 'reply' and notifies the parent's author", async () => {
    const repo = fakeRepo({ briefs: { parent: parentBrief } })
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.createPost(kindlessReply(), "replier")
    expect(repo.created[0]).toMatchObject({ kind: "reply", replyToId: "parent" })
    expect(spy.replies).toEqual([
      { recipientId: "parentAuthor", actorName: "Actor Zed", postId: "new-post-id" },
    ])
  })

  it("persists kind 'quote' when repostOfId is present without kind:'quote'", async () => {
    const target: PostBrief = { ...parentBrief, id: "target", authorId: "targetAuthor" }
    const repo = fakeRepo({ briefs: { target } })
    const spy = spyNotifier()
    const svc = makePostService({ repo, sql: throwingSql, notifier: spy.notifier })
    await svc.createPost(
      {
        kind: "post",
        repostOfId: "target",
        body: "look at this",
        mediaUploadIds: [],
        mentionedUserIds: [],
      },
      "quoter",
    )
    expect(repo.created[0]).toMatchObject({ kind: "quote", repostOfId: "target" })
    expect(spy.quotes).toHaveLength(1)
  })

  it("422s an input that is both a reply and a quote", async () => {
    const repo = fakeRepo({ briefs: { parent: parentBrief } })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(
      svc.createPost({ ...kindlessReply(), repostOfId: "target" }, "replier"),
    ).rejects.toMatchObject({ httpStatus: 422 })
    expect(repo.created).toHaveLength(0)
  })
})

describe("PostService: an author-erased (visibility 'hidden') post is unreadable", () => {
  const hidden = (over: Partial<PostBrief> = {}): PostBrief => ({
    id: "orig",
    authorId: "erased",
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "hidden",
    ...over,
  })

  it("404s a repost of a hidden original and never writes a repost row", async () => {
    const reposted: Array<{ postId: string; userId: string }> = []
    const repo = {
      ...fakeRepo({ briefs: { orig: hidden() } }),
      repost: (postId: string, userId: string) => {
        reposted.push({ postId, userId })
        return Promise.resolve({ targetId: postId, created: true })
      },
    }
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.repostPost("orig", "booster")).rejects.toMatchObject({ httpStatus: 404 })
    expect(reposted).toHaveLength(0)
  })

  it("404s a quote of, a reply to and a read of a hidden original", async () => {
    const repo = fakeRepo({ briefs: { orig: hidden() } })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.getPost("orig", "reader")).rejects.toMatchObject({ httpStatus: 404 })
    await expect(
      svc.createPost(
        {
          kind: "post",
          repostOfId: "orig",
          body: "look",
          mediaUploadIds: [],
          mentionedUserIds: [],
        },
        "quoter",
      ),
    ).rejects.toMatchObject({ httpStatus: 404 })
    await expect(
      svc.createPost(
        {
          kind: "post",
          replyToId: "orig",
          body: "hey",
          mediaUploadIds: [],
          mentionedUserIds: [],
        },
        "replier",
      ),
    ).rejects.toMatchObject({ httpStatus: 404 })
    expect(repo.created).toHaveLength(0)
  })

  it("404s a read through a repost shell whose original went hidden", async () => {
    const repo = fakeRepo({
      briefs: {
        shell: hidden({
          id: "shell",
          authorId: "booster",
          kind: "repost",
          repostOfId: "orig",
          visibility: "public",
        }),
        orig: hidden(),
      },
    })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.getPost("shell", "reader")).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("PostRepository.loadRefs: a hidden original is an unavailable embed", () => {
  const VIEWER = "11111111-1111-1111-1111-111111111111"
  const QUOTE = "22222222-2222-2222-2222-222222222222"
  const ORIG = "33333333-3333-3333-3333-333333333333"
  const AUTHOR = "44444444-4444-4444-4444-444444444444"
  const ERASED = "55555555-5555-5555-5555-555555555555"
  const AT = new Date("2026-07-01T00:00:00.000Z")

  function repoOver(visibility: "public" | "hidden") {
    const fake = makeFakeSql([
      {
        match: /FROM posts p WHERE p\.id = \?/,
        rows: [
          {
            id: QUOTE,
            author_id: AUTHOR,
            kind: "quote",
            body: "quoting this",
            reply_to_id: null,
            thread_root_id: null,
            repost_of_id: ORIG,
            event_id: null,
            report_id: null,
            like_count: 0,
            repost_count: 0,
            reply_count: 0,
            save_count: 0,
            organization_id: null,
            created_at: AT,
            updated_at: AT,
          },
        ],
      },
      {
        match: /LEFT JOIN media_assets am ON am\.id = u\.avatar_media_id/,
        rows: [
          {
            id: AUTHOR,
            display_name: "Quoter",
            handle: "quoter",
            bio: null,
            followers: 0,
            following: 0,
            verified: false,
            avatar_r2_key: null,
            avatar_url: null,
            is_following: false,
            deleted_at: null,
          },
        ],
      },
      {
        match: /LEFT JOIN users u ON u\.id = p\.author_id/,
        rows: [
          {
            id: ORIG,
            kind: "post",
            body: "the original body",
            event_id: "66666666-6666-6666-6666-666666666666",
            report_id: null,
            like_count: 3,
            repost_count: 1,
            reply_count: 0,
            save_count: 0,
            created_at: AT,
            deleted_at: null,
            visibility,
            author_id: ERASED,
            display_name: "Erased",
            handle: "erased",
            bio: "bio",
            avatar_url: null,
            verified: false,
          },
        ],
      },
    ])
    const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })
    return { repo, fake }
  }

  it("selects posts.visibility on the ref query", async () => {
    const { repo, fake } = repoOver("hidden")
    await repo.getPostDTO(QUOTE, VIEWER)
    const refStmt = fake.statements.find((s) => /LEFT JOIN users u ON u\.id = p\.author_id/.test(s.sql))
    expect(refStmt?.sql).toContain("p.visibility")
  })

  it("blanks the body, excerpt, author and links of a hidden original and loads no media for it", async () => {
    const { repo, fake } = repoOver("hidden")
    const dto = await repo.getPostDTO(QUOTE, VIEWER)
    expect(dto?.repostOf).toMatchObject({
      id: ORIG,
      deleted: true,
      body: null,
      excerpt: "",
      author: null,
      media: [],
      event: null,
      report: null,
    })
    const mediaStmts = fake.statements.filter((s) => /FROM media_assets\s+WHERE post_id/.test(s.sql))
    expect(mediaStmts.some((s) => JSON.stringify(s.values).includes(ORIG))).toBe(false)
    const eventStmts = fake.statements.filter((s) => /FROM cleanups c/.test(s.sql))
    expect(eventStmts).toHaveLength(0)
  })

  it("still ships the body and links of a public original", async () => {
    const { repo, fake } = repoOver("public")
    const dto = await repo.getPostDTO(QUOTE, VIEWER)
    expect(dto?.repostOf).toMatchObject({ id: ORIG, body: "the original body" })
    expect(dto?.repostOf?.deleted).toBeUndefined()
    const mediaStmts = fake.statements.filter((s) => /FROM media_assets\s+WHERE post_id/.test(s.sql))
    expect(mediaStmts.some((s) => JSON.stringify(s.values).includes(ORIG))).toBe(true)
  })
})

describe("PostRepository read paths all exclude non-public posts", () => {
  const VIEWER = "11111111-1111-1111-1111-111111111111"
  const SUBJECT = "22222222-2222-2222-2222-222222222222"

  async function emitted(run: (repo: ReturnType<typeof makeDrizzlePostRepository>) => Promise<unknown>) {
    const fake = makeFakeSql()
    const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })
    await run(repo)
    return fake.statements[0]!.sql
  }

  const args = { viewerId: VIEWER, cursor: null, limit: 10 }

  it("filters every post-listing query on visibility, not just the public feed", async () => {
    const cases: Array<[string, (r: ReturnType<typeof makeDrizzlePostRepository>) => Promise<unknown>]> = [
      ["getPostDTO", (r) => r.getPostDTO(SUBJECT, VIEWER)],
      ["homeFeed", (r) => r.homeFeed({ ...args, filter: "all" })],
      ["publicFeed", (r) => r.publicFeed({ filter: "all", cursor: null, limit: 10 })],
      ["listReplies", (r) => r.listReplies(SUBJECT, args)],
      ["listUserPosts", (r) => r.listUserPosts(SUBJECT, args)],
      ["listSaves", (r) => r.listSaves(args)],
    ]
    for (const [name, run] of cases) {
      const stmt = await emitted(run)
      expect(stmt, `${name} must exclude non-public posts`).toMatch(/visibility = 'public'/)
      expect(stmt, `${name} must exclude soft-deleted posts`).toMatch(/deleted_at IS NULL/)
    }
  })

  it("selects visibility on getPostBrief so the service can gate on it", async () => {
    const stmt = await emitted((r) => r.getPostBrief(SUBJECT))
    expect(stmt).toContain("visibility")
  })
})

describe("PostRepository organization hydration", () => {
  const VIEWER = "11111111-1111-1111-1111-111111111111"
  const POST = "22222222-2222-2222-2222-222222222222"
  const AUTHOR = "33333333-3333-3333-3333-333333333333"
  const ORG = "44444444-4444-4444-4444-444444444444"
  const AT = new Date("2026-09-01T00:00:00.000Z")

  const authorRow = {
    id: AUTHOR,
    display_name: "Author",
    handle: "author",
    bio: null,
    followers: 0,
    following: 0,
    avatar_r2_key: null,
    avatar_url: null,
    is_following: false,
    deleted_at: null,
  }

  function postRow(organizationId: string | null) {
    return {
      id: POST,
      author_id: AUTHOR,
      kind: "post",
      body: "hello",
      reply_to_id: null,
      thread_root_id: null,
      repost_of_id: null,
      event_id: null,
      report_id: null,
      like_count: 0,
      repost_count: 0,
      reply_count: 0,
      save_count: 0,
      organization_id: organizationId,
      created_at: AT,
      updated_at: AT,
    }
  }

  function repoOver(organizationId: string | null) {
    const fake = makeFakeSql([
      { match: /FROM posts p WHERE p\.id = \?/, rows: [postRow(organizationId)] },
      { match: /LEFT JOIN media_assets am ON am\.id = u\.avatar_media_id/, rows: [authorRow] },
    ])
    const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })
    return { repo, fake }
  }

  function organizationStatements(fake: ReturnType<typeof makeFakeSql>) {
    return fake.statements.filter((s) => /FROM organizations o/.test(s.sql))
  }

  it("selects organization_id on every post-listing query, so hydration never batches undefined", async () => {
    const args = { viewerId: VIEWER, cursor: null, limit: 10 }
    const cases: Array<[string, (r: ReturnType<typeof makeDrizzlePostRepository>) => Promise<unknown>]> = [
      ["getPostDTO", (r) => r.getPostDTO(POST, VIEWER)],
      ["homeFeed", (r) => r.homeFeed({ ...args, filter: "all" })],
      ["publicFeed", (r) => r.publicFeed({ filter: "all", cursor: null, limit: 10 })],
      ["listReplies", (r) => r.listReplies(POST, args)],
      ["listUserPosts", (r) => r.listUserPosts(AUTHOR, args)],
      ["listSaves", (r) => r.listSaves(args)],
    ]
    for (const [name, run] of cases) {
      const fake = makeFakeSql()
      const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
        presignMedia: () => Promise.resolve({ url: "u" }),
        presignAvatar: () => Promise.resolve("a"),
      })
      await run(repo)
      expect(fake.statements[0]!.sql, `${name} must select organization_id`).toMatch(
        /p\.organization_id/,
      )
    }
  })

  it("runs NO organizations query for a post published by a user with no organization", async () => {
    const { repo, fake } = repoOver(null)
    const dto = await repo.getPostDTO(POST, VIEWER)
    expect(dto?.organization).toBeNull()
    expect(organizationStatements(fake)).toHaveLength(0)
  })

  it("passes exactly the present organization ids, never a hole, to the organizations query", async () => {
    const { repo, fake } = repoOver(ORG)
    await repo.getPostDTO(POST, VIEWER)
    const stmt = organizationStatements(fake)[0]
    expect(stmt?.values).toEqual([[ORG]])
  })

  it("drops a missing organization_id column instead of batching undefined", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM posts p WHERE p\.id = \?/,
        rows: [{ ...postRow(null), organization_id: undefined }],
      },
      { match: /LEFT JOIN media_assets am ON am\.id = u\.avatar_media_id/, rows: [authorRow] },
    ])
    const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })
    const dto = await repo.getPostDTO(POST, VIEWER)
    expect(dto?.organization).toBeNull()
    expect(organizationStatements(fake)).toHaveLength(0)
  })
})
