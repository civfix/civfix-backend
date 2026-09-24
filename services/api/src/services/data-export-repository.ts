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
 * Every column a personal data export can carry, as the row types of the projections in
 * data-export-repository.drizzle.ts: a column those SELECTs do not name cannot leak into an export.
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
