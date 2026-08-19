
import { AppError } from "@civfix/shared"
import type { HomeFeedQuery, PaginationQuery, PostComposeInput, PostDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { resolveMentionTargets } from "./mention-resolver.drizzle.js"
import {
  POSTS_DEFAULT_LIMIT,
  type FeedPage,
  type PostRepository,
} from "./post-repository.drizzle.js"
import type { PostNotifier } from "./notification-service.js"

export interface PostServiceDeps {
  repo: PostRepository
  sql: Sql
  notifier?: PostNotifier
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
  logger?: { warn(obj: unknown, msg: string): void }
}

export interface PostService {
  createPost(input: PostComposeInput, authorId: string): Promise<PostDTO>
  getPost(id: string, viewerId: string): Promise<PostDTO>
  deletePost(id: string, viewerId: string): Promise<{ ok: true }>
  listReplies(postId: string, viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
  likePost(id: string, viewerId: string): Promise<PostDTO>
  unlikePost(id: string, viewerId: string): Promise<PostDTO>
  savePost(id: string, viewerId: string): Promise<PostDTO>
  unsavePost(id: string, viewerId: string): Promise<PostDTO>
  repostPost(id: string, viewerId: string): Promise<PostDTO>
  unrepostPost(id: string, viewerId: string): Promise<PostDTO>
  homeFeed(viewerId: string, query: HomeFeedQuery): Promise<FeedPage>
  publicFeed(query: HomeFeedQuery): Promise<FeedPage>
  listUserPosts(authorId: string, viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
  listSaves(viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
}

export function makePostService(deps: PostServiceDeps): PostService {
  const isBlocked = deps.isBlockedEitherWay ?? (() => Promise.resolve(false))

  async function safeNotify(fn: () => Promise<void>): Promise<void> {
    if (!deps.notifier) return
    try {
      await fn()
    } catch (err) {
      deps.logger?.warn({ err }, "post: notification dispatch failed (suppressed)")
    }
  }

  async function shouldNotify(actorId: string, recipientId: string): Promise<boolean> {
    if (recipientId === actorId) return false
    return !(await isBlocked(actorId, recipientId))
  }

  async function hydrateOrThrow(id: string, viewerId: string): Promise<PostDTO> {
    const dto = await deps.repo.getPostDTO(id, viewerId)
    if (!dto) throw AppError.notFound("Post not found")
    return dto
  }

  async function requireReadable(id: string, viewerId: string) {
    const brief = await deps.repo.getPostBrief(id)
    if (!brief || brief.deletedAt !== null || (await isBlocked(viewerId, brief.authorId))) {
      throw AppError.notFound("Post not found")
    }
    if (brief.repostOfId) {
      const target = await deps.repo.getPostBrief(brief.repostOfId)
      if (!target || target.deletedAt !== null || (await isBlocked(viewerId, target.authorId))) {
        throw AppError.notFound("Post not found")
      }
      if (brief.kind === "repost") return target
    }
    return brief
  }

  return {
    async createPost(input: PostComposeInput, authorId: string): Promise<PostDTO> {
      assertNoSlur(input.body ?? null, "body")

      if (input.kind === "repost") {
        throw AppError.validation({ kind: "Use POST /posts/:id/repost to repost." })
      }
      if (input.replyToId !== undefined && input.repostOfId !== undefined) {
        throw AppError.validation({
          replyToId: "A post is either a reply or a quote, not both.",
        })
      }
      const kind =
        input.replyToId !== undefined ? "reply" : input.repostOfId !== undefined ? "quote" : "post"

      let replyParentAuthor: string | null = null
      if (input.replyToId !== undefined) {
        const parent = await requireReadable(input.replyToId, authorId)
        replyParentAuthor = parent.authorId
      }
      let quoteTargetAuthor: string | null = null
      if (input.repostOfId !== undefined) {
        const target = await requireReadable(input.repostOfId, authorId)
        quoteTargetAuthor = target.authorId
      }

      if (input.eventId !== undefined) {
        if (!(await deps.repo.isEventMember(input.eventId, authorId))) {
          throw AppError.forbidden("You can only attach an event you host or attend.")
        }
      }
      if (input.reportId !== undefined) {
        if (!(await deps.repo.isReportAttachable(input.reportId))) {
          throw AppError.notFound("Report not found")
        }
      }

      const mentions = await resolveMentionTargets(deps.sql, {
        handles: [],
        userIds: input.mentionedUserIds,
        authorUserId: authorId,
      })

      const postId = await deps.repo.createPost({
        authorId,
        kind,
        body: input.body ?? null,
        replyToId: input.replyToId ?? null,
        repostOfId: input.repostOfId ?? null,
        eventId: input.eventId ?? null,
        reportId: input.reportId ?? null,
        mediaUploadIds: input.mediaUploadIds,
        mentionedUserIds: mentions.map((m) => m.id),
      })

      const actorName = await deps.repo.actorNameOf(authorId)
      if (replyParentAuthor !== null && (await shouldNotify(authorId, replyParentAuthor))) {
        await safeNotify(() =>
          deps.notifier!.onPostReply({ recipientId: replyParentAuthor!, actorName, postId }),
        )
      }
      if (quoteTargetAuthor !== null && (await shouldNotify(authorId, quoteTargetAuthor))) {
        await safeNotify(() =>
          deps.notifier!.onPostQuote({ recipientId: quoteTargetAuthor!, actorName, postId }),
        )
      }
      for (const m of mentions) {
        if (await shouldNotify(authorId, m.id)) {
          await safeNotify(() => deps.notifier!.onPostMention({ recipientId: m.id, actorName, postId }))
        }
      }

      return hydrateOrThrow(postId, authorId)
    },

    async getPost(id: string, viewerId: string): Promise<PostDTO> {
      await requireReadable(id, viewerId)
      return hydrateOrThrow(id, viewerId)
    },

    async deletePost(id: string, viewerId: string): Promise<{ ok: true }> {
      const brief = await deps.repo.getPostBrief(id)
      if (!brief || brief.deletedAt !== null) throw AppError.notFound("Post not found")
      if (brief.authorId !== viewerId) throw AppError.forbidden("You can only delete your own post.")
      await deps.repo.softDeletePost(id)
      return { ok: true }
    },

    async listReplies(
      postId: string,
      viewerId: string,
      pagination: PaginationQuery,
    ): Promise<FeedPage> {
      const subject = await requireReadable(postId, viewerId)
      return deps.repo.listReplies(subject.id, {
        viewerId,
        cursor: pagination.cursor ?? null,
        limit: pagination.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },

    async likePost(id: string, viewerId: string): Promise<PostDTO> {
      const subject = await requireReadable(id, viewerId)
      const created = await deps.repo.like(subject.id, viewerId)
      if (created && (await shouldNotify(viewerId, subject.authorId))) {
        const actorName = await deps.repo.actorNameOf(viewerId)
        await safeNotify(() =>
          deps.notifier!.onPostLike({ recipientId: subject.authorId, actorName, postId: subject.id }),
        )
      }
      return hydrateOrThrow(id, viewerId)
    },

    async unlikePost(id: string, viewerId: string): Promise<PostDTO> {
      const subject = await requireReadable(id, viewerId)
      await deps.repo.unlike(subject.id, viewerId)
      return hydrateOrThrow(id, viewerId)
    },

    async savePost(id: string, viewerId: string): Promise<PostDTO> {
      const subject = await requireReadable(id, viewerId)
      await deps.repo.save(subject.id, viewerId)
      return hydrateOrThrow(id, viewerId)
    },

    async unsavePost(id: string, viewerId: string): Promise<PostDTO> {
      const subject = await requireReadable(id, viewerId)
      await deps.repo.unsave(subject.id, viewerId)
      return hydrateOrThrow(id, viewerId)
    },

    async repostPost(id: string, viewerId: string): Promise<PostDTO> {
      await requireReadable(id, viewerId)
      const { targetId, created } = await deps.repo.repost(id, viewerId)
      if (created) {
        const targetBrief = await deps.repo.getPostBrief(targetId)
        if (targetBrief && (await shouldNotify(viewerId, targetBrief.authorId))) {
          const actorName = await deps.repo.actorNameOf(viewerId)
          await safeNotify(() =>
            deps.notifier!.onPostRepost({
              recipientId: targetBrief.authorId,
              actorName,
              postId: targetId,
            }),
          )
        }
      }
      return hydrateOrThrow(targetId, viewerId)
    },

    async unrepostPost(id: string, viewerId: string): Promise<PostDTO> {
      await requireReadable(id, viewerId)
      const { targetId } = await deps.repo.unrepost(id, viewerId)
      return hydrateOrThrow(targetId, viewerId)
    },

    async homeFeed(viewerId: string, query: HomeFeedQuery): Promise<FeedPage> {
      return deps.repo.homeFeed({
        viewerId,
        filter: query.filter,
        cursor: query.cursor ?? null,
        limit: query.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },

    async publicFeed(query: HomeFeedQuery): Promise<FeedPage> {
      return deps.repo.publicFeed({
        filter: query.filter,
        cursor: query.cursor ?? null,
        limit: query.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },

    async listUserPosts(
      authorId: string,
      viewerId: string,
      pagination: PaginationQuery,
    ): Promise<FeedPage> {
      if (await isBlocked(authorId, viewerId)) return { items: [], nextCursor: null }
      return deps.repo.listUserPosts(authorId, {
        viewerId,
        cursor: pagination.cursor ?? null,
        limit: pagination.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },

    async listSaves(viewerId: string, pagination: PaginationQuery): Promise<FeedPage> {
      return deps.repo.listSaves({
        viewerId,
        cursor: pagination.cursor ?? null,
        limit: pagination.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },
  }
}
