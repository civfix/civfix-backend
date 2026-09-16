
import {
  AppError,
  DEFAULT_FEED_RANKING,
  formatFeedScoreCursor,
  isAfterFeedScoreCursor,
  parseFeedScoreCursor,
} from "@civfix/shared"
import type {
  FeedCountsResponse,
  FeedRankingConfig,
  HomeFeedQuery,
  PaginationQuery,
  PostComposeInput,
  PostDTO,
} from "@civfix/shared"
import type { UserChannel } from "@civfix/shared/interfaces"
import type { Sql } from "../db/client.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { resolveMentionTargets } from "./mention-resolver.drizzle.js"
import { parseTimeCursor } from "../db/cursor-helpers.js"
import {
  NIL_VIEWER_ID,
  POSTS_DEFAULT_LIMIT,
  type FeedCandidateRow,
  type FeedPage,
  type PostBrief,
  type PostRepository,
  type RepliesPage,
} from "./post-repository.drizzle.js"
import { applyCutoff, rankCandidates, type FeedCandidate } from "./feed-ranking.js"
import type { FeedPresence } from "./feed-presence.js"
import type { PostNotifier } from "./notification-service.js"

function isVisible(brief: PostBrief): boolean {
  return brief.deletedAt === null && brief.visibility === "public"
}

function isLegacyTimeCursor(cursor: string | null | undefined): boolean {
  if (cursor === null || cursor === undefined || cursor === "") return false
  if (parseFeedScoreCursor(cursor) !== null) return false
  return parseTimeCursor(cursor) !== null
}

export interface FeedViewerLocation {
  lat: number
  lng: number
}

export interface PostServiceDeps {
  repo: PostRepository
  sql: Sql
  notifier?: PostNotifier
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
  logger?: { warn(obj: unknown, msg: string): void }
  feedRanking?: FeedRankingConfig
  feedPresence?: FeedPresence
  userChannel?: UserChannel
  now?: () => number
}

export interface PostService {
  createPost(input: PostComposeInput, authorId: string): Promise<PostDTO>
  getPost(id: string, viewerId: string): Promise<PostDTO>
  deletePost(id: string, viewerId: string): Promise<{ ok: true }>
  listReplies(postId: string, viewerId: string, pagination: PaginationQuery): Promise<RepliesPage>
  likePost(id: string, viewerId: string): Promise<PostDTO>
  unlikePost(id: string, viewerId: string): Promise<PostDTO>
  savePost(id: string, viewerId: string): Promise<PostDTO>
  unsavePost(id: string, viewerId: string): Promise<PostDTO>
  repostPost(id: string, viewerId: string): Promise<PostDTO>
  unrepostPost(id: string, viewerId: string): Promise<PostDTO>
  homeFeed(
    viewerId: string,
    query: HomeFeedQuery,
    location?: FeedViewerLocation,
  ): Promise<FeedPage>
  publicFeed(query: HomeFeedQuery, location?: FeedViewerLocation): Promise<FeedPage>
  getFeedCounts(postIds: readonly string[], viewerId: string): Promise<FeedCountsResponse>
  listUserPosts(authorId: string, viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
  listSaves(viewerId: string, pagination: PaginationQuery): Promise<FeedPage>
}

export function makePostService(deps: PostServiceDeps): PostService {
  const isBlocked = deps.isBlockedEitherWay ?? (() => Promise.resolve(false))
  const feedConfig = deps.feedRanking ?? DEFAULT_FEED_RANKING
  const nowMs = deps.now ?? (() => Date.now())

  function fanout(recipients: readonly string[], topic: "feed" | "feed_counts", id: string): void {
    const channel = deps.userChannel
    if (channel === undefined || recipients.length === 0) return
    void channel.publishToUsers(recipients, { topic, id }).catch((err: unknown) => {
      deps.logger?.warn({ err, topic, id }, "post: realtime feed fanout failed (suppressed)")
    })
  }

  async function announceNewPost(postId: string, authorId: string): Promise<void> {
    if (deps.userChannel === undefined) return
    try {
      const followers = await deps.repo.followerIdsOf(authorId, feedConfig.newPostFanoutMax)
      fanout(followers, "feed", postId)
    } catch (err) {
      deps.logger?.warn({ err, postId }, "post: new-post fanout lookup failed (suppressed)")
    }
  }

  async function announceCountChange(postId: string, actorId: string): Promise<void> {
    if (deps.userChannel === undefined || deps.feedPresence === undefined) return
    try {
      const viewers = await deps.feedPresence.viewersOf(postId)
      fanout(
        viewers.filter((viewerId) => viewerId !== actorId),
        "feed_counts",
        postId,
      )
    } catch (err) {
      deps.logger?.warn({ err, postId }, "post: count fanout lookup failed (suppressed)")
    }
  }

  function toCandidate(row: FeedCandidateRow, seen: ReadonlySet<string>): FeedCandidate {
    return {
      id: row.id,
      authorId: row.author_id,
      createdAtMs: row.created_at.getTime(),
      likeCount: Number(row.like_count),
      replyCount: Number(row.reply_count),
      repostCount: Number(row.repost_count),
      hasMedia: row.has_media,
      hasReport: row.has_report,
      hasLiveEvent: row.has_live_event,
      authorFollowed: row.author_followed,
      authorIsViewer: row.author_is_viewer,
      viewerMentioned: row.viewer_mentioned,
      authorOrgVerified: row.author_org_verified,
      distanceKm: row.distance_km === null ? null : Number(row.distance_km),
      alreadySeen: seen.has(row.id),
    }
  }

  async function pageFrom(
    viewerId: string,
    entries: readonly { id: string; score: number }[],
    limit: number,
  ): Promise<FeedPage> {
    const pageEntries = entries.slice(0, limit)
    const hasMore = entries.length > pageEntries.length
    const last = pageEntries[pageEntries.length - 1]
    const nextCursor =
      hasMore && last !== undefined
        ? formatFeedScoreCursor({ score: last.score, postId: last.id })
        : null

    const items = await deps.repo.hydrateByIds(
      pageEntries.map((entry) => entry.id),
      viewerId,
    )

    if (deps.feedPresence !== undefined) {
      void deps.feedPresence.recordServed(
        viewerId,
        items.map((item) => item.id),
      )
    }

    return { items, nextCursor }
  }

  function continueFromSnapshot(
    viewerId: string,
    snapshot: readonly { id: string; score: number }[],
    cursor: { score: number; postId: string },
    limit: number,
  ): Promise<FeedPage> {
    const after = snapshot.filter((entry) =>
      isAfterFeedScoreCursor({ score: entry.score, postId: entry.id }, cursor),
    )
    return pageFrom(viewerId, after, limit)
  }

  async function rankedFeed(
    viewerId: string,
    query: HomeFeedQuery,
    location: FeedViewerLocation | undefined,
  ): Promise<FeedPage> {
    const limit = query.limit ?? POSTS_DEFAULT_LIMIT
    const cursor = parseFeedScoreCursor(query.cursor)
    const isFirstPage = cursor === null

    if (cursor !== null && deps.feedPresence !== undefined) {
      const snapshot = await deps.feedPresence.readSnapshot(viewerId, query.filter)
      if (snapshot !== null) {
        return continueFromSnapshot(viewerId, snapshot, cursor, limit)
      }
    }

    const rows = await deps.repo.feedCandidates({
      viewerId,
      filter: query.filter,
      fallbackLat: location?.lat ?? null,
      fallbackLng: location?.lng ?? null,
      windowDays: feedConfig.candidateWindowDays,
      radiusKm: feedConfig.nearbyRadiusKm,
      candidateCap: feedConfig.candidateCap,
    })

    const seen =
      deps.feedPresence === undefined
        ? new Set<string>()
        : await deps.feedPresence.seenBy(
            viewerId,
            rows.map((r) => r.id),
          )

    const ranked = rankCandidates(
      rows.map((row) => toCandidate(row, seen)),
      feedConfig,
      nowMs(),
    )
    const kept = applyCutoff(ranked, feedConfig, isFirstPage)
    const after =
      cursor === null
        ? kept
        : kept.filter((entry) =>
            isAfterFeedScoreCursor({ score: entry.score, postId: entry.id }, cursor),
          )

    if (isFirstPage && deps.feedPresence !== undefined) {
      void deps.feedPresence.writeSnapshot(viewerId, query.filter, ranked)
    }

    return pageFrom(viewerId, after, limit)
  }

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
    if (!brief || !isVisible(brief) || (await isBlocked(viewerId, brief.authorId))) {
      throw AppError.notFound("Post not found")
    }
    if (brief.repostOfId) {
      const target = await deps.repo.getPostBrief(brief.repostOfId)
      if (!target || !isVisible(target) || (await isBlocked(viewerId, target.authorId))) {
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
      if (input.organizationId !== undefined) {
        if (!(await deps.repo.canPostAsOrganization(input.organizationId, authorId))) {
          throw AppError.forbidden("You can only post as an organization you belong to.")
        }
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
        organizationId: input.organizationId ?? null,
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

      if (kind === "post" || kind === "quote") {
        await announceNewPost(postId, authorId)
      }
      if (replyParentAuthor !== null) {
        await announceCountChange(input.replyToId!, authorId)
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
    ): Promise<RepliesPage> {
      const subject = await requireReadable(postId, viewerId)
      return deps.repo.listReplies(subject.id, {
        viewerId,
        focalAuthorId: subject.authorId,
        cursor: pagination.cursor ?? null,
        limit: pagination.limit ?? POSTS_DEFAULT_LIMIT,
      })
    },

    async likePost(id: string, viewerId: string): Promise<PostDTO> {
      const subject = await requireReadable(id, viewerId)
      const created = await deps.repo.like(subject.id, viewerId)
      if (created) await announceCountChange(subject.id, viewerId)
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
      const removed = await deps.repo.unlike(subject.id, viewerId)
      if (removed) await announceCountChange(subject.id, viewerId)
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
      const subject = await requireReadable(id, viewerId)
      if (subject.authorId === viewerId) {
        throw AppError.validation({ id: "You cannot repost your own post." })
      }
      const { targetId, created } = await deps.repo.repost(id, viewerId)
      if (created) await announceCountChange(targetId, viewerId)
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
      const { targetId, removed } = await deps.repo.unrepost(id, viewerId)
      if (removed) await announceCountChange(targetId, viewerId)
      return hydrateOrThrow(targetId, viewerId)
    },

    async homeFeed(
      viewerId: string,
      query: HomeFeedQuery,
      location?: FeedViewerLocation,
    ): Promise<FeedPage> {
      if (isLegacyTimeCursor(query.cursor)) {
        return deps.repo.homeFeedChronological({
          viewerId,
          filter: query.filter,
          cursor: query.cursor ?? null,
          limit: query.limit ?? POSTS_DEFAULT_LIMIT,
        })
      }
      return rankedFeed(viewerId, query, location)
    },

    async publicFeed(query: HomeFeedQuery, location?: FeedViewerLocation): Promise<FeedPage> {
      if (isLegacyTimeCursor(query.cursor)) {
        return deps.repo.publicFeed({
          filter: query.filter,
          cursor: query.cursor ?? null,
          limit: query.limit ?? POSTS_DEFAULT_LIMIT,
        })
      }
      return rankedFeed(NIL_VIEWER_ID, query, location)
    },

    async getFeedCounts(
      postIds: readonly string[],
      viewerId: string,
    ): Promise<FeedCountsResponse> {
      const unique = [...new Set(postIds)]
      if (unique.length === 0) return { items: [] }
      const rows = await deps.repo.readableCounts(unique, viewerId)
      return {
        items: rows.map((row) => ({
          id: row.id,
          counts: {
            likes: Number(row.like_count),
            reposts: Number(row.repost_count),
            replies: Number(row.reply_count),
            saves: Number(row.save_count),
          },
        })),
      }
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
