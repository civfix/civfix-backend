/**
 * Task D-C1: report-chat MEMBERSHIP + SYSTEM messages.
 *
 * Report chat already rides the shared `chat_messages` table as roomKind:"report" (commit #18):
 * user-message persistence + history live in chat-repository.drizzle.ts and are NOT reimplemented here.
 * This module adds the two things that were missing:
 *
 *   1. MEMBERSHIP on report_chat_members (migration 0041): join (idempotent upsert), leave, isMember,
 *      and a monotonic per-user read watermark (last_read_at). Mirrors cleanup_members' chat read-state
 *      convention (see chat-read-state.drizzle.ts). listMemberIds/countMembers back later tasks
 *      (D-E2 notifications, D-E3 threads).
 *
 *   2. SYSTEM messages (migration 0040): sender-less report status/timeline events posted into the report
 *      chat as first-class chat rows (kind:"system", sender_id NULL, structured system_* payload).
 *      insertSystemMessage writes the row; mapSystemRow is the PURE mapper from such a row to a
 *      ChatMessageDTO. chat-repository.drizzle.ts's report history mapper delegates to mapSystemRow for
 *      null-sender rows so system messages render in history + broadcasts.
 *
 * Written against the raw postgres-js tag (`Sql`) to match the rest of the backend. `presignMedia` is
 * accepted for signature parity with the other chat repos; system messages carry no attachments, so it
 * is currently unused here (attachment presigning stays on the user-message path in chat-repository).
 */

import type { Sql } from "../db/client.js"
import { ReportStatusSchema, type ChatMessageDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"

/**
 * The strict `system` payload shape from ChatMessageDTO (indexed-access so it stays in lock-step with
 * the shared schema — in particular the `status` enum). Non-nullable form; system rows always carry it.
 */
export type ChatSystemPayload = NonNullable<NonNullable<ChatMessageDTO["system"]>>
export type ReportSystemStatus = ChatSystemPayload["status"]

/**
 * The subset of a chat_messages row needed to render a SYSTEM message. sender_id is intentionally absent
 * (system messages have no author). Kept narrow so mapSystemRow is trivially unit-testable.
 */
export interface SystemChatRow {
  id: string
  report_id: string
  body: string | null
  created_at: Date
  system_status: string
  system_kind: string | null
  system_body: string | null
}

/**
 * PURE row -> ChatMessageDTO mapper for a report SYSTEM message. from:null + kind:"system" + the
 * structured system payload. Consistent with chat-repository.drizzle.ts's toMessageDTO for report rows
 * (cleanupId carries the report id; roomKind:"report"). Shared by the report-history mapper so a
 * null-sender row maps here instead of assuming a non-null author.
 *
 * `note` has no column of its own (there is no system_note); it is left omitted. `body` on the DTO is the
 * rendered/fallback text (the row body, which insertSystemMessage seeds from note ?? body).
 */
export function mapSystemRow(row: SystemChatRow): ChatMessageDTO {
  const system: ChatSystemPayload = {
    // system_status is a free-text column; the DB only ever receives the report-status vocabulary, so we
    // surface it as the strict ChatMessageDTO status enum.
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
  /**
   * The user's report_chat_members.role, or null when not a member (P3: feeds the chat-powers
   * resolver — report OWNERS hold pin power; delete-others in report rooms is operator-only).
   */
  roleOf(reportId: string, userId: string): Promise<"owner" | "member" | null>
  /** Idempotent upsert; keeps the existing role on conflict. Default role 'member'. */
  join(reportId: string, userId: string, role?: "owner" | "member"): Promise<void>
  leave(reportId: string, userId: string): Promise<void>
  /** Set last_read_at = the message's created_at, only ever moving the watermark forward. */
  advanceReadWatermark(reportId: string, userId: string, upToMessageId: string): Promise<void>
  insertSystemMessage(input: {
    reportId: string
    status: string
    kind?: string | null
    note?: string | null
    body?: string | null
  }): Promise<ChatMessageDTO>
  /** Member user ids for a report's chat (D-E2 notifications). */
  listMemberIds(reportId: string): Promise<string[]>
  /** Number of members in a report's chat (D-E3 threads). */
  countMembers(reportId: string): Promise<number>
}

export function makeReportChatRepository(
  sql: Sql,
  // Accepted for parity with the other chat repos; system messages have no attachments so it is unused.
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
      // Idempotent: a re-join keeps the EXISTING role (never demotes an owner back to member), so the
      // conflict clause is DO NOTHING. joined_at / last_read_at keep their original values on re-join.
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
      // Set last_read_at to the target message's created_at, monotonically (GREATEST against the current
      // value, floored at epoch 0 so a NULL prior watermark is treated as the floor). No-op when the
      // membership row is absent (non-member) or the message id does not resolve to a report row.
      await sql`
        UPDATE report_chat_members m
        SET last_read_at = GREATEST(COALESCE(m.last_read_at, to_timestamp(0)), cm.created_at)
        FROM chat_messages cm
        WHERE m.report_id = ${reportId}
          AND m.user_id = ${userId}
          AND cm.id = ${upToMessageId}
          AND cm.report_id = ${reportId}
      `
    },

    async insertSystemMessage(input: {
      reportId: string
      status: string
      kind?: string | null
      note?: string | null
      body?: string | null
    }): Promise<ChatMessageDTO> {
      // system_status is a free-text column, so validate against the shared report-status vocabulary
      // BEFORE writing any row: this throws on an out-of-vocabulary status for EVERY caller (the D-D1
      // timeline writers to come, not just D-C1), and makes mapSystemRow's `as ReportSystemStatus` cast
      // sound rather than trusted.
      const status = ReportStatusSchema.parse(input.status)
      // body (the rendered/fallback text on the DTO) prefers the human note, falling back to the raw
      // system body. sender_id stays NULL (system messages have no author); cleanup_id stays NULL so the
      // chat_messages cleanup/report XOR check holds. id / created_at default in the DB.
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

    async listMemberIds(reportId: string): Promise<string[]> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM report_chat_members
        WHERE report_id = ${reportId}
        ORDER BY joined_at ASC, user_id ASC
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
  }
}
