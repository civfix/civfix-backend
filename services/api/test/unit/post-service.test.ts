/**
 * PostService policy unit tests (no DB). A hand fake PostRepository + a spy PostNotifier exercise the
 * service's validation / authorization / notification-fan-out rules directly:
 *   - attach-event rejects a non-member (403); attach-report rejects a missing/hidden report (404);
 *   - createPost rejects kind:"repost" (that is the toggle route);
 *   - delete is author-only (403 for another user);
 *   - like notifies the post's author, NOT the actor themselves, and NOT across a block;
 *   - a reply notifies the parent's author.
 *
 * resolveMentionTargets is never reached (mentionedUserIds is empty in these cases), so `sql` is a
 * throwing stub — proving these paths need no database.
 */

import { describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import type { PostComposeInput, PostDTO } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import type {
  CreatePostArgs,
  PostBrief,
  PostRepository,
} from "../../src/services/post-repository.drizzle.js"
import type { PostNotifier } from "../../src/services/notification-service.js"

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

interface FakeConfig {
  briefs?: Record<string, PostBrief>
  members?: Set<string> // `${eventId}:${userId}`
  attachableReports?: Set<string>
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
    const repo = fakeRepo({ members: new Set() }) // no membership
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
    }
    const repo = fakeRepo({ briefs: { p1: brief } })
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.deletePost("p1", "intruder")).rejects.toMatchObject({ httpStatus: 403 })
    expect(repo.deleted).toHaveLength(0)
    await expect(svc.deletePost("p1", "owner")).resolves.toEqual({ ok: true })
    expect(repo.deleted).toEqual(["p1"])
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
})

describe("PostService: replyToId alone makes a reply, whatever `kind` claims", () => {
  const parentBrief: PostBrief = {
    id: "parent",
    authorId: "parentAuthor",
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
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
