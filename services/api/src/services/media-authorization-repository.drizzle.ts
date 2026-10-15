import type { Sql } from "../db/client.js"
import { eventsBindingMedia } from "./media-bindings.js"
import type {
  ChatMessageRoom,
  ChatMessageScope,
  DmMessageRef,
  DmMessageThread,
  MediaAuthorizationRepository,
  PostAccess,
  ReportAccess,
  RoomAccess,
} from "./media-authorization-repository.js"

export function makeDrizzleMediaAuthorizationRepository(sql: Sql): MediaAuthorizationRepository {
  return {
    async findDmMessage(messageId: string): Promise<DmMessageRef | null> {
      const dmRows = await sql<{ thread_id: string; deleted_at: Date | null }[]>`
        SELECT thread_id, deleted_at FROM dm_messages WHERE id = ${messageId} LIMIT 1
      `
      const dm = dmRows[0]
      return dm ? { threadId: dm.thread_id, deletedAt: dm.deleted_at } : null
    },

    async findDmMessageThread(messageId: string): Promise<DmMessageThread | null> {
      const dmRows = await sql<{ thread_id: string }[]>`
        SELECT thread_id FROM dm_messages WHERE id = ${messageId} LIMIT 1
      `
      const dm = dmRows[0]
      return dm ? { threadId: dm.thread_id } : null
    },

    async isDmParticipant(threadId: string, userId: string): Promise<boolean> {
      const member = await sql<{ ok: number }[]>`
        SELECT 1 AS ok FROM dm_threads
        WHERE id = ${threadId} AND (user_lo = ${userId} OR user_hi = ${userId})
        LIMIT 1
      `
      return member.length > 0
    },

    async findChatMessageScope(messageId: string): Promise<ChatMessageScope | null> {
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
      if (!msg) return null
      return {
        cleanupId: msg.cleanup_id,
        reportId: msg.report_id,
        groupId: msg.group_id,
        deletedAt: msg.deleted_at,
      }
    },

    async findChatMessageRoom(messageId: string): Promise<ChatMessageRoom | null> {
      const chatRows = await sql<
        { cleanup_id: string | null; report_id: string | null; group_id: string | null }[]
      >`
        SELECT cleanup_id, report_id, group_id
        FROM chat_messages WHERE id = ${messageId} LIMIT 1
      `
      const msg = chatRows[0]
      if (!msg) return null
      return { cleanupId: msg.cleanup_id, reportId: msg.report_id, groupId: msg.group_id }
    },

    async isCleanupMember(cleanupId: string, userId: string): Promise<boolean> {
      const member = await sql<{ ok: number }[]>`
        SELECT 1 AS ok FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} LIMIT 1
      `
      return member.length > 0
    },

    async findGroupAccess(groupId: string, userId: string): Promise<RoomAccess | null> {
      const rows = await sql<{ visibility: string; is_member: boolean }[]>`
        SELECT g.visibility,
               EXISTS (
                 SELECT 1 FROM chat_group_members m
                 WHERE m.group_id = g.id AND m.user_id = ${userId}
               ) AS is_member
        FROM chat_groups g WHERE g.id = ${groupId} LIMIT 1
      `
      const group = rows[0]
      return group ? { visibility: group.visibility, isMember: group.is_member } : null
    },

    async findEventAccess(mediaId: string, viewerId: string | null): Promise<RoomAccess | null> {
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
        FROM (${eventsBindingMedia(sql, mediaId)}) c
        ORDER BY c.id
        LIMIT 1
      `
      const event = rows[0]
      return event ? { visibility: event.visibility, isMember: event.is_member } : null
    },

    async isLiveOrgLogo(mediaId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM organizations
        WHERE logo_media_id = ${mediaId} AND deleted_at IS NULL
        LIMIT 1
      `
      return rows.length > 0
    },

    async findPostAccess(postId: string): Promise<PostAccess | null> {
      const rows = await sql<{ author_id: string; visibility: string; deleted_at: Date | null }[]>`
        SELECT author_id, visibility, deleted_at FROM posts WHERE id = ${postId} LIMIT 1
      `
      const post = rows[0]
      if (!post) return null
      return { authorId: post.author_id, visibility: post.visibility, deletedAt: post.deleted_at }
    },

    async findReportAccess(reportId: string): Promise<ReportAccess | null> {
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
      if (!report) return null
      return {
        reporterUserId: report.reporter_user_id,
        status: report.status,
        visibility: report.visibility,
        deletedAt: report.deleted_at,
      }
    },

    async isAvatarMedia(mediaId: string): Promise<boolean> {
      const rows = await sql<{ is_avatar: boolean }[]>`
        SELECT (
          EXISTS (SELECT 1 FROM users WHERE avatar_media_id = ${mediaId})
          OR EXISTS (SELECT 1 FROM chat_groups WHERE avatar_media_id = ${mediaId})
        ) AS is_avatar
      `
      return rows[0]?.is_avatar === true
    },

    async activeUserExists(userId: string): Promise<boolean> {
      const rows = await sql<{ ok: number }[]>`
        SELECT 1 AS ok FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
      `
      return rows.length > 0
    },
  }
}
