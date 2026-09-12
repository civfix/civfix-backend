
import type postgres from "postgres"
import { AppError, avatarGradient } from "@civfix/shared"
import type {
  LinkedEventRef,
  LinkedReportRef,
  MediaDTO,
  OrganizationRefDTO,
  PersonDTO,
  PostDTO,
  PostRefDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { Queryable, Sql } from "../db/client.js"
import type { POST_KIND_VALUES, REPORT_VISIBILITY_VALUES } from "../db/schema/types.js"
import { paginate, parseTimeCursor } from "../db/cursor-helpers.js"
import { loadMentionsFor, makeMentionRepo } from "./message-mentions.drizzle.js"
import { goingScalar } from "./cleanup-sql.js"
import { servedKeyExpr } from "./media-served-key.js"
import { mapWithLimit, PRESIGN_CONCURRENCY, type PresignMedia } from "./media-presign.js"
import { publicAuthorIdentity } from "./public-author.js"
import { presentIds } from "./present-ids.js"
import {
  NO_AFFILIATIONS,
  withAffiliation,
  type AffiliationLoader,
  type PrimaryAffiliations,
} from "./affiliation.js"
import { firstReadyStillLateral, publicReportFilter } from "./report-sql.js"

type PostKind = (typeof POST_KIND_VALUES)[number]
type PostVisibility = (typeof REPORT_VISIBILITY_VALUES)[number]

export const POSTS_DEFAULT_LIMIT = 20

export const NIL_VIEWER_ID = "00000000-0000-0000-0000-000000000000"

function postColumns(sql: Queryable): postgres.Fragment {
  return sql`
    p.id, p.author_id, p.kind, p.body, p.reply_to_id, p.thread_root_id, p.repost_of_id,
    p.event_id, p.report_id, p.like_count, p.repost_count, p.reply_count, p.save_count,
    p.organization_id, p.created_at, p.updated_at
  `
}

function organizationRefOf(
  organizations: ReadonlyMap<string, OrganizationRefDTO>,
  id: string | null | undefined,
): OrganizationRefDTO | null {
  if (id === null || id === undefined) return null
  return organizations.get(id) ?? null
}

export interface CreatePostArgs {
  authorId: string
  kind: PostKind
  body: string | null
  replyToId: string | null
  repostOfId: string | null
  eventId: string | null
  reportId: string | null
  mediaUploadIds: string[]
  mentionedUserIds: string[]
  organizationId: string | null
}

export interface PostBrief {
  id: string
  authorId: string
  kind: PostKind
  replyToId: string | null
  repostOfId: string | null
  deletedAt: Date | null
  visibility: PostVisibility
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

export interface ReplyListArgs extends PostListArgs {
  focalAuthorId: string
}

export interface RepliesPage extends FeedPage {
  authorReplies: PostDTO[]
}

export interface HomeFeedArgs extends PostListArgs {
  filter: "all" | "events" | "fixes"
}

export interface PublicFeedArgs {
  filter: "all" | "events" | "fixes"
  cursor: string | null
  limit: number
}

export interface PostRepository {
  getPostBrief(id: string): Promise<PostBrief | null>
  actorNameOf(userId: string): Promise<string>
  canPostAsOrganization(organizationId: string, userId: string): Promise<boolean>
  isEventMember(eventId: string, userId: string): Promise<boolean>
  isReportAttachable(reportId: string): Promise<boolean>

  createPost(args: CreatePostArgs): Promise<string>
  softDeletePost(postId: string): Promise<void>

  like(postId: string, userId: string): Promise<boolean>
  unlike(postId: string, userId: string): Promise<boolean>
  save(postId: string, userId: string): Promise<boolean>
  unsave(postId: string, userId: string): Promise<boolean>
  repost(postId: string, userId: string): Promise<{ targetId: string; created: boolean }>
  unrepost(postId: string, userId: string): Promise<{ targetId: string; removed: boolean }>

  getPostDTO(id: string, viewerId: string): Promise<PostDTO | null>
  homeFeed(args: HomeFeedArgs): Promise<FeedPage>
  publicFeed(args: PublicFeedArgs): Promise<FeedPage>
  listReplies(postId: string, args: ReplyListArgs): Promise<RepliesPage>
  listUserPosts(authorId: string, args: PostListArgs): Promise<FeedPage>
  listSaves(args: PostListArgs): Promise<FeedPage>
}


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
  organization_id: string | null
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
  avatar_r2_key: string | null
  avatar_url: string | null
  is_following: boolean
  deleted_at: Date | null
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
  like_count: number
  repost_count: number
  reply_count: number
  save_count: number
  created_at: Date
  deleted_at: Date | null
  visibility: PostVisibility
  author_id: string | null
  display_name: string | null
  handle: string | null
  bio: string | null
  avatar_url: string | null
  organization_id: string | null
}

interface PostCounts {
  likes: number
  reposts: number
  replies: number
  saves: number
}

interface RefLink {
  eventId: string | null
  reportId: string | null
  linkedAt: string
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
  affiliations?: AffiliationLoader
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

export async function tombstonePostInTx(tx: Queryable, postId: string): Promise<boolean> {
  const rows = await tx<
    { kind: PostKind; reply_to_id: string | null; repost_of_id: string | null }[]
  >`
    UPDATE posts SET deleted_at = now() WHERE id = ${postId} AND deleted_at IS NULL
    RETURNING kind, reply_to_id, repost_of_id
  `
  const row = rows[0]
  if (!row) return false
  if (row.reply_to_id !== null) {
    await tx`UPDATE posts SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = ${row.reply_to_id}`
  }
  if (row.kind === "repost" && row.repost_of_id !== null) {
    await tx`UPDATE posts SET repost_count = GREATEST(repost_count - 1, 0) WHERE id = ${row.repost_of_id}`
  }
  return true
}

export function makeDrizzlePostRepository(sql: Sql, deps: PostRepoDeps): PostRepository {
  async function loadAffiliations(
    userIds: string[],
    viewerId: string,
  ): Promise<PrimaryAffiliations> {
    if (deps.affiliations === undefined) return NO_AFFILIATIONS
    return deps.affiliations(userIds, viewerId)
  }

  async function loadOrganizations(
    ids: readonly (string | null | undefined)[],
  ): Promise<Map<string, OrganizationRefDTO>> {
    const out = new Map<string, OrganizationRefDTO>()
    const wanted = presentIds(ids)
    if (wanted.length === 0) return out
    const rows = await sql<
      {
        id: string
        slug: string
        name: string
        verified_status: string
        verified_kind: OrganizationRefDTO["verifiedKind"]
        logo_key: string | null
      }[]
    >`
      SELECT o.id, o.slug, o.name, o.verified_status, o.verified_kind,
             ${servedKeyExpr(sql, "am")} AS logo_key
      FROM organizations o
      LEFT JOIN media_assets am ON am.id = o.logo_media_id
      WHERE o.id = ANY(${wanted}::uuid[]) AND o.deleted_at IS NULL
    `
    const keys = [...new Set(rows.map((r) => r.logo_key).filter((k): k is string => k !== null))]
    const urls = await mapWithLimit(keys, PRESIGN_CONCURRENCY, (key) => deps.presignAvatar(key))
    const byKey = new Map<string, string>()
    keys.forEach((key, i) => {
      const url = urls[i]
      if (url !== undefined) byKey.set(key, url)
    })
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        slug: r.slug,
        name: r.name,
        logoUrl: r.logo_key === null ? null : (byKey.get(r.logo_key) ?? null),
        verified: r.verified_status === "verified",
        verifiedKind: r.verified_kind,
      })
    }
    return out
  }

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
        u.follower_count AS followers,
        u.following_count AS following,
        ${servedKeyExpr(sql, "am")} AS avatar_r2_key,
        u.avatar_url,
        u.deleted_at,
        EXISTS (
          SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id
        ) AS is_following
      FROM users u
      LEFT JOIN media_assets am ON am.id = u.avatar_media_id
      WHERE u.id = ANY(${ids}::uuid[])
    `
    const resolved = await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (r) => {
      const rawAvatarUrl =
        r.deleted_at === null && r.avatar_r2_key !== null
          ? await deps.presignAvatar(r.avatar_r2_key)
          : r.avatar_url
      const identity = publicAuthorIdentity({
        id: r.id,
        displayName: r.display_name,
        handle: r.handle,
        avatarUrl: rawAvatarUrl,
        deletedAt: r.deleted_at,
      })
      const dto: PersonDTO = {
        id: r.id,
        name: identity.name,
        handle: identity.handle,
        bio: identity.deleted ? null : r.bio,
        avatar: identity.avatar,
        ...(identity.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
        followers: identity.deleted ? 0 : Number(r.followers),
        following: identity.deleted ? 0 : Number(r.following),
        isFollowing: identity.deleted ? false : r.is_following,
        ...(identity.deleted ? { deleted: true } : {}),
      }
      return dto
    })
    const affiliations = await loadAffiliations(
      rows.filter((r) => r.deleted_at === null).map((r) => r.id),
      viewerId,
    )
    for (const dto of resolved) out.set(dto.id, withAffiliation(dto, affiliations))
    return out
  }

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
        ${goingScalar(sql)} AS going,
        u.id AS org_id,
        u.display_name AS org_name,
        u.handle AS org_handle,
        u.bio AS org_bio,
        u.avatar_url AS org_avatar_url
      FROM cleanups c
      JOIN users u ON u.id = c.organizer_user_id
      WHERE c.id = ANY(${ids}::uuid[])
        AND c.visibility = 'public'
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
        m.thumb_key,
        m.r2_key AS thumb_r2_key
      FROM reports r
      ${firstReadyStillLateral(sql)}
      WHERE r.id = ANY(${ids}::uuid[]) AND ${publicReportFilter(sql)}
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

  async function loadRefs(
    ids: string[],
    viewerId: string,
  ): Promise<{
    refs: Map<string, PostRefDTO>
    counts: Map<string, PostCounts>
    links: Map<string, RefLink>
    orgIds: Map<string, string>
    authorIds: string[]
  }> {
    const out = new Map<string, PostRefDTO>()
    const counts = new Map<string, PostCounts>()
    const links = new Map<string, RefLink>()
    const orgIds = new Map<string, string>()
    const authorIds: string[] = []
    if (ids.length === 0) return { refs: out, counts, links, orgIds, authorIds }
    const rows = await sql<RefRow[]>`
      SELECT
        p.id, p.kind, p.body, p.event_id, p.report_id,
        p.like_count, p.repost_count, p.reply_count, p.save_count,
        p.created_at, p.deleted_at, p.visibility,
        p.organization_id,
        u.id AS author_id, u.display_name, u.handle, u.bio, u.avatar_url
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
      const deleted = r.deleted_at !== null || r.visibility !== "public"
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
            }
          : null
      if (author !== null) authorIds.push(author.id)
      if (!deleted && r.organization_id != null) orgIds.set(r.id, r.organization_id)
      out.set(r.id, {
        id: r.id,
        author,
        kind: r.kind,
        excerpt: deleted ? "" : excerptOf(r.body, r.event_id !== null, r.report_id !== null),
        createdAt: r.created_at.toISOString(),
        ...(deleted ? { deleted: true } : {}),
        media: [],
        body: deleted ? null : r.body,
        event: null,
        report: null,
      })
      counts.set(r.id, {
        likes: Number(r.like_count),
        reposts: Number(r.repost_count),
        replies: Number(r.reply_count),
        saves: Number(r.save_count),
      })
      if (!deleted) {
        links.set(r.id, {
          eventId: r.event_id,
          reportId: r.report_id,
          linkedAt: r.created_at.toISOString(),
        })
      }
    }
    return { refs: out, counts, links, orgIds, authorIds }
  }

  async function loadMedia(ids: string[]): Promise<Map<string, MediaDTO[]>> {
    const out = new Map<string, MediaDTO[]>()
    if (ids.length === 0) return out
    const rows = await sql<MediaRow[]>`
      SELECT post_id, id, kind, codec, served_key AS r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE post_id = ANY(${ids}::uuid[]) AND status = 'ready' AND served_key IS NOT NULL
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

  async function loadViewerFlags(
    rows: PostRowSelect[],
    viewerId: string,
  ): Promise<{ liked: Set<string>; saved: Set<string>; repostedTargets: Set<string> }> {
    const ids = rows.map((r) => r.id)
    const subjectIds = rows.map((r) => (r.kind === "repost" && r.repost_of_id ? r.repost_of_id : r.id))
    const liked = new Set<string>()
    const saved = new Set<string>()
    const repostedTargets = new Set<string>()
    if (ids.length === 0) return { liked, saved, repostedTargets }
    const [likeRows, saveRows, repostRows] = await Promise.all([
      sql<{ post_id: string }[]>`
        SELECT post_id FROM post_likes WHERE user_id = ${viewerId} AND post_id = ANY(${subjectIds}::uuid[])
      `,
      sql<{ post_id: string }[]>`
        SELECT post_id FROM post_saves WHERE user_id = ${viewerId} AND post_id = ANY(${subjectIds}::uuid[])
      `,
      sql<{ repost_of_id: string }[]>`
        SELECT repost_of_id FROM posts
        WHERE kind = 'repost' AND author_id = ${viewerId}
          AND repost_of_id = ANY(${subjectIds}::uuid[]) AND deleted_at IS NULL
      `,
    ])
    for (const r of likeRows) liked.add(r.post_id)
    for (const r of saveRows) saved.add(r.post_id)
    for (const r of repostRows) repostedTargets.add(r.repost_of_id)
    return { liked, saved, repostedTargets }
  }

  async function hydrate(rows: PostRowSelect[], viewerId: string): Promise<PostDTO[]> {
    if (rows.length === 0) return []
    const postIds = rows.map((r) => r.id)
    const authorIds = [...new Set(rows.map((r) => r.author_id))]
    const refIds = presentIds(rows.flatMap((r) => [r.repost_of_id, r.reply_to_id]))
    const [authors, media, mentions, refsResult, flags] = await Promise.all([
      loadAuthors(authorIds, viewerId),
      loadMedia(postIds),
      loadMentionsFor(sql, "post_mentions", postIds, "post_id"),
      loadRefs(refIds, viewerId),
      loadViewerFlags(rows, viewerId),
    ])
    const refs = refsResult.refs
    const refCounts = refsResult.counts
    const refLinks = refsResult.links

    const linkValues = [...refLinks.values()]
    const eventIds = presentIds([
      ...rows.map((r) => r.event_id),
      ...linkValues.map((l) => l.eventId),
    ])
    const reportIds = presentIds([
      ...rows.map((r) => r.report_id),
      ...linkValues.map((l) => l.reportId),
    ])
    const readableRefIds = [...refs.values()].filter((r) => !r.deleted).map((r) => r.id)
    const orgIds = [...rows.map((r) => r.organization_id), ...refsResult.orgIds.values()]
    const [events, reports, refMedia, organizations, refAffiliations] = await Promise.all([
      loadEvents(eventIds),
      loadReports(reportIds),
      loadMedia(readableRefIds),
      loadOrganizations(orgIds),
      loadAffiliations(refsResult.authorIds, viewerId),
    ])

    for (const ref of refs.values()) {
      if (ref.deleted) continue
      ref.media = refMedia.get(ref.id) ?? []
      if (ref.author !== null) ref.author = withAffiliation(ref.author, refAffiliations)
      ref.organization = organizationRefOf(organizations, refsResult.orgIds.get(ref.id))
      const link = refLinks.get(ref.id)
      if (!link) continue
      const refEvent = link.eventId !== null ? events.get(link.eventId) : undefined
      const refReport = link.reportId !== null ? reports.get(link.reportId) : undefined
      ref.event = refEvent ? { ...refEvent, linkedAt: link.linkedAt } : null
      ref.report = refReport ? { ...refReport, linkedAt: link.linkedAt } : null
    }

    const out: PostDTO[] = []
    for (const r of rows) {
      const author = authors.get(r.author_id)
      if (!author) continue
      const isRepost = r.kind === "repost" && r.repost_of_id !== null
      const targetId = isRepost ? r.repost_of_id! : r.id
      const editedAt = r.updated_at.getTime() > r.created_at.getTime() ? r.updated_at.toISOString() : null
      const eventBase = r.event_id !== null ? events.get(r.event_id) : undefined
      const reportBase = r.report_id !== null ? reports.get(r.report_id) : undefined
      const repostOf = r.repost_of_id !== null ? (refs.get(r.repost_of_id) ?? null) : null
      const postMentions: UserMentionDTO[] = mentions.get(r.id) ?? []
      const counts: PostCounts = isRepost
        ? (refCounts.get(targetId) ?? { likes: 0, reposts: 0, replies: 0, saves: 0 })
        : {
            likes: Number(r.like_count),
            reposts: Number(r.repost_count),
            replies: Number(r.reply_count),
            saves: Number(r.save_count),
          }
      const dto: PostDTO = {
        id: r.id,
        author,
        organization: organizationRefOf(organizations, r.organization_id),
        kind: r.kind,
        body: r.body,
        createdAt: r.created_at.toISOString(),
        editedAt,
        counts,
        viewer: {
          liked: flags.liked.has(targetId),
          reposted: flags.repostedTargets.has(targetId),
          saved: flags.saved.has(targetId),
        },
        media: media.get(r.id) ?? [],
        mentions: postMentions,
        event: eventBase ? { ...eventBase, linkedAt: r.created_at.toISOString() } : null,
        report: reportBase ? { ...reportBase, linkedAt: r.created_at.toISOString() } : null,
        repostOf,
        replyToId: r.reply_to_id,
        replyTo: r.reply_to_id !== null ? (refs.get(r.reply_to_id) ?? null) : null,
        threadRootId: r.thread_root_id,
      }
      out.push(dto)
    }
    return out
  }

  async function latestAnswersByAuthor(
    parentIds: string[],
    authorId: string,
  ): Promise<PostRowSelect[]> {
    if (parentIds.length === 0) return []
    return sql<PostRowSelect[]>`
      SELECT DISTINCT ON (p.reply_to_id) ${postColumns(sql)}
      FROM posts p
      WHERE p.reply_to_id = ANY(${parentIds}::uuid[])
        AND p.author_id = ${authorId}
        AND p.deleted_at IS NULL
        AND p.visibility = 'public'
      ORDER BY p.reply_to_id, p.created_at DESC, p.id DESC
    `
  }

  async function pageOf(rows: PostRowSelect[], limit: number, viewerId: string): Promise<FeedPage> {
    const { items: pageRows, nextCursor } = paginate(rows, limit, (r) => ({
      at: r.created_at,
      id: r.id,
    }))
    return { items: await hydrate(pageRows, viewerId), nextCursor }
  }

  async function resolveOriginalTarget(tx: Queryable, postId: string): Promise<string | null> {
    const rows = await tx<{ id: string; kind: PostKind; repost_of_id: string | null }[]>`
      SELECT id, kind, repost_of_id FROM posts WHERE id = ${postId} AND deleted_at IS NULL
    `
    const row = rows[0]
    if (!row) return null
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
          visibility: PostVisibility
        }[]
      >`
        SELECT id, author_id, kind, reply_to_id, repost_of_id, deleted_at, visibility
        FROM posts WHERE id = ${id}
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
        visibility: r.visibility,
      }
    },

    async actorNameOf(userId: string): Promise<string> {
      const rows = await sql<{ display_name: string; handle: string | null }[]>`
        SELECT display_name, handle FROM users WHERE id = ${userId} LIMIT 1
      `
      const r = rows[0]
      return r ? nameFrom(r.display_name, r.handle) : "Someone"
    },

    async canPostAsOrganization(organizationId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM organization_members m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = ${organizationId}
          AND m.user_id = ${userId}
          AND o.deleted_at IS NULL
          AND o.suspended_at IS NULL
        LIMIT 1
      `
      return rows.length > 0
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
        SELECT 1 AS one FROM reports r
        WHERE r.id = ${reportId} AND ${publicReportFilter(sql)}
        LIMIT 1
      `
      return rows.length > 0
    },

    async createPost(args: CreatePostArgs): Promise<string> {
      return sql.begin(async (tx) => {
        const replyToId =
          args.replyToId !== null
            ? ((await resolveOriginalTarget(tx, args.replyToId)) ?? args.replyToId)
            : null
        const repostOfId =
          args.repostOfId !== null
            ? ((await resolveOriginalTarget(tx, args.repostOfId)) ?? args.repostOfId)
            : null
        let threadRootId: string | null = null
        if (replyToId !== null) {
          const parentRows = await tx<{ id: string; thread_root_id: string | null }[]>`
            SELECT id, thread_root_id FROM posts WHERE id = ${replyToId}
          `
          const parent = parentRows[0]
          threadRootId = parent?.thread_root_id ?? parent?.id ?? null
        }
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO posts (
            author_id, kind, body, reply_to_id, thread_root_id, repost_of_id, event_id, report_id,
            organization_id
          )
          VALUES (
            ${args.authorId}, ${args.kind}, ${args.body}, ${replyToId}, ${threadRootId},
            ${repostOfId}, ${args.eventId}, ${args.reportId}, ${args.organizationId ?? null}
          )
          RETURNING id
        `
        const postId = inserted[0]!.id

        if (args.mediaUploadIds.length > 0) {
          const claimed = await tx<{ upload_id: string }[]>`
            UPDATE media_assets
            SET post_id = ${postId}, purpose = 'post'
            WHERE upload_id IN ${tx(args.mediaUploadIds)}
              AND post_id IS NULL AND chat_message_id IS NULL AND report_id IS NULL
              AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
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

        if (replyToId !== null) {
          await tx`UPDATE posts SET reply_count = reply_count + 1 WHERE id = ${replyToId}`
        }

        return postId
      })
    },

    async softDeletePost(postId: string): Promise<void> {
      await sql.begin((tx) => tombstonePostInTx(tx, postId))
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
        const revived = await tx<{ id: string }[]>`
          UPDATE posts SET deleted_at = NULL, updated_at = now()
          WHERE author_id = ${userId} AND kind = 'repost' AND repost_of_id = ${targetId}
            AND deleted_at IS NOT NULL
          RETURNING id
        `
        if (revived.length > 0) {
          await tx`UPDATE posts SET repost_count = repost_count + 1 WHERE id = ${targetId}`
          return { targetId, created: true }
        }
        const ins = await tx<{ id: string }[]>`
          INSERT INTO posts (author_id, kind, repost_of_id) VALUES (${userId}, 'repost', ${targetId})
          ON CONFLICT (author_id, repost_of_id) WHERE kind = 'repost' AND deleted_at IS NULL DO NOTHING
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
          UPDATE posts SET deleted_at = now()
          WHERE author_id = ${userId} AND kind = 'repost' AND repost_of_id = ${targetId}
            AND deleted_at IS NULL
          RETURNING id
        `
        if (del.length === 0) return { targetId, removed: false }
        await tx`UPDATE posts SET repost_count = GREATEST(repost_count - 1, 0) WHERE id = ${targetId}`
        return { targetId, removed: true }
      })
    },

    async getPostDTO(id: string, viewerId: string): Promise<PostDTO | null> {
      const rows = await sql<PostRowSelect[]>`
        SELECT ${postColumns(sql)}
        FROM posts p WHERE p.id = ${id} AND p.deleted_at IS NULL AND p.visibility = 'public'
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
        SELECT ${postColumns(sql)}
        FROM posts p
        WHERE p.deleted_at IS NULL
          AND p.reply_to_id IS NULL
          AND p.visibility = 'public'
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
        SELECT ${postColumns(sql)}
        FROM posts p
        WHERE p.deleted_at IS NULL
          AND p.reply_to_id IS NULL
          AND p.visibility = 'public'
          ${filterClause}
          ${cursorFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${args.limit + 1}
      `
      return pageOf(rows, args.limit, NIL_VIEWER_ID)
    },

    async listReplies(postId: string, args: ReplyListArgs): Promise<RepliesPage> {
      const cursor = parseTimeCursor(args.cursor, { direction: "asc" })
      const cursorFilter =
        cursor !== null ? sql`AND (p.created_at, p.id) > (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const rows = await sql<PostRowSelect[]>`
        SELECT ${postColumns(sql)}
        FROM posts p
        WHERE p.reply_to_id = ${postId} AND p.deleted_at IS NULL
          AND p.visibility = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${args.viewerId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${args.viewerId})
          )
          ${cursorFilter}
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT ${args.limit + 1}
      `
      const { items: pageRows, nextCursor } = paginate(rows, args.limit, (r) => ({
        at: r.created_at,
        id: r.id,
      }))
      const answerRows = await latestAnswersByAuthor(
        pageRows.map((r) => r.id),
        args.focalAuthorId,
      )
      const pageIds = new Set(pageRows.map((r) => r.id))
      const hydrated = await hydrate([...pageRows, ...answerRows], args.viewerId)
      return {
        items: hydrated.filter((post) => pageIds.has(post.id)),
        nextCursor,
        authorReplies: hydrated.filter((post) => !pageIds.has(post.id)),
      }
    },

    async listUserPosts(authorId: string, args: PostListArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null ? sql`AND (p.created_at, p.id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const rows = await sql<PostRowSelect[]>`
        SELECT ${postColumns(sql)}
        FROM posts p
        WHERE p.author_id = ${authorId} AND p.deleted_at IS NULL AND p.reply_to_id IS NULL
          AND p.visibility = 'public'
          ${cursorFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${args.limit + 1}
      `
      return pageOf(rows, args.limit, args.viewerId)
    },

    async listSaves(args: PostListArgs): Promise<FeedPage> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null ? sql`AND (ps.created_at, ps.post_id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const rows = await sql<(PostRowSelect & { saved_at: Date })[]>`
        SELECT ${postColumns(sql)}, ps.created_at AS saved_at
        FROM post_saves ps
        JOIN posts p ON p.id = ps.post_id
        WHERE ps.user_id = ${args.viewerId} AND p.deleted_at IS NULL
          AND p.visibility = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${args.viewerId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${args.viewerId})
          )
          ${cursorFilter}
        ORDER BY ps.created_at DESC, ps.post_id DESC
        LIMIT ${args.limit + 1}
      `
      const { items: pageRows, nextCursor } = paginate(rows, args.limit, (r) => ({
        at: r.saved_at,
        id: r.id,
      }))
      return { items: await hydrate(pageRows, args.viewerId), nextCursor }
    },
  }
}
