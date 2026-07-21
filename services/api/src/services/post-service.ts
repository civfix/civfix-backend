/**
 * PostService: the social-feed post use-cases layered over PostRepository.
 *
 * Responsibilities (the repo does the SQL; the service owns policy):
 *   - validate attachments — event membership (cleanup_members organizer|cohost|member), report
 *     visibility, reply/quote target existence + block filtering;
 *   - resolve + record @-mentions (resolveMentionTargets → mentionedUserIds), block-filtering the
 *     mention notifications;
 *   - authorize delete (author only);
 *   - emit interaction notifications (like/repost/reply/quote/mention) best-effort, skipping self +
 *     blocked recipients (push additionally gated by notification_prefs in the notifier).
 *
 * Modeled on social-service.ts + chat-mentions.drizzle.ts.
 */

import { AppError } from "@civfix/shared"
import type { HomeFeedQuery, PaginationQuery, PostComposeInput, PostDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
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
  listUserPosts(authorId: string, viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
  listSaves(viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
}

export function makePostService(deps: PostServiceDeps): PostService {
  const isBlocked = deps.isBlockedEitherWay ?? (() => Promise.resolve(false))

  /** Best-effort notification: a failure must never fail the interaction that triggered it. */
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
    }
    return brief
  }

  return {
    async createPost(input: PostComposeInput, authorId: string): Promise<PostDTO> {
      if (input.kind === "repost") {
        throw AppError.validation({ kind: "Use POST /posts/:id/repost to repost." })
      }

      // --- validate reply / quote targets ---
      let replyParentAuthor: string | null = null
      if (input.kind === "reply") {
        const parent = input.replyToId ? await deps.repo.getPostBrief(input.replyToId) : null
        if (!parent || parent.deletedAt !== null) throw AppError.notFound("Post not found")
        if (await isBlocked(authorId, parent.authorId)) throw AppError.notFound("Post not found")
        replyParentAuthor = parent.authorId
      }
      let quoteTargetAuthor: string | null = null
      if (input.kind === "quote") {
        const target = input.repostOfId ? await deps.repo.getPostBrief(input.repostOfId) : null
        if (!target || target.deletedAt !== null) throw AppError.notFound("Post not found")
        if (await isBlocked(authorId, target.authorId)) throw AppError.notFound("Post not found")
        quoteTargetAuthor = target.authorId
      }

      // --- validate attachments ---
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

      // --- resolve mentions (excludes self / deleted / handle-less) ---
      const mentions = await resolveMentionTargets(deps.sql, {
        handles: [],
        userIds: input.mentionedUserIds,
        authorUserId: authorId,
      })

      const postId = await deps.repo.createPost({
        authorId,
        kind: input.kind,
        body: input.body ?? null,
        replyToId: input.replyToId ?? null,
        repostOfId: input.repostOfId ?? null,
        eventId: input.eventId ?? null,
        reportId: input.reportId ?? null,
        mediaUploadIds: input.mediaUploadIds,
        mentionedUserIds: mentions.map((m) => m.id),
      })

      // --- notifications (best-effort) ---
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
      await requireReadable(postId, viewerId)
      return deps.repo.listReplies(postId, {
        viewerId,
        cursor: pagination.cursor ?? null,
        limit: pagination.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },

    async likePost(id: string, viewerId: string): Promise<PostDTO> {
      const brief = await requireReadable(id, viewerId)
      const created = await deps.repo.like(id, viewerId)
      if (created && (await shouldNotify(viewerId, brief.authorId))) {
        const actorName = await deps.repo.actorNameOf(viewerId)
        await safeNotify(() =>
          deps.notifier!.onPostLike({ recipientId: brief.authorId, actorName, postId: id }),
        )
      }
      return hydrateOrThrow(id, viewerId)
    },

    async unlikePost(id: string, viewerId: string): Promise<PostDTO> {
      await requireReadable(id, viewerId)
      await deps.repo.unlike(id, viewerId)
      return hydrateOrThrow(id, viewerId)
    },

    async savePost(id: string, viewerId: string): Promise<PostDTO> {
      await requireReadable(id, viewerId)
      await deps.repo.save(id, viewerId)
      return hydrateOrThrow(id, viewerId)
    },

    async unsavePost(id: string, viewerId: string): Promise<PostDTO> {
      await requireReadable(id, viewerId)
      await deps.repo.unsave(id, viewerId)
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
