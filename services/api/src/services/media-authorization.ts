/**
 * Media view authorization (security review H9).
 *
 * `GET /media/:id` used to hand a fresh presigned URL to ANY caller that knew a media id — no session
 * required — which leaked private DM/group-chat attachments, media on held/unlisted reports, and
 * attachments on deleted posts, forever and with no revocation. This module is the authorization
 * decision that route now runs.
 *
 * The rule: a media asset has NO visibility of its own. It inherits the visibility of the SUBJECT it is
 * bound to, and that subject's EXISTING predicate is the one we re-use:
 *
 *   chat_message_id  -> the room the message lives in (dm thread / cleanup / report chat / group).
 *                       Mirrors ws/frame-handler.ts authorizeRoom at the READ level.
 *   post_id          -> posts visibility (public + not deleted, or the viewer is the author).
 *   report_id        -> services/report-visibility.ts isReportVisibleTo (a publicly-visible status +
 *                       public visibility, or the viewer is the reporter).
 *   (nothing bound)  -> either an AVATAR (users.avatar_media_id / chat_groups.avatar_media_id — the
 *                       binding points the other way) or a not-yet-committed upload inside the
 *                       capability window; see UNBOUND_GRACE_MS.
 *
 * FAIL CLOSED. Every lane starts from "deny" and only an explicit match allows. An unresolvable
 * binding (row gone, unknown lane) denies. The caller maps a deny to 404 — never 403 — so the endpoint
 * is not an existence oracle for private chat/report media.
 *
 * PRIVATE vs PUBLIC. The decision also reports whether the asset is PRIVATE. Private media must be
 * served as a short-lived SIGNED GET and must NEVER be handed out as a public CDN URL (see
 * adapters/storage.r2.ts presignGet `forceSigned`) — a CDN URL has no expiry and no revocation, so a
 * DM attachment behind one is permanently world-readable to anyone who ever saw the link.
 */

import type { Sql } from "../db/client.js"
import type { MediaAssetView, MediaOwner } from "./media-intake-service.js"
import { isPubliclyVisibleStatus } from "./report-visibility.js"

export interface MediaAccessDecision {
  /** May the viewer receive a URL for this asset at all? */
  allowed: boolean
  /**
   * True when the asset must be served as a signed, short-lived GET and never through a public CDN
   * base. Set for every chat-bound asset and for not-yet-committed uploads.
   */
  private: boolean
}

export interface MediaViewAuthorizer {
  authorize(asset: MediaAssetView, viewer: MediaOwner): Promise<MediaAccessDecision>
}

const DENY: MediaAccessDecision = { allowed: false, private: true }
const ALLOW_PUBLIC: MediaAccessDecision = { allowed: true, private: false }
const ALLOW_PRIVATE: MediaAccessDecision = { allowed: true, private: true }

/**
 * How long an upload that has not yet been claimed by a report/post/message stays readable by the
 * capability that created it (the unguessable, server-generated media id returned from finalize).
 *
 * This window exists because the client polls `GET /media/:id` between finalize and the commit that
 * stamps a binding, so a hard "unbound => deny" would break every upload flow. It is deliberately the
 * SAME 6h as the media-worker's orphan TTL (media-worker/src/config.ts orphanTtlMs): past that point
 * an unbound row is an orphan awaiting reaping and must not be served.
 *
 * It also closes a real leak: `media_assets.report_id` is `ON DELETE SET NULL`, so deleting a report
 * turns its media rows back into "unbound" ones. Without the age bound, deleting a report would make
 * its media MORE accessible, not less.
 */
export const UNBOUND_GRACE_MS = 6 * 60 * 60 * 1000

/**
 * The authorizer used when no DB-backed one is wired (offline/in-memory harnesses). It can resolve the
 * unbound lane on its own (the age check is pure) but has no way to evaluate a binding, so ANY bound
 * asset is denied. Fail-closed by construction: a production wiring that forgets the real authorizer
 * serves nothing rather than everything.
 */
export function makeUnboundOnlyMediaViewAuthorizer(
  now: () => Date = () => new Date(),
): MediaViewAuthorizer {
  return {
    authorize(asset: MediaAssetView): Promise<MediaAccessDecision> {
      if (asset.purpose === "verification") return Promise.resolve(DENY)
      if (asset.reportId || asset.chatMessageId || asset.postId) return Promise.resolve(DENY)
      return Promise.resolve(withinGrace(asset.createdAt, now()) ? ALLOW_PRIVATE : DENY)
    },
  }
}

function withinGrace(createdAt: Date | null | undefined, now: Date): boolean {
  // A row with no created_at cannot be aged, so it cannot be proven fresh -> deny.
  if (!createdAt) return false
  return now.getTime() - createdAt.getTime() <= UNBOUND_GRACE_MS
}

export function makeDrizzleMediaViewAuthorizer(
  sql: Sql,
  now: () => Date = () => new Date(),
): MediaViewAuthorizer {
  return {
    async authorize(asset: MediaAssetView, viewer: MediaOwner): Promise<MediaAccessDecision> {
      // Verification selfies are operator-only and never served on the public media path (pre-existing
      // carve-out, kept here so every deny reason lives in one place).
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
      return authorizeUnbound(sql, asset, now())
    },
  }
}

/**
 * Chat lane. `media_assets.chat_message_id` is a bare uuid shared by BOTH message stacks (chat_messages
 * for cleanup/report/group rooms and dm_messages for 1:1 DMs — see message-attachments.drizzle.ts), so
 * both are probed. Message ids are globally-unique uuids, so at most one matches.
 *
 * Anonymous callers are denied outright: there is no chat surface an anon session can legitimately read,
 * and this is exactly the case H9 called out (a DM attachment fetched with no session at all).
 */
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
    // Mirrors authorizeRoom's group READ level: a member of any group, or anyone when the group is
    // public (public groups are read-only-joinable). Unknown group -> deny.
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
    // Report chat is readable by anyone who can SEE the report (authorizeRoom's report READ level), but
    // the attachment still gets a signed, short-lived URL rather than a CDN one: report chat is public
    // *conditionally*, and an unlist/hold must actually revoke access.
    const visible = await reportVisible(sql, msg.report_id, viewerId)
    return visible ? ALLOW_PRIVATE : DENY
  }

  return DENY
}

/** Post lane: public + not deleted, or the viewer is the author. */
export async function authorizePostBound(
  sql: Sql,
  postId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  const rows = await sql<
    { author_id: string; visibility: string; deleted_at: Date | null }[]
  >`
    SELECT author_id, visibility, deleted_at FROM posts WHERE id = ${postId} LIMIT 1
  `
  const post = rows[0]
  if (!post || post.deleted_at !== null) return DENY
  if (post.visibility === "public") return ALLOW_PUBLIC
  return viewerId !== null && post.author_id === viewerId ? ALLOW_PRIVATE : DENY
}

/**
 * Report lane: the canonical predicate (a PUBLIC_REPORT_STATUSES status + public + not deleted, or the
 * viewer's own). Deliberately the same status set as report-visibility.ts / publicReportFilter: a photo
 * must not vanish from a report the moment the city acknowledges or resolves it.
 */
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
  // Own report (held / unlisted / in review): visible to its reporter only, and signed rather than CDN
  // so a later moderation decision can actually take it away.
  if (viewerId !== null && report.reporter_user_id === viewerId) return ALLOW_PRIVATE
  return DENY
}

/** Shared report predicate (the SQL twin of services/report-visibility.ts isReportVisibleTo). */
async function reportVisible(sql: Sql, reportId: string, viewerId: string | null): Promise<boolean> {
  const decision = await authorizeReportBound(sql, reportId, viewerId)
  return decision.allowed
}

/**
 * Unbound lane. Two legitimate shapes:
 *   1. an AVATAR — users.avatar_media_id / chat_groups.avatar_media_id point AT the media row, so the
 *      media row itself carries no binding. Avatars are public by design (they render in signed-out
 *      feeds and member lists).
 *   2. a not-yet-committed upload inside UNBOUND_GRACE_MS (see that constant).
 * Anything else — most importantly a row whose report_id was NULLed by a report deletion — is denied.
 */
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
