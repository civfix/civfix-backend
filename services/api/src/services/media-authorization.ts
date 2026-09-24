import type { Sql } from "../db/client.js"
import type { MediaAssetView, MediaOwner } from "./media-intake-service.js"
import { isPubliclyVisibleStatus } from "./report-visibility.js"
import { eventsBindingMedia } from "./media-bindings.js"

export interface MediaAccessDecision {
  allowed: boolean
  private: boolean
}

export interface MediaViewAuthorizer {
  authorize(asset: MediaAssetView, viewer: MediaOwner): Promise<MediaAccessDecision>
}

const DENY: MediaAccessDecision = { allowed: false, private: true }
const ALLOW_PUBLIC: MediaAccessDecision = { allowed: true, private: false }
const ALLOW_PRIVATE: MediaAccessDecision = { allowed: true, private: true }

export const UNBOUND_GRACE_MS = 6 * 60 * 60 * 1000

export function makeUnboundOnlyMediaViewAuthorizer(
  now: () => Date = () => new Date(),
): MediaViewAuthorizer {
  return {
    authorize(asset: MediaAssetView): Promise<MediaAccessDecision> {
      if (asset.purpose === "verification") return Promise.resolve(DENY)
      if (
        asset.purpose === "event_cover" ||
        asset.purpose === "event_gallery" ||
        asset.purpose === "org_logo"
      ) {
        return Promise.resolve(DENY)
      }
      if (asset.reportId || asset.chatMessageId || asset.postId) return Promise.resolve(DENY)
      return Promise.resolve(withinGrace(asset.createdAt, now()) ? ALLOW_PRIVATE : DENY)
    },
  }
}

function withinGrace(createdAt: Date | null | undefined, now: Date): boolean {
  if (!createdAt) return false
  return now.getTime() - createdAt.getTime() <= UNBOUND_GRACE_MS
}

export function makeDrizzleMediaViewAuthorizer(
  sql: Sql,
  now: () => Date = () => new Date(),
): MediaViewAuthorizer {
  return {
    async authorize(asset: MediaAssetView, viewer: MediaOwner): Promise<MediaAccessDecision> {
      if (asset.purpose === "verification") return DENY

      const viewerId = viewer.userId ?? null

      if (asset.chatMessageId !== null && asset.chatMessageId !== undefined) {
        return authorizeChatBound(sql, asset.chatMessageId, viewerId)
      }
      if (asset.postId !== null && asset.postId !== undefined) {
        return authorizePostBound(sql, asset.postId, viewerId)
      }
      if (asset.reportId !== null && asset.reportId !== undefined) {
        return authorizeReportBound(sql, asset.reportId, viewerId)
      }
      if (asset.purpose === "event_cover" || asset.purpose === "event_gallery") {
        return authorizeEventBound(sql, asset, viewerId, now())
      }
      if (asset.purpose === "org_logo") {
        return authorizeOrgLogoBound(sql, asset, now())
      }
      return authorizeUnbound(sql, asset, now())
    },
  }
}

export async function authorizeChatBound(
  sql: Sql,
  messageId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  if (viewerId === null) return DENY

  const dmRows = await sql<{ thread_id: string; deleted_at: Date | null }[]>`
    SELECT thread_id, deleted_at FROM dm_messages WHERE id = ${messageId} LIMIT 1
  `
  const dm = dmRows[0]
  if (dm) {
    if (dm.deleted_at !== null) return DENY
    const member = await sql<{ ok: number }[]>`
      SELECT 1 AS ok FROM dm_threads
      WHERE id = ${dm.thread_id} AND (user_lo = ${viewerId} OR user_hi = ${viewerId})
      LIMIT 1
    `
    return member.length > 0 ? ALLOW_PRIVATE : DENY
  }

  const chatRows = await sql<
    {
      cleanup_id: string | null
      report_id: string | null
      group_id: string | null
      deleted_at: Date | null
    }[]
  >`
    SELECT cleanup_id, report_id, group_id, deleted_at
    FROM chat_messages WHERE id = ${messageId} LIMIT 1
  `
  const msg = chatRows[0]
  if (!msg || msg.deleted_at !== null) return DENY

  if (msg.cleanup_id !== null) {
    const member = await sql<{ ok: number }[]>`
      SELECT 1 AS ok FROM cleanup_members
      WHERE cleanup_id = ${msg.cleanup_id} AND user_id = ${viewerId} LIMIT 1
    `
    return member.length > 0 ? ALLOW_PRIVATE : DENY
  }

  if (msg.group_id !== null) {
    const rows = await sql<{ visibility: string; is_member: boolean }[]>`
      SELECT g.visibility,
             EXISTS (
               SELECT 1 FROM chat_group_members m
               WHERE m.group_id = g.id AND m.user_id = ${viewerId}
             ) AS is_member
      FROM chat_groups g WHERE g.id = ${msg.group_id} LIMIT 1
    `
    const group = rows[0]
    if (!group) return DENY
    return group.is_member || group.visibility === "public" ? ALLOW_PRIVATE : DENY
  }

  if (msg.report_id !== null) {
    const visible = await reportVisible(sql, msg.report_id, viewerId)
    return visible ? ALLOW_PRIVATE : DENY
  }

  return DENY
}

export async function authorizeEventBound(
  sql: Sql,
  asset: MediaAssetView,
  viewerId: string | null,
  now: Date,
): Promise<MediaAccessDecision> {
  const rows = await sql<{ visibility: string; is_member: boolean }[]>`
    SELECT c.visibility,
           EXISTS (
             SELECT 1 FROM cleanup_members m
             WHERE m.cleanup_id = c.id AND m.user_id = ${viewerId}::uuid
           )
           OR EXISTS (
             SELECT 1 FROM organization_members om
             JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
             WHERE om.organization_id = c.organization_id
               AND om.user_id = ${viewerId}::uuid
           ) AS is_member
    FROM (${eventsBindingMedia(sql, asset.id)}) c
    ORDER BY c.id
    LIMIT 1
  `
  const event = rows[0]
  if (!event) return authorizeUnbound(sql, asset, now)
  if (event.visibility === "public" || event.visibility === "unlisted") return ALLOW_PUBLIC
  return event.is_member ? ALLOW_PRIVATE : DENY
}

export async function authorizeOrgLogoBound(
  sql: Sql,
  asset: MediaAssetView,
  now: Date,
): Promise<MediaAccessDecision> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM organizations
    WHERE logo_media_id = ${asset.id} AND deleted_at IS NULL
    LIMIT 1
  `
  return rows.length > 0 ? ALLOW_PUBLIC : authorizeUnbound(sql, asset, now)
}

export async function authorizePostBound(
  sql: Sql,
  postId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  const rows = await sql<{ author_id: string; visibility: string; deleted_at: Date | null }[]>`
    SELECT author_id, visibility, deleted_at FROM posts WHERE id = ${postId} LIMIT 1
  `
  const post = rows[0]
  if (!post || post.deleted_at !== null) return DENY
  if (post.visibility === "public") return ALLOW_PUBLIC
  return viewerId !== null && post.author_id === viewerId ? ALLOW_PRIVATE : DENY
}

export async function authorizeReportBound(
  sql: Sql,
  reportId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  const rows = await sql<
    {
      reporter_user_id: string | null
      status: string
      visibility: string
      deleted_at: Date | null
    }[]
  >`
    SELECT reporter_user_id, status, visibility, deleted_at
    FROM reports WHERE id = ${reportId} LIMIT 1
  `
  const report = rows[0]
  if (!report || report.deleted_at !== null) return DENY
  if (isPubliclyVisibleStatus(report.status) && report.visibility === "public") return ALLOW_PUBLIC
  if (viewerId !== null && report.reporter_user_id === viewerId) return ALLOW_PRIVATE
  return DENY
}

async function reportVisible(
  sql: Sql,
  reportId: string,
  viewerId: string | null,
): Promise<boolean> {
  const decision = await authorizeReportBound(sql, reportId, viewerId)
  return decision.allowed
}

async function authorizeUnbound(
  sql: Sql,
  asset: MediaAssetView,
  now: Date,
): Promise<MediaAccessDecision> {
  const rows = await sql<{ is_avatar: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM users WHERE avatar_media_id = ${asset.id})
      OR EXISTS (SELECT 1 FROM chat_groups WHERE avatar_media_id = ${asset.id})
    ) AS is_avatar
  `
  if (rows[0]?.is_avatar === true) return ALLOW_PUBLIC
  return withinGrace(asset.createdAt, now) ? ALLOW_PRIVATE : DENY
}
