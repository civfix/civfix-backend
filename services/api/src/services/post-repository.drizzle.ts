/**
 * Postgres-backed PostRepository: all SQL for the social-feed posts feature.
 *
 * Repost / quote / reply are `posts` rows disambiguated by `kind` (+ repost_of_id / reply_to_id), so
 * the home timeline is one keyset scan. Interaction toggles (like / save / repost) insert-or-delete the
 * thin interaction row AND bump the denormalized posts.<x>_count IN THE SAME txn (precedent:
 * cleanups.bags, report chat counts). Post media reuses media_assets (post_id + purpose='post');
 * @-mentions reuse the table-parameterized makeMentionRepo(sql,'post_mentions'). Hydration joins the
 * author PersonDTO, the LinkedEventRef / LinkedReportRef attachment cards, media, mentions, the
 * repost/quote target preview (PostRefDTO), and the viewer's {liked,reposted,saved} flags.
 *
 * Written against the raw postgres-js tag (`Sql`), matching report-repository.drizzle.ts /
 * social-repository.drizzle.ts / chat-reactions.drizzle.ts.
 */

import { AppError, avatarGradient } from "@civfix/shared"
import type {
  LinkedEventRef,
  LinkedReportRef,
  MediaDTO,
  PersonDTO,
  PostDTO,
  PostRefDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { Queryable, Sql } from "../db/client.js"
import type { POST_KIND_VALUES } from "../db/schema/types.js"
import { encodeTimeCursor, parseTimeCursor } from "../db/cursor-helpers.js"
import { loadMentionsFor, makeMentionRepo } from "./message-mentions.drizzle.js"
import { mapWithLimit, PRESIGN_CONCURRENCY, type PresignMedia } from "./media-presign.js"

type PostKind = (typeof POST_KIND_VALUES)[number]

/** Default page size when a list request omits `limit` (shared caps `limit` at 50). */
export const POSTS_DEFAULT_LIMIT = 20

/**
 * The nil UUID used as the "viewer" when hydrating the PUBLIC feed for a signed-out reader. No user row
 * carries the nil id, so every viewer-scoped subquery (likes / saves / reposts / is_following) matches
 * nothing and returns false — the correct not-signed-in viewer state — without threading a nullable
 * viewer through hydrate/pageOf.
 */
export const NIL_VIEWER_ID = "00000000-0000-0000-0000-000000000000"

export interface CreatePostArgs {
  authorId: string
  kind: PostKind // 'post' | 'quote' | 'reply' (a pure repost uses repost(), not this)
  body: string | null
  replyToId: string | null // set for kind='reply'
  repostOfId: string | null // set for kind='quote'
  eventId: string | null
  reportId: string | null
  mediaUploadIds: string[]
  mentionedUserIds: string[] // already resolved, deduped, self-excluded by the caller
}

/** Minimal shape used for authorization + notification targeting (no hydration). */
export interface PostBrief {
  id: string
  authorId: string
  kind: PostKind
  replyToId: string | null
  repostOfId: string | null
  deletedAt: Date | null
}

export interface FeedPage {
  items: PostDTO[]
  nextCursor: string | null
}

export interface PostListArgs {
  viewerId: string
  cursor: string | null
  limit: number
}

export interface HomeFeedArgs extends PostListArgs {
  filter: "all" | "events" | "fixes"
}

/** The public/global feed (signed-out viewers): no personal viewer, so no follow scope + no viewer flags. */
export interface PublicFeedArgs {
  filter: "all" | "events" | "fixes"
  cursor: string | null
  limit: number
}

export interface PostRepository {
  getPostBrief(id: string): Promise<PostBrief | null>
  actorNameOf(userId: string): Promise<string>
  isEventMember(eventId: string, userId: string): Promise<boolean>
  isReportAttachable(reportId: string): Promise<boolean>

  createPost(args: CreatePostArgs): Promise<string>
  softDeletePost(postId: string): Promise<void>

  like(postId: string, userId: string): Promise<boolean>
  unlike(postId: string, userId: string): Promise<boolean>
  save(postId: string, userId: string): Promise<boolean>
  unsave(postId: string, userId: string): Promise<boolean>
  /** Resolve to the ORIGINAL target (walking a pure-repost chain) and toggle a repost row. */
  repost(postId: string, userId: string): Promise<{ targetId: string; created: boolean }>
  unrepost(postId: string, userId: string): Promise<{ targetId: string; removed: boolean }>

  getPostDTO(id: string, viewerId: string): Promise<PostDTO | null>
  homeFeed(args: HomeFeedArgs): Promise<FeedPage>
  publicFeed(args: PublicFeedArgs): Promise<FeedPage>
  listReplies(postId: string, args: PostListArgs): Promise<FeedPage>
  listUserPosts(authorId: string, args: PostListArgs): Promise<FeedPage>
  listSaves(args: PostListArgs): Promise<FeedPage>
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PostRowSelect {
  id: string
  author_id: string
  kind: PostKind
  body: string | null
  reply_to_id: string | null
  thread_root_id: string | null
  repost_of_id: string | null
  event_id: string | null
  report_id: string | null
  like_count: number
  repost_count: number
  reply_count: number
  save_count: number
  created_at: Date
  updated_at: Date
}

interface AuthorRow {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  verified: boolean
  avatar_r2_key: string | null
  avatar_url: string | null
  is_following: boolean
}

interface EventRow {
  id: string
  title: string
  event_kind: LinkedEventRef["eventKind"]
  status: LinkedEventRef["status"]
  scheduled_at: Date
  lat: number
  lng: number
  going: number
  org_id: string
  org_name: string
  org_handle: string | null
  org_bio: string | null
  org_verified: boolean
  org_avatar_url: string | null
}

interface ReportRow {
  id: string
  category: LinkedReportRef["category"]
  type: LinkedReportRef["type"]
  title: string | null
  status: LinkedReportRef["status"]
  lat: number
  lng: number
  addr: string | null
  thumb_key: string | null
  thumb_r2_key: string | null
}

interface RefRow {
  id: string
  kind: PostKind
  body: string | null
  event_id: string | null
  report_id: string | null
  created_at: Date
  deleted_at: Date | null
  author_id: string | null
  display_name: string | null
  handle: string | null
  bio: string | null
  verified: boolean | null
  avatar_url: string | null
}

interface MediaRow {
  post_id: string
  id: string
  kind: MediaDTO["kind"]
  codec: string | null
  r2_key: string
  thumb_key: string | null
  status: MediaDTO["status"]
  width: number | null
  height: number | null
}

export interface PostRepoDeps {
  presignMedia: PresignMedia
  presignAvatar: (r2Key: string) => Promise<string>
}

function nameFrom(displayName: string | null, handle: string | null): string {
  if (displayName && displayName.trim() !== "") return displayName
  if (handle) return `@${handle}`
  return "Someone"
}

function excerptOf(body: string | null, hasEvent: boolean, hasReport: boolean): string {
  if (body && body.trim() !== "") return body.slice(0, 140)
  if (hasEvent) return "Shared an event"
  if (hasReport) return "Shared a report"
  return ""
}

export function makeDrizzlePostRepository(sql: Sql, deps: PostRepoDeps): PostRepository {
  // -- author PersonDTO ------------------------------------------------------
  async function loadAuthors(
    ids: string[],
    viewerId: string,
  ): Promise<Map<string, PersonDTO>> {
    const out = new Map<string, PersonDTO>()
    if (ids.length === 0) return out
    const rows = await sql<AuthorRow[]>`
      SELECT
        u.id,
        u.display_name,
        u.handle,
        u.bio,
        (SELECT count(*)::int FROM follows_people f WHERE f.followee_id = u.id) AS followers,
        (SELECT count(*)::int FROM follows_people f WHERE f.follower_id = u.id) AS following,
        EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
        am.r2_key AS avatar_r2_key,
        u.avatar_url,
        EXISTS (
          SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id
        ) AS is_following
      FROM users u
      LEFT JOIN media_assets am ON am.id = u.avatar_media_id
      WHERE u.id = ANY(${ids}::uuid[])
    `
    const resolved = await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (r) => {
      const avatarUrl = r.avatar_r2_key !== null ? await deps.presignAvatar(r.avatar_r2_key) : r.avatar_url
      const dto: PersonDTO = {
        id: r.id,
        name: r.display_name,
        handle: r.handle,
        bio: r.bio,
        avatar: avatarGradient(r.id),
        ...(avatarUrl !== null ? { avatarUrl } : {}),
        followers: Number(r.followers),
        following: Number(r.following),
        isFollowing: r.is_following,
        ...(r.verified ? { verified: true } : {}),
      }
      return dto
    })
    for (const dto of resolved) out.set(dto.id, dto)
    return out
  }

  // -- attachment cards ------------------------------------------------------
  async function loadEvents(ids: string[]): Promise<Map<string, Omit<LinkedEventRef, "linkedAt">>> {
    const out = new Map<string, Omit<LinkedEventRef, "linkedAt">>()
    if (ids.length === 0) return out
    const rows = await sql<EventRow[]>`
      SELECT
        c.id,
        c.title,
        c.event_kind,
        c.status,
        c.scheduled_at,
        ST_Y(c.geom) AS lat,
        ST_X(c.geom) AS lng,
        (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id) AS going,
        u.id AS org_id,
        u.display_name AS org_name,
        u.handle AS org_handle,
        u.bio AS org_bio,
        EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS org_verified,
        u.avatar_url AS org_avatar_url
      FROM cleanups c
      JOIN users u ON u.id = c.organizer_user_id
      WHERE c.id = ANY(${ids}::uuid[])
    `
    for (const r of rows) {
      const organizer: PersonDTO = {
        id: r.org_id,
        name: r.org_name,
        handle: r.org_handle,
        bio: r.org_bio,
        avatar: avatarGradient(r.org_id),
        ...(r.org_avatar_url !== null ? { avatarUrl: r.org_avatar_url } : {}),
        followers: 0,
        following: 0,
        isFollowing: false,
        ...(r.org_verified ? { verified: true } : {}),
      }
      out.set(r.id, {
        id: r.id,
        title: r.title,
        eventKind: r.event_kind,
        status: r.status,
        scheduledAt: r.scheduled_at.toISOString(),
        lat: r.lat,
        lng: r.lng,
        going: Number(r.going),
        organizer,
      })
    }
    return out
  }

  async function loadReports(ids: string[]): Promise<Map<string, Omit<LinkedReportRef, "linkedAt">>> {
    const out = new Map<string, Omit<LinkedReportRef, "linkedAt">>()
    if (ids.length === 0) return out
    const rows = await sql<ReportRow[]>`
      SELECT
        r.id,
        r.category,
        r.type,
        r.title,
        r.status,
        ST_Y(r.geom) AS lat,
        ST_X(r.geom) AS lng,
        r.addr,
        ma.thumb_key,
        ma.r2_key AS thumb_r2_key
      FROM reports r
      LEFT JOIN LATERAL (
        SELECT thumb_key, r2_key FROM media_assets m
        WHERE m.report_id = r.id AND m.status = 'ready'
        ORDER BY m.created_at ASC LIMIT 1
      ) ma ON TRUE
      WHERE r.id = ANY(${ids}::uuid[]) AND r.deleted_at IS NULL
    `
    const resolved = await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (r) => {
      let thumbUrl: string | null = null
      if (r.thumb_key !== null) {
        const { thumbUrl: t, url } = await deps.presignMedia(r.thumb_r2_key ?? "", r.thumb_key)
        thumbUrl = t ?? url
      } else if (r.thumb_r2_key !== null) {
        const { url } = await deps.presignMedia(r.thumb_r2_key, null)
        thumbUrl = url
      }
      const ref: Omit<LinkedReportRef, "linkedAt"> = {
        id: r.id,
        category: r.category,
        ...(r.type !== null ? { type: r.type } : {}),
        title: r.title ?? "Report",
        status: r.status,
        lat: r.lat,
        lng: r.lng,
        ...(r.addr !== null ? { addr: r.addr } : {}),
        ...(thumbUrl !== null ? { thumbUrl } : {}),
      }
      return ref
    })
    for (const ref of resolved) out.set(ref.id, ref)
    return out
  }

  // -- repost/quote target preview -------------------------------------------
  async function loadRefs(ids: string[], viewerId: string): Promise<Map<string, PostRefDTO>> {
    const out = new Map<string, PostRefDTO>()
    if (ids.length === 0) return out
    const rows = await sql<RefRow[]>`
      SELECT
        p.id, p.kind, p.body, p.event_id, p.report_id, p.created_at, p.deleted_at,
        u.id AS author_id, u.display_name, u.handle, u.bio, u.avatar_url,
        EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified
      FROM posts p
      LEFT JOIN users u ON u.id = p.author_id AND u.deleted_at IS NULL
      WHERE p.id = ANY(${ids}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = p.author_id)
             OR (b.blocker_id = p.author_id AND b.blocked_id = ${viewerId})
        )
    `
    for (const r of rows) {
      const deleted = r.deleted_at !== null
      const author: PersonDTO | null =
        r.author_id !== null && !deleted
          ? {
              id: r.author_id,
              name: r.display_name ?? "",
              handle: r.handle,
              bio: r.bio,
              avatar: avatarGradient(r.author_id),
              ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
              followers: 0,
              following: 0,
              isFollowing: false,
              ...(r.verified ? { verified: true } : {}),
            }
          : null
      out.set(r.id, {
        id: r.id,
        author,
        kind: r.kind,
        excerpt: deleted ? "" : excerptOf(r.body, r.event_id !== null, r.report_id !== null),
        createdAt: r.created_at.toISOString(),
        ...(deleted ? { deleted: true } : {}),
      })
    }
    return out
  }

  // -- media -----------------------------------------------------------------
  async function loadMedia(ids: string[]): Promise<Map<string, MediaDTO[]>> {
    const out = new Map<string, MediaDTO[]>()
    if (ids.length === 0) return out
    const rows = await sql<MediaRow[]>`
      SELECT post_id, id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE post_id = ANY(${ids}::uuid[]) AND status = 'ready'
      ORDER BY post_id, created_at ASC
    `
    const projected = await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (r) => {
      const { url, thumbUrl } = await deps.presignMedia(r.r2_key, r.thumb_key)
      const dto: MediaDTO = {
        id: r.id,
        kind: r.kind,
        codec: r.codec,
        url,
        ...(thumbUrl !== undefined ? { thumbUrl } : {}),
        width: r.width,
        height: r.height,
        status: r.status,
      }
      return { postId: r.post_id, dto }
    })
    for (const { postId, dto } of projected) {
      const list = out.get(postId)
      if (list) list.push(dto)
      else out.set(postId, [dto])
    }
    return out
  }

  // -- viewer interaction flags ----------------------------------------------
  async function loadViewerFlags(
    rows: PostRowSelect[],
    viewerId: string,
  ): Promise<{ liked: Set<string>; saved: Set<string>; repostedTargets: Set<string> }> {
    const ids = rows.map((r) => r.id)
    // A repost row's "reposted" flag reflects the ORIGINAL target; other rows use their own id.
    const targetIds = rows.map((r) => (r.kind === "repost" && r.repost_of_id ? r.repost_of_id : r.id))
    const liked = new Set<string>()
    const saved = new Set<string>()
    const repostedTargets = new Set<string>()
    if (ids.length === 0) return { liked, saved, repostedTargets }
    const [likeRows, saveRows, repostRows] = await Promise.all([
      sql<{ post_id: string }[]>`
        SELECT post_id FROM post_likes WHERE user_id = ${viewerId} AND post_id = ANY(${ids}::uuid[])
      `,
      sql<{ post_id: string }[]>`
        SELECT post_id FROM post_saves WHERE user_id = ${viewerId} AND post_id = ANY(${ids}::uuid[])
      `,
      sql<{ repost_of_id: string }[]>`
        SELECT repost_of_id FROM posts
        WHERE kind = 'repost' AND author_id = ${viewerId}
          AND repost_of_id = ANY(${targetIds}::uuid[]) AND deleted_at IS NULL
      `,
    ])
    for (const r of likeRows) liked.add(r.post_id)
    for (const r of saveRows) saved.add(r.post_id)
    for (const r of repostRows) repostedTargets.add(r.repost_of_id)
    return { liked, saved, repostedTargets }
  }

  // -- hydrate rows -> PostDTO[] ---------------------------------------------
  async function hydrate(rows: PostRowSelect[], viewerId: string): Promise<PostDTO[]> {
    if (rows.length === 0) return []
    const postIds = rows.map((r) => r.id)
    const authorIds = [...new Set(rows.map((r) => r.author_id))]
    const eventIds = [...new Set(rows.map((r) => r.event_id).filter((x): x is string => x !== null))]
    const reportIds = [...new Set(rows.map((r) => r.report_id).filter((x): x is string => x !== null))]
    const refIds = [...new Set(rows.map((r) => r.repost_of_id).filter((x): x is string => x !== null))]

    const [authors, media, mentions, events, reports, refs, flags] = await Promise.all([
      loadAuthors(authorIds, viewerId),
      loadMedia(postIds),
      loadMentionsFor(sql, "post_mentions", postIds, "post_id"),
      loadEvents(eventIds),
      loadReports(reportIds),
      loadRefs(refIds, viewerId),
      loadViewerFlags(rows, viewerId),
    ])

    const out: PostDTO[] = []
    for (const r of rows) {
      const author = authors.get(r.author_id)
      if (!author) continue // author soft-deleted between select + hydrate: drop the row
      const targetId = r.kind === "repost" && r.repost_of_id ? r.repost_of_id : r.id
      const editedAt = r.updated_at.getTime() > r.created_at.getTime() ? r.updated_at.toISOString() : null
      const eventBase = r.event_id !== null ? events.get(r.event_id) : undefined
      const reportBase = r.report_id !== null ? reports.get(r.report_id) : undefined
      const repostOf = r.repost_of_id !== null ? (refs.get(r.repost_of_id) ?? null) : null
      const postMentions: UserMentionDTO[] = mentions.get(r.id) ?? []
      const dto: PostDTO = {
        id: r.id,
        author,
        kind: r.kind,
        body: r.body,
        createdAt: r.created_at.toISOString(),
        editedAt,
        counts: {
          likes: Number(r.like_count),
          reposts: Number(r.repost_count),
          replies: Number(r.reply_count),
          saves: Number(r.save_count),
        },
        viewer: {
          liked: flags.liked.has(r.id),
          reposted: flags.repostedTargets.has(targetId),
          saved: flags.saved.has(r.id),
        },
        media: media.get(r.id) ?? [],
        mentions: postMentions,
        event: eventBase ? { ...eventBase, linkedAt: r.created_at.toISOString() } : null,
        report: reportBase ? { ...reportBase, linkedAt: r.created_at.toISOString() } : null,
        repostOf,
        replyToId: r.reply_to_id,
        threadRootId: r.thread_root_id,
      }
      out.push(dto)
    }
    return out
  }

  async function pageOf(rows: PostRowSelect[], limit: number, viewerId: string): Promise<FeedPage> {
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = await hydrate(pageRows, viewerId)
    const last = pageRows[pageRows.length - 1]
    const nextCursor = hasMore && last ? encodeTimeCursor({ at: last.created_at, id: last.id }) : null
    return { items, nextCursor }
  }

  async function resolveOriginalTarget(tx: Queryable, postId: string): Promise<string | null> {
    const rows = await tx<{ id: string; kind: PostKind; repost_of_id: string | null }[]>`
      SELECT id, kind, repost_of_id FROM posts WHERE id = ${postId} AND deleted_at IS NULL
    `
    const row = rows[0]
    if (!row) return null
    // A pure repost is not content of its own — reposting it targets the ORIGINAL (walk repost_of_id).
    if (row.kind === "repost" && row.repost_of_id) return row.repost_of_id
    return row.id
  }

  return {
    async getPostBrief(id: string): Promise<PostBrief | null> {
      const rows = await sql<
        {
          id: string
          author_id: string
          kind: PostKind
          reply_to_id: string | null
          repost_of_id: string | null
          deleted_at: Date | null
        }[]
      >`
        SELECT id, author_id, kind, reply_to_id, repost_of_id, deleted_at FROM posts WHERE id = ${id}
      `
      const r = rows[0]
      if (!r) return null
      return {
        id: r.id,
        authorId: r.author_id,
        kind: r.kind,
        replyToId: r.reply_to_id,
        repostOfId: r.repost_of_id,
        deletedAt: r.deleted_at,
      }
    },

    async actorNameOf(userId: string): Promise<string> {
      const rows = await sql<{ display_name: string; handle: string | null }[]>`
        SELECT display_name, handle FROM users WHERE id = ${userId} LIMIT 1
      `
      const r = rows[0]
      return r ? nameFrom(r.display_name, r.handle) : "Someone"
    },

    async isEventMember(eventId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanups c
        WHERE c.id = ${eventId}
          AND (
            c.organizer_user_id = ${userId}
            OR EXISTS (SELECT 1 FROM cleanup_members m WHERE m.cleanup_id = c.id AND m.user_id = ${userId})
          )
        LIMIT 1
      `
      return rows.length > 0
    },

    async isReportAttachable(reportId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM reports
        WHERE id = ${reportId} AND deleted_at IS NULL AND visibility = 'public'
        LIMIT 1
      `
      return rows.length > 0
    },

    async createPost(args: CreatePostArgs): Promise<string> {
      return sql.begin(async (tx) => {
        let threadRootId: string | null = null
        if (args.kind === "reply" && args.replyToId !== null) {
          const parentRows = await tx<{ id: string; thread_root_id: string | null }[]>`
            SELECT id, thread_root_id FROM posts WHERE id = ${args.replyToId}
          `
          const parent = parentRows[0]
          threadRootId = parent?.thread_root_id ?? parent?.id ?? null
        }
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO posts (author_id, kind, body, reply_to_id, thread_root_id, repost_of_id, event_id, report_id)
          VALUES (
            ${args.authorId}, ${args.kind}, ${args.body}, ${args.replyToId}, ${threadRootId},
            ${args.repostOfId}, ${args.eventId}, ${args.reportId}
          )
          RETURNING id
        `
        const postId = inserted[0]!.id

        if (args.mediaUploadIds.length > 0) {
          // Capability-based claim (knowing the unguessable uploadId is the proof): only finalize uploads
          // that are not already bound to a report / chat message / another post.
          const claimed = await tx<{ upload_id: string }[]>`
            UPDATE media_assets
            SET post_id = ${postId}, purpose = 'post'
            WHERE upload_id IN ${tx(args.mediaUploadIds)}
              AND post_id IS NULL AND chat_message_id IS NULL AND report_id IS NULL
              AND status IN ('ready', 'validating')
            RETURNING upload_id
          `
          if (claimed.length !== new Set(args.mediaUploadIds).size) {
            throw AppError.validation({ mediaUploadIds: "One or more media uploads are unavailable." })
          }
        }

        if (args.mentionedUserIds.length > 0) {
          await makeMentionRepo(sql, "post_mentions", "post_id").recordFor(
            tx,
            postId,
            args.mentionedUserIds,
          )
        }

        if (args.kind === "reply" && args.replyToId !== null) {
          await tx`UPDATE posts SET reply_count = reply_count + 1 WHERE id = ${args.replyToId}`
        }

        return postId
      })
    },

    async softDeletePost(postId: string): Promise<void> {
      await sql.begin(async (tx) => {
        const rows = await tx<
          { kind: PostKind; reply_to_id: string | null; repost_of_id: string | null }[]
        >`
          UPDATE posts SET deleted_at = now() WHERE id = ${postId} AND deleted_at IS NULL
          RETURNING kind, reply_to_id, repost_of_id
        `
        const row = rows[0]
        if (!row) return
        if (row.reply_to_id !== null) {
          await tx`UPDATE posts SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = ${row.reply_to_id}`
        }
        if (row.kind === "repost" && row.repost_of_id !== null) {
          await tx`UPDATE posts SET repost_count = GREATEST(repost_count - 1, 0) WHERE id = ${row.repost_of_id}`
        }
      })
    },

    async like(postId: string, userId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const ins = await tx<{ post_id: string }[]>`
          INSERT INTO post_likes (post_id, user_id) VALUES (${postId}, ${userId})
          ON CONFLICT (post_id, user_id) DO NOTHING
          RETURNING post_id
        `
        if (ins.length === 0) return false
        await tx`UPDATE posts SET like_count = like_count + 1 WHERE id = ${postId}`
        return true
      })
    },

    async unlike(postId: string, userId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const del = await tx<{ post_id: string }[]>`
          DELETE FROM post_likes WHERE post_id = ${postId} AND user_id = ${userId} RETURNING post_id
        `
        if (del.length === 0) return false
        await tx`UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = ${postId}`
        return true
      })
    },

    async save(postId: string, userId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const ins = await tx<{ post_id: string }[]>`
          INSERT INTO post_saves (post_id, user_id) VALUES (${postId}, ${userId})
          ON CONFLICT (post_id, user_id) DO NOTHING
          RETURNING post_id
        `
        if (ins.length === 0) return false
        await tx`UPDATE posts SET save_count = save_count + 1 WHERE id = ${postId}`
        return true
      })
    },

    async unsave(postId: string, userId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const del = await tx<{ post_id: string }[]>`
          DELETE FROM post_saves WHERE post_id = ${postId} AND user_id = ${userId} RETURNING post_id
        `
        if (del.length === 0) return false
        await tx`UPDATE posts SET save_count = GREATEST(save_count - 1, 0) WHERE id = ${postId}`
        return true
      })
    },

    async repost(postId: string, userId: string): Promise<{ targetId: string; created: boolean }> {
      return sql.begin(async (tx) => {
        const targetId = await resolveOriginalTarget(tx, postId)
        if (targetId === null) return { targetId: postId, created: false }
        const ins = await tx<{ id: string }[]>`
          INSERT INTO posts (author_id, kind, repost_of_id) VALUES (${userId}, 'repost', ${targetId})
          ON CONFLICT (author_id, repost_of_id) WHERE kind = 'repost' DO NOTHING
          RETURNING id
        `
        if (ins.length === 0) return { targetId, created: false }
        await tx`UPDATE posts SET repost_count = repost_count + 1 WHERE id = ${targetId}`
        return { targetId, created: true }
      })
    },

    async unrepost(postId: string, userId: string): Promise<{ targetId: string; removed: boolean }> {
      return sql.begin(async (tx) => {
        const targetId = await resolveOriginalTarget(tx, postId)
        if (targetId === null) return { targetId: postId, removed: false }
        const del = await tx<{ id: string }[]>`
          DELETE FROM posts
          WHERE author_id = ${userId} AND kind = 'repost' AND repost_of_id = ${targetId}
          RETURNING id
        `
        if (del.length === 0) return { targetId, removed: false }
        await tx`UPDATE posts SET repost_count = GREATEST(repost_count - 1, 0) WHERE id = ${targetId}`
        return { targetId, removed: true }
      })
    },

    async getPostDTO(id: string, viewerId: string): Promise<PostDTO | null> {
      const rows = await sql<PostRowSelect[]>`
        SELECT
          id, author_id, kind, body, reply_to_id, thread_root_id, repost_of_id, event_id, report_id,
          like_count, repost_count, reply_count, save_count, created_at, updated_at
        FROM posts WHERE id = ${id} AND deleted_at IS NULL
      `
      const hydrated = await hydrate(rows, viewerId)
      return hydrated[0] ?? null
    },

    async homeFeed(args: HomeFeedArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null ? sql`AND (p.created_at, p.id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const filterClause =
        args.filter === "events"
          ? sql`AND p.event_id IS NOT NULL`
          : args.filter === "fixes"
            ? sql`AND EXISTS (SELECT 1 FROM reports fr WHERE fr.id = p.report_id AND fr.status = 'resolved')`
            : sql``
      const rows = await sql<PostRowSelect[]>`
        SELECT
          p.id, p.author_id, p.kind, p.body, p.reply_to_id, p.thread_root_id, p.repost_of_id,
          p.event_id, p.report_id, p.like_count, p.repost_count, p.reply_count, p.save_count,
          p.created_at, p.updated_at
        FROM posts p
        WHERE p.deleted_at IS NULL
          AND (
            p.author_id = ${args.viewerId}
            OR p.author_id IN (SELECT followee_id FROM follows_people WHERE follower_id = ${args.viewerId})
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${args.viewerId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${args.viewerId})
          )
          ${filterClause}
          ${cursorFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${args.limit + 1}
      `
      return pageOf(rows, args.limit, args.viewerId)
    },

    // The PUBLIC/global feed for signed-out viewers: every non-deleted top-level post, newest first, with
    // NO follow scope (there is no viewer to follow anyone) and NO block filter. It hydrates with the nil
    // UUID as the "viewer", which matches no like/save/repost/follow row, so every viewer flag comes back
    // false — exactly right for a not-signed-in reader. Top-level only (reply_to_id IS NULL) so the public
    // feed reads like the home timeline, not a flat reply dump.
    async publicFeed(args: PublicFeedArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null ? sql`AND (p.created_at, p.id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const filterClause =
        args.filter === "events"
          ? sql`AND p.event_id IS NOT NULL`
          : args.filter === "fixes"
            ? sql`AND EXISTS (SELECT 1 FROM reports fr WHERE fr.id = p.report_id AND fr.status = 'resolved')`
            : sql``
      const rows = await sql<PostRowSelect[]>`
        SELECT
          p.id, p.author_id, p.kind, p.body, p.reply_to_id, p.thread_root_id, p.repost_of_id,
          p.event_id, p.report_id, p.like_count, p.repost_count, p.reply_count, p.save_count,
          p.created_at, p.updated_at
        FROM posts p
        WHERE p.deleted_at IS NULL
          AND p.reply_to_id IS NULL
          ${filterClause}
          ${cursorFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${args.limit + 1}
      `
      return pageOf(rows, args.limit, NIL_VIEWER_ID)
    },

    async listReplies(postId: string, args: PostListArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      // Replies read oldest-first (thread order); keyset advances forward.
      const cursorFilter =
        cursor !== null ? sql`AND (p.created_at, p.id) > (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const rows = await sql<PostRowSelect[]>`
        SELECT
          p.id, p.author_id, p.kind, p.body, p.reply_to_id, p.thread_root_id, p.repost_of_id,
          p.event_id, p.report_id, p.like_count, p.repost_count, p.reply_count, p.save_count,
          p.created_at, p.updated_at
        FROM posts p
        WHERE p.reply_to_id = ${postId} AND p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${args.viewerId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${args.viewerId})
          )
          ${cursorFilter}
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT ${args.limit + 1}
      `
      return pageOf(rows, args.limit, args.viewerId)
    },

    async listUserPosts(authorId: string, args: PostListArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null ? sql`AND (p.created_at, p.id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      // The profile "Posts" tab excludes replies (matches Twitter's Posts vs Replies split).
      const rows = await sql<PostRowSelect[]>`
        SELECT
          p.id, p.author_id, p.kind, p.body, p.reply_to_id, p.thread_root_id, p.repost_of_id,
          p.event_id, p.report_id, p.like_count, p.repost_count, p.reply_count, p.save_count,
          p.created_at, p.updated_at
        FROM posts p
        WHERE p.author_id = ${authorId} AND p.deleted_at IS NULL AND p.kind <> 'reply'
          ${cursorFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${args.limit + 1}
      `
      return pageOf(rows, args.limit, args.viewerId)
    },

    async listSaves(args: PostListArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      // Keyset over the SAVE time (newest-saved first), not the post's own created_at.
      const cursorFilter =
        cursor !== null ? sql`AND (ps.created_at, ps.post_id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const rows = await sql<(PostRowSelect & { saved_at: Date })[]>`
        SELECT
          p.id, p.author_id, p.kind, p.body, p.reply_to_id, p.thread_root_id, p.repost_of_id,
          p.event_id, p.report_id, p.like_count, p.repost_count, p.reply_count, p.save_count,
          p.created_at, p.updated_at, ps.created_at AS saved_at
        FROM post_saves ps
        JOIN posts p ON p.id = ps.post_id
        WHERE ps.user_id = ${args.viewerId} AND p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${args.viewerId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${args.viewerId})
          )
          ${cursorFilter}
        ORDER BY ps.created_at DESC, ps.post_id DESC
        LIMIT ${args.limit + 1}
      `
      const hasMore = rows.length > args.limit
      const pageRows = hasMore ? rows.slice(0, args.limit) : rows
      const items = await hydrate(pageRows, args.viewerId)
      const last = pageRows[pageRows.length - 1]
      const nextCursor = hasMore && last ? encodeTimeCursor({ at: last.saved_at, id: last.id }) : null
      return { items, nextCursor }
    },
  }
}
