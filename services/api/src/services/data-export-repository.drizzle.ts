import type { Sql } from "../db/client.js"

export interface ProfileRow {
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
}

export interface ReportExportRow {
  id: string
  category: string
  title: string | null
  description: string | null
  place: string | null
  status: string
  created_at: Date
}

export interface PostExportRow {
  id: string
  kind: string
  body: string | null
  visibility: string
  reply_to_id: string | null
  repost_of_id: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface ChatMessageExportRow {
  id: string
  cleanup_id: string | null
  report_id: string | null
  group_id: string | null
  body: string | null
  created_at: Date
  deleted_at: Date | null
}

export interface DmMessageExportRow {
  id: string
  thread_id: string
  body: string | null
  created_at: Date
  deleted_at: Date | null
}

export interface VolunteerHoursExportRow {
  id: string
  source: string
  report_id: string | null
  cleanup_id: string | null
  jurisdiction_geoid: string | null
  hours: number
  logged_by_user_id: string | null
  created_at: Date
}

export interface CleanupOrganizedExportRow {
  id: string
  title: string | null
  created_at: Date
}

export interface CleanupJoinedExportRow {
  cleanup_id: string
  role: string
  joined_at: Date
}

export interface FollowingExportRow {
  followee_id: string
}

export interface FollowerExportRow {
  follower_id: string
}

export interface BlockExportRow {
  blocked_id: string
}

export interface NotificationPrefsExportRow {
  user_id: string
  push: boolean
  cleanup_chat: boolean
  report_updates: boolean
  follows: boolean
  quiet_start: string | null
  quiet_end: string | null
  mentions: boolean
  host_broadcasts: boolean
}

export interface PushTokenRow {
  id: string
  platform: string
  created_at: Date
  revoked_at: Date | null
}

export interface CertificateExportRow {
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
}

export interface OrganizationExportRow {
  organization_id: string
  slug: string
  name: string
  role: string
  joined_at: Date
}

export interface EventTeamMembershipExportRow {
  cleanup_id: string
  role: string
  joined_at: Date | null
}

export interface EventConsentExportRow {
  cleanup_id: string
  terms_version: string
  disclosure_version: string
  host_contact_opt_in: boolean
  sms_opt_in: boolean
  accepted_at: Date
}

export interface EventRegistrationExportRow {
  id: string
  cleanup_id: string
  ticket_type_name: string | null
  party_size: number
  status: string
  source: string
  registered_at: Date
  cancelled_at: Date | null
}

export interface EventAnswerExportRow {
  cleanup_id: string
  prompt: string
  value: string | null
}

export interface EventCheckinExportRow {
  cleanup_id: string
  seat_index: number
  checked_in_at: Date
  checkin_method: string | null
}

/**
 * Every column a personal data export can carry: a column that is not selected here cannot leak into one.
 * Section methods return the pending query unawaited, so the service decides when each statement is sent,
 * and fetch one row past `rowCap` so a clipped section is detectable.
 */
export interface DataExportRepository {
  profile(userId: string): Promise<ProfileRow | null>
  reports(userId: string, rowCap: number): Promise<ReportExportRow[]>
  posts(userId: string, rowCap: number): Promise<PostExportRow[]>
  chatMessages(userId: string, rowCap: number): Promise<ChatMessageExportRow[]>
  dmMessages(userId: string, rowCap: number): Promise<DmMessageExportRow[]>
  volunteerHours(userId: string, rowCap: number): Promise<VolunteerHoursExportRow[]>
  cleanupsOrganized(userId: string, rowCap: number): Promise<CleanupOrganizedExportRow[]>
  cleanupsJoined(userId: string, rowCap: number): Promise<CleanupJoinedExportRow[]>
  following(userId: string, rowCap: number): Promise<FollowingExportRow[]>
  followers(userId: string, rowCap: number): Promise<FollowerExportRow[]>
  blocks(userId: string, rowCap: number): Promise<BlockExportRow[]>
  notificationPrefs(userId: string): Promise<NotificationPrefsExportRow[]>
  /** The projection has no token column: a raw device token never reaches the export. */
  pushTokens(userId: string, rowCap: number): Promise<PushTokenRow[]>
  certificates(userId: string, rowCap: number): Promise<CertificateExportRow[]>
  organizations(userId: string, rowCap: number): Promise<OrganizationExportRow[]>
  eventTeamMemberships(userId: string, rowCap: number): Promise<EventTeamMembershipExportRow[]>
  eventConsents(userId: string, rowCap: number): Promise<EventConsentExportRow[]>
  eventRegistrations(userId: string, rowCap: number): Promise<EventRegistrationExportRow[]>
  eventAnswers(userId: string, rowCap: number): Promise<EventAnswerExportRow[]>
  eventCheckins(userId: string, rowCap: number): Promise<EventCheckinExportRow[]>
}

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
