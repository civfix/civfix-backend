
import type { Sql } from "../db/client.js"
import {
  ReportStatusSchema,
  type ChatMessageDTO,
  type PersonDTO,
  type ReportChatParticipantDTO,
} from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import { monotonicReadWatermarkUpdate } from "./chat-read-state.drizzle.js"
import { publicAuthorIdentity } from "./public-author.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"

export type ChatSystemPayload = NonNullable<NonNullable<ChatMessageDTO["system"]>>
export type ReportSystemStatus = ChatSystemPayload["status"]

export interface SystemChatRow {
  id: string
  report_id: string
  body: string | null
  created_at: Date
  system_status: string
  system_kind: string | null
  system_body: string | null
}

export interface ReportMemberRowSelect {
  user_id: string
  role: "owner" | "member"
  joined_at: string
  display_name: string | null
  handle: string | null
  bio: string | null
  avatar_url: string | null
  user_deleted_at: Date | null
  is_following: boolean
  blocked_pair: boolean
}

export function toReportParticipantDTO(r: ReportMemberRowSelect): ReportChatParticipantDTO {
  const author = publicAuthorIdentity({
    id: r.user_id,
    displayName: r.display_name ?? "",
    handle: r.handle,
    avatarUrl: r.avatar_url,
    deletedAt: r.user_deleted_at,
  })
  const hidden = r.blocked_pair && !author.deleted ? hiddenIdentity(r.user_id) : null
  const user: PersonDTO = {
    id: r.user_id,
    name: hidden?.name ?? author.name,
    handle: hidden !== null ? null : author.handle,
    bio: author.deleted || hidden !== null ? null : r.bio,
    avatar: author.avatar,
    ...(hidden === null && author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: r.is_following,
    ...(author.deleted ? { deleted: true } : {}),
  }
  return { user, role: r.role, joinedAt: r.joined_at }
}

export const REPORT_CHAT_ROSTER_CAP = 200

export const REPORT_CHAT_MEMBER_SCAN_CAP = 2000

export function mapSystemRow(row: SystemChatRow): ChatMessageDTO {
  const system: ChatSystemPayload = {
    status: row.system_status as ReportSystemStatus,
    ...(row.system_kind !== null ? { kind: row.system_kind } : {}),
    ...(row.system_body !== null ? { body: row.system_body } : {}),
  }
  return {
    id: row.id,
    cleanupId: row.report_id,
    roomKind: "report",
    from: null,
    ...(row.body !== null ? { body: row.body } : {}),
    kind: "system",
    reactions: [],
    mentions: [],
    createdAt: row.created_at.toISOString(),
    system,
  }
}

export interface ReportChatRepository {
  isMember(reportId: string, userId: string): Promise<boolean>
  roleOf(reportId: string, userId: string): Promise<"owner" | "member" | null>
  join(reportId: string, userId: string, role?: "owner" | "member"): Promise<void>
  leave(reportId: string, userId: string): Promise<void>
  advanceReadWatermark(reportId: string, userId: string, upToMessageId: string): Promise<void>
  markRead(reportId: string, userId: string, at: Date): Promise<void>
  insertSystemMessage(input: {
    reportId: string
    status: string
    kind?: string | null
    note?: string | null
    body?: string | null
  }): Promise<ChatMessageDTO>
  listMemberIds(reportId: string, limit?: number): Promise<string[]>
  countMembers(reportId: string): Promise<number>
  listMembers(reportId: string, viewerId: string): Promise<ReportChatParticipantDTO[]>
}

export function makeReportChatRepository(
  sql: Sql,
  _presignMedia?: PresignMedia,
): ReportChatRepository {
  return {
    async isMember(reportId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM report_chat_members
          WHERE report_id = ${reportId} AND user_id = ${userId}
        ) AS exists
      `
      return rows[0]?.exists ?? false
    },

    async roleOf(reportId: string, userId: string): Promise<"owner" | "member" | null> {
      const rows = await sql<{ role: "owner" | "member" }[]>`
        SELECT role FROM report_chat_members
        WHERE report_id = ${reportId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.role ?? null
    },

    async join(reportId: string, userId: string, role: "owner" | "member" = "member"): Promise<void> {
      await sql`
        INSERT INTO report_chat_members (report_id, user_id, role)
        VALUES (${reportId}, ${userId}, ${role})
        ON CONFLICT (report_id, user_id) DO NOTHING
      `
    },

    async leave(reportId: string, userId: string): Promise<void> {
      await sql`
        DELETE FROM report_chat_members
        WHERE report_id = ${reportId} AND user_id = ${userId}
      `
    },

    async advanceReadWatermark(reportId: string, userId: string, upToMessageId: string): Promise<void> {
      await monotonicReadWatermarkUpdate(
        sql,
        "report_chat_members",
        { report_id: reportId, user_id: userId },
        {
          messagesTable: "chat_messages",
          messageId: upToMessageId,
          scopeColumn: "report_id",
          scopeId: reportId,
        },
      )
    },

    async markRead(reportId: string, userId: string, at: Date): Promise<void> {
      await monotonicReadWatermarkUpdate(
        sql,
        "report_chat_members",
        { report_id: reportId, user_id: userId },
        at,
      )
    },

    async insertSystemMessage(input: {
      reportId: string
      status: string
      kind?: string | null
      note?: string | null
      body?: string | null
    }): Promise<ChatMessageDTO> {
      const status = ReportStatusSchema.parse(input.status)
      const body = input.note ?? input.body ?? null
      const rows = await sql<SystemChatRow[]>`
        INSERT INTO chat_messages
          (cleanup_id, report_id, sender_id, body, kind, system_status, system_kind, system_body)
        VALUES
          (NULL, ${input.reportId}, NULL, ${body}, 'system', ${status}, ${input.kind ?? null}, ${input.body ?? null})
        RETURNING id, report_id, body, created_at, system_status, system_kind, system_body
      `
      return mapSystemRow(rows[0]!)
    },

    async listMemberIds(
      reportId: string,
      limit: number = REPORT_CHAT_MEMBER_SCAN_CAP,
    ): Promise<string[]> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM report_chat_members
        WHERE report_id = ${reportId}
        ORDER BY joined_at ASC, user_id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => r.user_id)
    },

    async countMembers(reportId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM report_chat_members
        WHERE report_id = ${reportId}
      `
      return rows[0]?.count ?? 0
    },

    async listMembers(reportId: string, viewerId: string): Promise<ReportChatParticipantDTO[]> {
      const rows = await sql<ReportMemberRowSelect[]>`
        SELECT
          m.user_id,
          m.role,
          m.joined_at,
          u.display_name,
          u.handle,
          u.bio,
          u.avatar_url,
          u.deleted_at AS user_deleted_at,
          EXISTS (
            SELECT 1 FROM follows_people f
            WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id
          ) AS is_following,
          ${blockedPairExpr(sql, viewerId, sql`u.id`)} AS blocked_pair
        FROM report_chat_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.report_id = ${reportId}
        ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END ASC,
                 m.joined_at ASC, m.user_id ASC
        LIMIT ${REPORT_CHAT_ROSTER_CAP}
      `
      return rows.map(toReportParticipantDTO)
    },
  }
}
