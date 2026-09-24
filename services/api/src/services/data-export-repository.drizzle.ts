import type { Sql } from "../db/client.js"
import type {
  BlockExportRow,
  CertificateExportRow,
  ChatMessageExportRow,
  CleanupJoinedExportRow,
  CleanupOrganizedExportRow,
  DataExportRepository,
  DmMessageExportRow,
  EventAnswerExportRow,
  EventCheckinExportRow,
  EventConsentExportRow,
  EventRegistrationExportRow,
  EventTeamMembershipExportRow,
  FollowerExportRow,
  FollowingExportRow,
  NotificationPrefsExportRow,
  OrganizationExportRow,
  PostExportRow,
  ProfileRow,
  PushTokenRow,
  ReportExportRow,
  VolunteerHoursExportRow,
} from "./data-export-repository.js"

export function makeDrizzleDataExportRepository(sql: Sql): DataExportRepository {
  return {
    async profile(userId) {
      const rows = await sql<ProfileRow[]>`
        SELECT id, display_name, handle, email, email_verified, bio, avatar_url, donation_url,
               created_at, deleted_at
        FROM users WHERE id = ${userId} LIMIT 1
      `
      return rows[0] ?? null
    },

    reports: (userId, rowCap) => sql<ReportExportRow[]>`
      SELECT r.id, r.category, r.title, r.description, j.name AS place, r.status, r.created_at
      FROM reports r
      LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
      WHERE r.reporter_user_id = ${userId}
      ORDER BY r.created_at DESC
      LIMIT ${rowCap + 1}
    `,

    posts: (userId, rowCap) => sql<PostExportRow[]>`
      SELECT id, kind, body, visibility, reply_to_id, repost_of_id, created_at, updated_at, deleted_at
      FROM posts
      WHERE author_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,

    chatMessages: (userId, rowCap) => sql<ChatMessageExportRow[]>`
      SELECT id, cleanup_id, report_id, group_id, body, created_at, deleted_at
      FROM chat_messages
      WHERE sender_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,

    dmMessages: (userId, rowCap) => sql<DmMessageExportRow[]>`
      SELECT id, thread_id, body, created_at, deleted_at
      FROM dm_messages
      WHERE sender_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,

    volunteerHours: (userId, rowCap) => sql<VolunteerHoursExportRow[]>`
      SELECT id, source, report_id, cleanup_id, jurisdiction_geoid,
        hours::float8 AS hours, logged_by_user_id, created_at
      FROM volunteer_hours
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,

    cleanupsOrganized: (userId, rowCap) => sql<CleanupOrganizedExportRow[]>`
      SELECT id, title, created_at FROM cleanups
      WHERE organizer_user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,

    cleanupsJoined: (userId, rowCap) => sql<CleanupJoinedExportRow[]>`
      SELECT cleanup_id, role, joined_at FROM cleanup_members
      WHERE user_id = ${userId}
      ORDER BY joined_at DESC
      LIMIT ${rowCap + 1}
    `,

    following: (userId, rowCap) => sql<FollowingExportRow[]>`
      SELECT followee_id FROM follows_people WHERE follower_id = ${userId}
      LIMIT ${rowCap + 1}
    `,

    followers: (userId, rowCap) => sql<FollowerExportRow[]>`
      SELECT follower_id FROM follows_people WHERE followee_id = ${userId}
      LIMIT ${rowCap + 1}
    `,

    blocks: (userId, rowCap) => sql<BlockExportRow[]>`
      SELECT blocked_id FROM user_blocks WHERE blocker_id = ${userId}
      LIMIT ${rowCap + 1}
    `,

    notificationPrefs: (userId) => sql<NotificationPrefsExportRow[]>`
      SELECT user_id, push, cleanup_chat, report_updates, follows, quiet_start, quiet_end, mentions,
        host_broadcasts
      FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
    `,

    pushTokens: (userId, rowCap) => sql<PushTokenRow[]>`
      SELECT id, platform, created_at, revoked_at FROM push_tokens WHERE user_id = ${userId}
      LIMIT ${rowCap + 1}
    `,

    certificates: (userId, rowCap) => sql<CertificateExportRow[]>`
      SELECT
        code, locale, holder_name, holder_handle, total_hours::float8 AS total_hours, entry_count,
        period_start, period_end, document_sha256, byte_size, issued_at, revoked_at, revoked_reason
      FROM service_hours_certificates
      WHERE user_id = ${userId}
      ORDER BY issued_at DESC
      LIMIT ${rowCap + 1}
    `,

    organizations: (userId, rowCap) => sql<OrganizationExportRow[]>`
      SELECT om.organization_id, o.slug, o.name, om.role, om.joined_at
      FROM organization_members om
      JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = ${userId}
      ORDER BY om.joined_at DESC
      LIMIT ${rowCap + 1}
    `,

    eventTeamMemberships: (userId, rowCap) => sql<EventTeamMembershipExportRow[]>`
      SELECT cleanup_id, role, joined_at FROM cleanup_members
      WHERE user_id = ${userId} AND role <> 'member'
      ORDER BY joined_at DESC NULLS LAST
      LIMIT ${rowCap + 1}
    `,

    eventConsents: (userId, rowCap) => sql<EventConsentExportRow[]>`
      SELECT cleanup_id, terms_version, disclosure_version, host_contact_opt_in, sms_opt_in,
        accepted_at
      FROM event_consents WHERE user_id = ${userId}
      ORDER BY accepted_at DESC
      LIMIT ${rowCap + 1}
    `,

    eventRegistrations: (userId, rowCap) => sql<EventRegistrationExportRow[]>`
      SELECT r.id, r.cleanup_id, t.name AS ticket_type_name, r.party_size, r.status, r.source,
             r.registered_at, r.cancelled_at
      FROM cleanup_registrations r
      LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
      WHERE r.user_id = ${userId}
      ORDER BY r.registered_at DESC
      LIMIT ${rowCap + 1}
    `,

    eventAnswers: (userId, rowCap) => sql<EventAnswerExportRow[]>`
      SELECT a.cleanup_id, q.prompt,
             COALESCE(a.value_text, a.value_json::text) AS value
      FROM cleanup_answers a
      JOIN cleanup_questions q ON q.id = a.question_id
      JOIN cleanup_registrations r ON r.id = a.registration_id
      WHERE r.user_id = ${userId} AND a.scrubbed_at IS NULL
      ORDER BY a.created_at DESC
      LIMIT ${rowCap + 1}
    `,

    eventCheckins: (userId, rowCap) => sql<EventCheckinExportRow[]>`
      SELECT s.cleanup_id, s.seat_index, s.checked_in_at, s.checkin_method
      FROM cleanup_registration_seats s
      JOIN cleanup_registrations r ON r.id = s.registration_id
      WHERE r.user_id = ${userId} AND s.checked_in_at IS NOT NULL
      ORDER BY s.checked_in_at DESC
      LIMIT ${rowCap + 1}
    `,
  }
}
