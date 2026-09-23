import { AppError, ErrorCode } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type { Mailer } from "@civfix/shared/interfaces"
import type { UserStore } from "../auth/stores.js"
import { heading, paragraph } from "../adapters/email-blocks.js"
import { renderEmailBody } from "../adapters/email-layout.js"
import { mailFailureKind } from "../adapters/mail-failure.js"
import { writeAudit } from "./admin/audit.js"

export interface DataExportServiceDeps {
  sql: Sql
  mailer: Mailer
  users?: UserStore
  fromNoReply: string
  supportEmail: string
}

/** Why a built export never reached the user: the provider refused its size, or refused the address. */
export type DataExportUndeliverable = "oversize" | "permanent"

export interface DataExportService {
  exportData(
    userId: string,
  ): Promise<{ ok: true; email: string | null; undeliverable?: DataExportUndeliverable }>
}

export const DATA_EXPORT_MAX_ROWS = 50_000

export const DATA_EXPORT_FREE_TEXT_MAX_ROWS = 5_000

export const DATA_EXPORT_BYTE_BUDGET = 8_000_000

export function buildDataExportEmail(
  supportEmail: string,
  truncatedSections: readonly string[],
): { subject: string; text: string; html: string } {
  const subject = "Your civfix data export"
  const blocks = [
    heading("Your civfix data export"),
    paragraph("Attached is a copy of your civfix data as a JSON file (civfix-export.json)."),
    paragraph(
      "It includes your profile, reports, posts, comments, messages, events, registrations, " +
        "organizations, volunteer hours, connections, and your issued service-hours transcripts.",
    ),
    paragraph(
      "Secrets (login codes, session tokens, raw device tokens, ticket tokens) and other " +
        "people's material (host-private notes, another organization's verification evidence) " +
        "are intentionally excluded.",
      { muted: true },
    ),
  ]
  if (truncatedSections.length > 0) {
    blocks.push(
      paragraph(
        `Note: some sections (${truncatedSections.join(", ")}) were very large and this export ` +
          `contains only part of them. Email ${supportEmail} to request a complete copy of those sections.`,
      ),
    )
  }
  blocks.push(paragraph("If you did not request this, you can ignore this email.", { muted: true }))
  const { text, html } = renderEmailBody({ preheader: subject, blocks })
  return { subject, text, html }
}

/**
 * The JSON key order of the export's sections. Truncation is reported in this order even though the byte
 * budget is spent on the small structured sections first.
 */
const DATA_EXPORT_SECTION_ORDER = [
  "reports",
  "posts",
  "comments",
  "chatMessages",
  "dmMessages",
  "volunteerHours",
  "cleanupsOrganized",
  "cleanupsJoined",
  "following",
  "followers",
  "blocks",
  "pushTokens",
  "certificates",
  "organizations",
  "eventTeamMemberships",
  "eventConsents",
  "eventRegistrations",
  "eventAnswers",
  "eventCheckins",
] as const

export function buildDataExportUndeliverableEmail(supportEmail: string): {
  subject: string
  text: string
  html: string
} {
  const subject = "Your civfix data export"
  const blocks = [
    heading("Your civfix data export"),
    paragraph(
      "Your data export was too large to send by email. Your request is on record, and our team " +
        `will send you a complete copy. You can also email ${supportEmail} about it.`,
    ),
    paragraph("If you did not request this, you can ignore this email.", { muted: true }),
  ]
  const { text, html } = renderEmailBody({ preheader: subject, blocks })
  return { subject, text, html }
}

export function makeDataExportService(deps: DataExportServiceDeps): DataExportService {
  const { sql, mailer, users, fromNoReply, supportEmail } = deps

  /**
   * The operator-visible trail for an export that has to be fulfilled by hand. Written before any notice
   * so the request is on record even if the notice fails. Carries no address or export content.
   */
  async function recordUndeliverable(userId: string, kind: DataExportUndeliverable): Promise<void> {
    await writeAudit(sql, {
      actorId: null,
      action: "data_export.undeliverable",
      target: `user:${userId}`,
      meta: { reason: kind },
    })
  }

  async function sendUndeliverableNotice(to: string): Promise<void> {
    const notice = buildDataExportUndeliverableEmail(supportEmail)
    try {
      await mailer.sendOutbound({ from: fromNoReply, to, ...notice })
    } catch (err) {
      // The request is already on record for an operator, so a failed notice completes the job rather
      // than retrying, which would rebuild the export and hit the same size refusal again.
      throw new AppError(ErrorCode.CONFLICT, "The data export notice could not be sent", {
        cause: err,
      })
    }
  }

  return {
    async exportData(
      userId: string,
    ): Promise<{ ok: true; email: string | null; undeliverable?: DataExportUndeliverable }> {
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

      const cleanupsOrganized = sql<{ id: string; title: string | null; created_at: Date }[]>`
        SELECT id, title, created_at FROM cleanups
        WHERE organizer_user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${DATA_EXPORT_MAX_ROWS + 1}
      `
      const cleanupsJoined = sql<{ cleanup_id: string; role: string; joined_at: Date }[]>`
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

      const eventAnswers = sql<{ cleanup_id: string; prompt: string; value: string | null }[]>`
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

      const truncatedCaps = new Map<string, number>()
      let usedBytes = 0

      const fit = <T>(
        name: (typeof DATA_EXPORT_SECTION_ORDER)[number],
        rows: T[],
        rowCap: number,
      ): T[] => {
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
        if (truncated) truncatedCaps.set(name, rowCap)
        return kept
      }

      // The budget is spent on the small structured sections first, so one heavy free-text history
      // (thousands of chat messages) cannot crowd out a user's certificates, consents or registrations.
      const pushTokensFit = fit(
        "pushTokens",
        pushTokenRows.map((t) => ({
          id: t.id,
          platform: t.platform,
          token: "[REDACTED]",
          createdAt: t.created_at,
          revokedAt: t.revoked_at,
        })),
        DATA_EXPORT_MAX_ROWS,
      )
      const certificatesFit = fit("certificates", certificateRows, DATA_EXPORT_MAX_ROWS)
      const organizationsFit = fit("organizations", organizationRows, DATA_EXPORT_MAX_ROWS)
      const eventConsentsFit = fit("eventConsents", eventConsentRows, DATA_EXPORT_MAX_ROWS)
      const eventRegistrationsFit = fit(
        "eventRegistrations",
        eventRegistrationRows,
        DATA_EXPORT_MAX_ROWS,
      )
      const eventCheckinsFit = fit("eventCheckins", eventCheckinRows, DATA_EXPORT_MAX_ROWS)
      const eventTeamMembershipsFit = fit(
        "eventTeamMemberships",
        eventTeamMembershipRows,
        DATA_EXPORT_MAX_ROWS,
      )
      const volunteerHoursFit = fit("volunteerHours", volunteerHourRows, DATA_EXPORT_MAX_ROWS)
      const cleanupsOrganizedFit = fit(
        "cleanupsOrganized",
        cleanupsOrganizedRows,
        DATA_EXPORT_MAX_ROWS,
      )
      const cleanupsJoinedFit = fit("cleanupsJoined", cleanupsJoinedRows, DATA_EXPORT_MAX_ROWS)
      const followingFit = fit("following", followingRows, DATA_EXPORT_MAX_ROWS)
      const followersFit = fit("followers", followerRows, DATA_EXPORT_MAX_ROWS)
      const blocksFit = fit("blocks", blockRows, DATA_EXPORT_MAX_ROWS)
      const reportsFit = fit("reports", reportRows, DATA_EXPORT_MAX_ROWS)
      const commentsFit = fit("comments", commentRows, DATA_EXPORT_MAX_ROWS)
      const eventAnswersFit = fit("eventAnswers", eventAnswerRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS)
      const postsFit = fit("posts", postRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS)
      const chatMessagesFit = fit("chatMessages", chatRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS)
      const dmMessagesFit = fit("dmMessages", dmRows, DATA_EXPORT_FREE_TEXT_MAX_ROWS)

      const truncatedSections = DATA_EXPORT_SECTION_ORDER.filter((name) => truncatedCaps.has(name))
      const sectionCaps = Object.fromEntries(
        truncatedSections.map((name) => [name, truncatedCaps.get(name)]),
      )

      const exportObject = {
        exportedAt: new Date().toISOString(),
        format: "civfix-data-export@1",
        userId,
        profile,
        reports: reportsFit,
        posts: postsFit,
        comments: commentsFit,
        chatMessages: chatMessagesFit,
        dmMessages: dmMessagesFit,
        volunteerHours: volunteerHoursFit,
        cleanupsOrganized: cleanupsOrganizedFit,
        cleanupsJoined: cleanupsJoinedFit,
        following: followingFit.map((f) => f.followee_id),
        followers: followersFit.map((f) => f.follower_id),
        blocks: blocksFit.map((b) => b.blocked_id),
        notificationPrefs: notificationPrefRows[0] ?? null,
        pushTokens: pushTokensFit,
        certificates: certificatesFit,
        organizations: organizationsFit,
        eventTeamMemberships: eventTeamMembershipsFit,
        eventConsents: eventConsentsFit,
        eventRegistrations: eventRegistrationsFit,
        eventAnswers: eventAnswersFit,
        eventCheckins: eventCheckinsFit,
        truncated:
          truncatedSections.length > 0
            ? {
                sections: truncatedSections,
                capPerSection: DATA_EXPORT_MAX_ROWS,
                sectionCaps,
                byteBudget: DATA_EXPORT_BYTE_BUDGET,
                note: `These sections were clipped because this export reached its per-section or overall size limit. Email ${supportEmail} to request a complete copy of the truncated sections.`,
              }
            : null,
      }

      if (email === null) return { ok: true, email: null }

      const bytes = new TextEncoder().encode(JSON.stringify(exportObject))

      const rendered = buildDataExportEmail(supportEmail, truncatedSections)

      try {
        await mailer.sendOutbound({
          from: fromNoReply,
          to: email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          attachments: [
            {
              filename: "civfix-export.json",
              contentType: "application/json",
              content: bytes,
            },
          ],
        })
      } catch (err) {
        const kind = mailFailureKind(err)
        if (kind !== "oversize" && kind !== "permanent") throw err
        await recordUndeliverable(userId, kind)
        // A rejected recipient would bounce a notice too; only a size refusal can still reach the user.
        if (kind === "oversize") await sendUndeliverableNotice(email)
        return { ok: true, email, undeliverable: kind }
      }

      return { ok: true, email }
    },
  }
}
