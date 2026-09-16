import type { Sql } from "../db/client.js"
import type { Mailer } from "@civfix/shared/interfaces"
import type { UserStore } from "../auth/stores.js"

export interface DataExportServiceDeps {
  sql: Sql
  mailer: Mailer
  users?: UserStore
  fromNoReply: string
  supportEmail: string
}

export interface DataExportService {
  exportData(userId: string): Promise<{ ok: true; email: string | null }>
}

export const DATA_EXPORT_MAX_ROWS = 50_000

export const DATA_EXPORT_FREE_TEXT_MAX_ROWS = 5_000

export const DATA_EXPORT_BYTE_BUDGET = 8_000_000

export function makeDataExportService(deps: DataExportServiceDeps): DataExportService {
  const { sql, mailer, users, fromNoReply, supportEmail } = deps

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
          donation_url: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, display_name, handle, email, email_verified, bio, avatar_url, donation_url,
               created_at, deleted_at
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

      const posts = sql<
        {
          id: string
          kind: string
          body: string | null
          visibility: string
          reply_to_id: string | null
          repost_of_id: string | null
          created_at: Date
          updated_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, kind, body, visibility, reply_to_id, repost_of_id, created_at, updated_at, deleted_at
        FROM posts
        WHERE author_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${DATA_EXPORT_FREE_TEXT_MAX_ROWS + 1}
      `

      const comments = Promise.resolve<
        { id: string; report_id: string; body: string; created_at: Date; deleted_at: Date | null }[]
      >([])

      const chatMessages = sql<
        {
          id: string
          cleanup_id: string | null
          report_id: string | null
          group_id: string | null
          body: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, cleanup_id, report_id, group_id, body, created_at, deleted_at
        FROM chat_messages
        WHERE sender_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${DATA_EXPORT_FREE_TEXT_MAX_ROWS + 1}
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
        LIMIT ${DATA_EXPORT_FREE_TEXT_MAX_ROWS + 1}
      `

      const volunteerHours = sql<
        {
          id: string
          source: string
          report_id: string | null
          cleanup_id: string | null
          jurisdiction_geoid: string | null
          hours: number
          logged_by_user_id: string | null
          created_at: Date
        }[]
      >`
        SELECT id, source, report_id, cleanup_id, jurisdiction_geoid,
          hours::float8 AS hours, logged_by_user_id, created_at
        FROM volunteer_hours
        WHERE user_id = ${userId}
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
          host_broadcasts: boolean
        }[]
      >`
        SELECT user_id, push, cleanup_chat, report_updates, follows, quiet_start, quiet_end, mentions,
          host_broadcasts
        FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
      `

      const pushTokenRowsQuery = sql<
        { id: string; platform: string; created_at: Date; revoked_at: Date | null }[]
      >`
        SELECT id, platform, created_at, revoked_at FROM push_tokens WHERE user_id = ${userId}
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const certificates = sql<
        {
          code: string
          locale: string
          holder_name: string
          holder_handle: string | null
          total_hours: number
          entry_count: number
          period_start: Date | null
          period_end: Date | null
          document_sha256: string
          byte_size: number
          issued_at: Date
          revoked_at: Date | null
          revoked_reason: string | null
        }[]
      >`
        SELECT
          code, locale, holder_name, holder_handle, total_hours::float8 AS total_hours, entry_count,
          period_start, period_end, document_sha256, byte_size, issued_at, revoked_at, revoked_reason
        FROM service_hours_certificates
        WHERE user_id = ${userId}
        ORDER BY issued_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const organizations = sql<
        { organization_id: string; slug: string; name: string; role: string; joined_at: Date }[]
      >`
        SELECT om.organization_id, o.slug, o.name, om.role, om.joined_at
        FROM organization_members om
        JOIN organizations o ON o.id = om.organization_id
        WHERE om.user_id = ${userId}
        ORDER BY om.joined_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const eventTeamMemberships = sql<
        { cleanup_id: string; role: string; joined_at: Date | null }[]
      >`
        SELECT cleanup_id, role, joined_at FROM cleanup_members
        WHERE user_id = ${userId} AND role <> 'member'
        ORDER BY joined_at DESC NULLS LAST
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const eventConsents = sql<
        {
          cleanup_id: string
          terms_version: string
          disclosure_version: string
          host_contact_opt_in: boolean
          sms_opt_in: boolean
          accepted_at: Date
        }[]
      >`
        SELECT cleanup_id, terms_version, disclosure_version, host_contact_opt_in, sms_opt_in,
          accepted_at
        FROM event_consents WHERE user_id = ${userId}
        ORDER BY accepted_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const eventRegistrations = sql<
        {
          id: string
          cleanup_id: string
          ticket_type_name: string | null
          party_size: number
          status: string
          source: string
          registered_at: Date
          cancelled_at: Date | null
        }[]
      >`
        SELECT r.id, r.cleanup_id, t.name AS ticket_type_name, r.party_size, r.status, r.source,
               r.registered_at, r.cancelled_at
        FROM cleanup_registrations r
        LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
        WHERE r.user_id = ${userId}
        ORDER BY r.registered_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const eventAnswers = sql<
        { cleanup_id: string; prompt: string; value: string | null }[]
      >`
        SELECT a.cleanup_id, q.prompt,
               COALESCE(a.value_text, a.value_json::text) AS value
        FROM cleanup_answers a
        JOIN cleanup_questions q ON q.id = a.question_id
        JOIN cleanup_registrations r ON r.id = a.registration_id
        WHERE r.user_id = ${userId} AND a.scrubbed_at IS NULL
        ORDER BY a.created_at DESC
        LIMIT ${DATA_EXPORT_FREE_TEXT_MAX_ROWS + 1}
      `

      const eventCheckins = sql<
        {
          cleanup_id: string
          seat_index: number
          checked_in_at: Date
          checkin_method: string | null
        }[]
      >`
        SELECT s.cleanup_id, s.seat_index, s.checked_in_at, s.checkin_method
        FROM cleanup_registration_seats s
        JOIN cleanup_registrations r ON r.id = s.registration_id
        WHERE r.user_id = ${userId} AND s.checked_in_at IS NOT NULL
        ORDER BY s.checked_in_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `

      const [
        reportRows,
        postRows,
        commentRows,
        chatRows,
        dmRows,
        volunteerHourRows,
        cleanupsOrganizedRows,
        cleanupsJoinedRows,
        followingRows,
        followerRows,
        blockRows,
        notificationPrefRows,
        pushTokenRows,
        certificateRows,
        organizationRows,
        eventTeamMembershipRows,
        eventConsentRows,
        eventRegistrationRows,
        eventAnswerRows,
        eventCheckinRows,
      ] = await Promise.all([
        reports,
        posts,
        comments,
        chatMessages,
        dmMessages,
        volunteerHours,
        cleanupsOrganized,
        cleanupsJoined,
        following,
        followers,
        blocks,
        notificationPrefs,
        pushTokenRowsQuery,
        certificates,
        organizations,
        eventTeamMemberships,
        eventConsents,
        eventRegistrations,
        eventAnswers,
        eventCheckins,
      ])

      const profile = profileRows[0] ?? null
      const email =
        profile?.email ?? (users ? ((await users.findById(userId))?.email ?? null) : null)

      const truncatedSections: string[] = []
      let usedBytes = 0

      const fit = <T>(name: string, rows: T[], rowCap: number): T[] => {
        let truncated = false
        let source = rows
        if (source.length > rowCap) {
          source = source.slice(0, rowCap)
          truncated = true
        }
        const kept: T[] = []
        for (const row of source) {
          const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
          if (usedBytes + size > DATA_EXPORT_BYTE_BUDGET) {
            truncated = true
            break
          }
          usedBytes += size
          kept.push(row)
        }
        if (truncated) truncatedSections.push(name)
        return kept
      }

      const exportObject = {
        exportedAt: new Date().toISOString(),
        format: "civfix-data-export@1",
        userId,
        profile,
        reports: fit("reports", reportRows, DATA_EXPORT_MAX_ROWS),
        posts: fit("posts", postRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS),
        comments: fit("comments", commentRows, DATA_EXPORT_MAX_ROWS),
        chatMessages: fit("chatMessages", chatRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS),
        dmMessages: fit("dmMessages", dmRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS),
        volunteerHours: fit("volunteerHours", volunteerHourRows, DATA_EXPORT_MAX_ROWS),
        cleanupsOrganized: fit("cleanupsOrganized", cleanupsOrganizedRows, DATA_EXPORT_MAX_ROWS),
        cleanupsJoined: fit("cleanupsJoined", cleanupsJoinedRows, DATA_EXPORT_MAX_ROWS),
        following: fit("following", followingRows, DATA_EXPORT_MAX_ROWS).map((f) => f.followee_id),
        followers: fit("followers", followerRows, DATA_EXPORT_MAX_ROWS).map((f) => f.follower_id),
        blocks: fit("blocks", blockRows, DATA_EXPORT_MAX_ROWS).map((b) => b.blocked_id),
        notificationPrefs: notificationPrefRows[0] ?? null,
        pushTokens: fit(
          "pushTokens",
          pushTokenRows.map((t) => ({
            id: t.id,
            platform: t.platform,
            token: "[REDACTED]",
            createdAt: t.created_at,
            revokedAt: t.revoked_at,
          })),
          DATA_EXPORT_MAX_ROWS,
        ),
        certificates: fit("certificates", certificateRows, DATA_EXPORT_MAX_ROWS),
        organizations: fit("organizations", organizationRows, DATA_EXPORT_MAX_ROWS),
        eventTeamMemberships: fit(
          "eventTeamMemberships",
          eventTeamMembershipRows,
          DATA_EXPORT_MAX_ROWS,
        ),
        eventConsents: fit("eventConsents", eventConsentRows, DATA_EXPORT_MAX_ROWS),
        eventRegistrations: fit("eventRegistrations", eventRegistrationRows, DATA_EXPORT_MAX_ROWS),
        eventAnswers: fit("eventAnswers", eventAnswerRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS),
        eventCheckins: fit("eventCheckins", eventCheckinRows, DATA_EXPORT_MAX_ROWS),
        truncated:
          truncatedSections.length > 0
            ? {
                sections: truncatedSections,
                capPerSection: DATA_EXPORT_MAX_ROWS,
                byteBudget: DATA_EXPORT_BYTE_BUDGET,
                note: `These sections were clipped because this export reached its per-section or overall size limit. Email ${supportEmail} to request a complete copy of the truncated sections.`,
              }
            : null,
      }

      if (email === null) return { ok: true, email: null }

      const bytes = new TextEncoder().encode(JSON.stringify(exportObject))

      const text =
        "Attached is a copy of your civfix data (JSON). It includes your profile, reports, posts, " +
        "comments, messages, events, registrations, organizations, volunteer hours, " +
        "connections, and your issued service-hours transcripts. Secrets (login codes, session " +
        "tokens, raw device tokens, ticket tokens) and other people's material (host-private notes, " +
        "another organization's verification evidence) are intentionally excluded." +
        (truncatedSections.length > 0
          ? `\n\nNote: some sections (${truncatedSections.join(", ")}) were very large and this export ` +
            `contains only part of them. Email ${supportEmail} to request a complete copy of those sections.`
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
