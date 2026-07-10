
import type { Sql } from "../db/client.js"
import type { Mailer, Storage } from "@civfix/shared/interfaces"
import type { UserStore } from "../auth/stores.js"

export interface DataExportServiceDeps {
  sql: Sql
  mailer: Mailer
  storage: Storage
  users: UserStore
  fromNoReply: string
}

export interface DataExportService {
  exportData(userId: string): Promise<{ ok: true; email: string | null }>
}

export const DATA_EXPORT_MAX_ROWS = 50_000

export function makeDataExportService(deps: DataExportServiceDeps): DataExportService {
  const { sql, mailer, users, fromNoReply } = deps

  return {
    async exportData(userId: string): Promise<{ ok: true; email: string | null }> {
      const profileRows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          email: string | null
          email_verified: boolean
          bio: string | null
          avatar_url: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, display_name, handle, email, email_verified, bio, avatar_url, created_at, deleted_at
        FROM users WHERE id = ${userId} LIMIT 1
      `

      const reports = sql<
        {
          id: string
          category: string
          title: string | null
          description: string | null
          place: string | null
          status: string
          created_at: Date
        }[]
      >`
        SELECT r.id, r.category, r.title, r.description, j.name AS place, r.status, r.created_at
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.reporter_user_id = ${userId}
        ORDER BY r.created_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      // `comments` was the user's per-report DISCUSSION messages; the discussion system (and its
      // report_discussion_messages table) was removed. The kept `comments: []` field preserves the export
      // shape. The user's report-CHAT messages (roomKind:"report") already ride chat_messages and are
      // captured by the `chatMessages` query below (which filters only by sender_id).
      const comments = Promise.resolve<
        { id: string; report_id: string; body: string; created_at: Date; deleted_at: Date | null }[]
      >([])

      const chatMessages = sql<
        {
          id: string
          cleanup_id: string
          body: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, cleanup_id, body, created_at, deleted_at
        FROM chat_messages
        WHERE sender_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const dmMessages = sql<
        {
          id: string
          thread_id: string
          body: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, thread_id, body, created_at, deleted_at
        FROM dm_messages
        WHERE sender_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const cleanupsOrganized = sql<
        { id: string; title: string | null; created_at: Date }[]
      >`
        SELECT id, title, created_at FROM cleanups
        WHERE organizer_user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `
      const cleanupsJoined = sql<
        { cleanup_id: string; role: string; joined_at: Date }[]
      >`
        SELECT cleanup_id, role, joined_at FROM cleanup_members
        WHERE user_id = ${userId}
        ORDER BY joined_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const following = sql<{ followee_id: string }[]>`
        SELECT followee_id FROM follows_people WHERE follower_id = ${userId}
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `
      const followers = sql<{ follower_id: string }[]>`
        SELECT follower_id FROM follows_people WHERE followee_id = ${userId}
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `
      const blocks = sql<{ blocked_id: string }[]>`
        SELECT blocked_id FROM user_blocks WHERE blocker_id = ${userId}
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const notificationPrefs = sql<
        {
          user_id: string
          push: boolean
          cleanup_chat: boolean
          report_updates: boolean
          follows: boolean
          quiet_start: string | null
          quiet_end: string | null
          mentions: boolean
        }[]
      >`
        SELECT user_id, push, cleanup_chat, report_updates, follows, quiet_start, quiet_end, mentions
        FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
      `

      const pushTokenRowsQuery = sql<
        { id: string; platform: string; created_at: Date; revoked_at: Date | null }[]
      >`
        SELECT id, platform, created_at, revoked_at FROM push_tokens WHERE user_id = ${userId}
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const verification = sql<{ status: string; applied_at: Date }[]>`
        SELECT status, applied_at FROM user_verification WHERE user_id = ${userId} LIMIT 1
      `

      const [
        reportRows,
        commentRows,
        chatRows,
        dmRows,
        cleanupsOrganizedRows,
        cleanupsJoinedRows,
        followingRows,
        followerRows,
        blockRows,
        notificationPrefRows,
        pushTokenRows,
        verificationRows,
      ] = await Promise.all([
        reports,
        comments,
        chatMessages,
        dmMessages,
        cleanupsOrganized,
        cleanupsJoined,
        following,
        followers,
        blocks,
        notificationPrefs,
        pushTokenRowsQuery,
        verification,
      ])

      const profile = profileRows[0] ?? null
      const email = profile?.email ?? (await users.findById(userId))?.email ?? null

      const truncatedSections: string[] = []
      const clip = <T>(name: string, rows: T[]): T[] => {
        if (rows.length > DATA_EXPORT_MAX_ROWS) {
          truncatedSections.push(name)
          return rows.slice(0, DATA_EXPORT_MAX_ROWS)
        }
        return rows
      }

      const exportObject = {
        exportedAt: new Date().toISOString(),
        format: "civfix-data-export@1",
        userId,
        profile,
        reports: clip("reports", reportRows),
        comments: clip("comments", commentRows),
        chatMessages: clip("chatMessages", chatRows),
        dmMessages: clip("dmMessages", dmRows),
        cleanupsOrganized: clip("cleanupsOrganized", cleanupsOrganizedRows),
        cleanupsJoined: clip("cleanupsJoined", cleanupsJoinedRows),
        following: clip("following", followingRows).map((f) => f.followee_id),
        followers: clip("followers", followerRows).map((f) => f.follower_id),
        blocks: clip("blocks", blockRows).map((b) => b.blocked_id),
        notificationPrefs: notificationPrefRows[0] ?? null,
        pushTokens: clip("pushTokens", pushTokenRows).map((t) => ({
          id: t.id,
          platform: t.platform,
          token: "[REDACTED]",
          createdAt: t.created_at,
          revokedAt: t.revoked_at,
        })),
        verification: verificationRows[0] ?? null,
        truncated:
          truncatedSections.length > 0
            ? {
                sections: truncatedSections,
                capPerSection: DATA_EXPORT_MAX_ROWS,
                note: `These sections exceeded the per-section export cap and contain only your most recent ${DATA_EXPORT_MAX_ROWS} entries. Reply to this email to request a complete copy of the truncated sections.`,
              }
            : null,
      }

      if (email === null) return { ok: true, email: null }

      const bytes = new TextEncoder().encode(JSON.stringify(exportObject))

      const text =
        "Attached is a copy of your civfix data (JSON). It includes your profile, reports, comments, " +
        "messages, events, and connections. Secrets (login codes, session tokens, raw device tokens) " +
        "are intentionally excluded." +
        (truncatedSections.length > 0
          ? `\n\nNote: some sections (${truncatedSections.join(", ")}) were very large and this export ` +
            `contains only your most recent ${DATA_EXPORT_MAX_ROWS} entries per section. Reply to this ` +
            "email to request a complete copy of those sections."
          : "") +
        "\n\nIf you did not request this, you can ignore this email."

      await mailer.sendOutbound({
        from: fromNoReply,
        to: email,
        subject: "Your civfix data export",
        text,
        attachments: [
          {
            filename: "civfix-export.json",
            contentType: "application/json",
            content: bytes,
          },
        ],
      })

      return { ok: true, email }
    },
  }
}
