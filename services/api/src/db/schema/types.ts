/**
 * Shared Drizzle custom column types and enum value tuples for the civfix schema.
 *
 * Two things live here:
 *
 *   1. Custom column types that drizzle-kit cannot model natively:
 *        - `geometry`  PostGIS geometry(<Subtype>,<SRID>). The value is opaque to the JS layer
 *                      (returns `unknown`): we never let drizzle serialize/parse WKB. Reads project
 *                      the geometry via ST_AsGeoJSON/ST_X/ST_Y in SQL, and writes go through
 *                      ST_GeomFromGeoJSON / ST_SetSRID(ST_MakePoint(...)) sql templates. The column
 *                      exists in the Drizzle table only so query builders can reference `t.geom`.
 *        - `citext`    case-insensitive text (CITEXT extension). Behaves like `text` in JS.
 *
 *   2. Const tuples mirroring the @civfix/shared enums. We intentionally MIRROR (copy) the values
 *      rather than importing the Zod schemas, because:
 *        - the DB layer must not depend on Zod runtime objects, and
 *        - drizzle column helpers want a literal string tuple at the type level.
 *      A unit test (test/unit/enums.test.ts) asserts these stay byte-for-byte identical to the
 *      shared Zod enums, so drift is caught at CI time rather than silently diverging.
 *
 * The hand-authored SQL in services/api/drizzle is the source of DDL truth; the `dataType()`
 * strings below only matter for `drizzle-kit generate` diff inspection.
 */

import { customType } from "drizzle-orm/pg-core"

/** Geometry subtypes we use. Mirrors the PostGIS type modifier names. */
export type GeometrySubtype = "Point" | "MultiPolygon" | "Polygon" | "Geometry"

export interface GeometryConfig {
  /** PostGIS subtype, e.g. "Point" or "MultiPolygon". Defaults to bare "Geometry". */
  subtype?: GeometrySubtype
  /** Spatial reference id. Defaults to 4326 (WGS84 lon/lat). */
  srid?: number
}

/**
 * PostGIS `geometry` column. Opaque at the JS level (`data: unknown`): all reads/writes flow
 * through sql`` templates that wrap the column in PostGIS functions, so Drizzle never tries to
 * encode/decode WKB. The generated `dataType()` string is geometry(Subtype,SRID) for diff sanity.
 */
export const geometry = customType<{ data: unknown; driverData: string; config: GeometryConfig }>({
  dataType(config) {
    const subtype = config?.subtype ?? "Geometry"
    const srid = config?.srid ?? 4326
    return `geometry(${subtype},${srid})`
  },
})

/**
 * Case-insensitive text via the CITEXT extension. Identical to `text` in JS (`data: string`); the
 * database does the case-insensitive comparison and uniqueness. Used for email + handle columns.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext"
  },
})

/** users.role / cleanup_members.role authority enum. Mirrors shared RoleSchema. */
export const ROLE_VALUES = ["citizen", "gov_user", "gov_admin", "operator"] as const

/** reports.category. Mirrors shared ReportCategorySchema. */
export const REPORT_CATEGORY_VALUES = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "encampment",
  "water",
  "other",
] as const

/** reports.type (the fine-grained issue type). Mirrors shared ReportTypeSchema (REPORT_TYPE_VALUES). */
export const REPORT_TYPE_VALUES = [
  "dump",
  "encampment",
  "graffiti",
  "infrastructure",
  "pavement",
  "vegetation",
  "other",
] as const

/** reports.status / report_timeline.status. Mirrors shared ReportStatusSchema. */
export const REPORT_STATUS_VALUES = [
  "submitted",
  "held",
  "published",
  "acknowledged",
  "in_progress",
  "resolved",
  "rejected",
] as const

/** reports.geom_source. Mirrors shared GeomSourceSchema. */
export const GEOM_SOURCE_VALUES = ["device", "exif", "manual"] as const

/** reports.visibility. Mirrors shared ReportVisibilitySchema. */
export const REPORT_VISIBILITY_VALUES = ["public", "hidden"] as const

/** media_assets.kind. Mirrors shared MediaKindSchema. */
export const MEDIA_KIND_VALUES = ["image", "video"] as const

/** media_assets.status. Mirrors shared MediaStatusSchema. */
export const MEDIA_STATUS_VALUES = ["validating", "ready", "rejected", "held"] as const

/** jurisdictions.layer. Mirrors shared JurisdictionLayerSchema. */
export const JURISDICTION_LAYER_VALUES = ["place", "county", "state", "federal", "tribal"] as const

/** cleanups.type. Mirrors shared CleanupTypeSchema. */
export const CLEANUP_TYPE_VALUES = ["site", "route"] as const

/** cleanups.status. Mirrors shared CleanupStatusSchema. */
export const CLEANUP_STATUS_VALUES = ["upcoming", "active", "done", "cancelled"] as const

/** cleanups.event_kind. Mirrors shared EventKindSchema (EVENT_KIND_VALUES). */
export const EVENT_KIND_VALUES = ["cleanup", "other_volunteer"] as const

/**
 * chat_messages.kind. Mirrors shared ChatMessageKindSchema. NOTE: 'poll' (P6 polls) ships here
 * AHEAD of the shared enum — Task 6.2 adds it to ChatMessageKindSchema in a parallel shared release;
 * test/unit/enums.test.ts tolerates exactly this one pending value until the bumped shared lands,
 * then collapses back to exact equality (same precedent as NOTIFICATION_TYPE_VALUES / 'group_chat').
 */
export const CHAT_MESSAGE_KIND_VALUES = [
  "text",
  "share_pin",
  "task_complete",
  "rsvp_change",
  "system",
  "poll",
] as const

/**
 * notifications.type. Mirrors shared NotificationTypeSchema byte-for-byte (drift-guarded by
 * test/unit/enums.test.ts). The trailing five (post_like … post_mention) are the social-feed post
 * interactions; they are present in the shared enum too, so this stays at exact equality.
 */
export const NOTIFICATION_TYPE_VALUES = [
  "report_update",
  "cleanup_chat",
  "cleanup_reminder",
  "cleanup_cancelled",
  "new_follower",
  "claim_available",
  "dm",
  "system",
  "report_chat",
  "group_chat",
  "cleanup_role",
  "post_like",
  "post_repost",
  "post_reply",
  "post_quote",
  "post_mention",
] as const

/**
 * posts.kind. Mirrors shared PostKindSchema (drift-guarded by test/unit/enums.test.ts). Repost /
 * quote / reply are all `posts` rows disambiguated by this value (+ repost_of_id / reply_to_id).
 */
export const POST_KIND_VALUES = ["post", "repost", "quote", "reply"] as const

/** push_tokens.platform. Mirrors the shared PushPlatformSchema. */
export const PUSH_PLATFORM_VALUES = ["ios", "android", "web"] as const

/** oauth_identities.provider. Mirrors shared OAuthProviderSchema. */
export const OAUTH_PROVIDER_VALUES = ["apple", "google", "email"] as const

/** cleanup_members.role. Mirrors shared CleanupMemberRoleSchema. */
export const CLEANUP_MEMBER_ROLE_VALUES = ["organizer", "cohost", "member"] as const

/**
 * report_chat_members.role. Used by the report-chat membership table added in the next task
 * (D-B2 or similar); defined here now so it's available where needed. No shared Zod schema to
 * mirror yet (report chat membership is backend-internal), so no drift-guard entry.
 */
export const REPORT_CHAT_ROLE_VALUES = ["owner", "member"] as const

/**
 * chat_group_members.role (P4 groups). Three-tier ladder: owner (creator, exactly one), admins
 * (moderate + post in channels), members. Matches the CHECK in drizzle/0047_chat_groups.sql.
 * Backend-internal for now (the shared GroupMemberRole schema lands with Task 4.2), so no
 * drift-guard entry yet.
 */
export const GROUP_MEMBER_ROLE_VALUES = ["owner", "admin", "member"] as const

/** abuse_flags.subject_type. Mirrors shared AbuseSubjectTypeSchema. */
export const ABUSE_SUBJECT_TYPE_VALUES = ["report", "media", "user", "anon_token"] as const

/** abuse_flags.reason. Mirrors shared AbuseReasonSchema. */
export const ABUSE_REASON_VALUES = [
  "nsfw",
  "phash_dup",
  "honeypot",
  "gps",
  "manual",
  "other",
] as const

/** abuse_flags.source. Mirrors shared AbuseSourceSchema. */
export const ABUSE_SOURCE_VALUES = ["worker", "api", "user_report"] as const

/** jurisdiction_discovery_tasks.status. Mirrors shared DiscoveryStatusSchema. */
export const DISCOVERY_STATUS_VALUES = ["open", "in_progress", "done"] as const

// Phase 2 (admin/operator) enum tuples — mirror the @civfix/shared admin enums and the CHECK constraints
// in drizzle/0007_admin_phase2.sql.

/** gov_claims.method. Mirrors shared GovMethodSchema. */
export const GOV_METHOD_VALUES = ["email", "cold_outreach"] as const

/** gov_claims.status. Mirrors shared GovClaimStatusSchema. */
export const GOV_CLAIM_STATUS_VALUES = ["pending", "approved", "rejected"] as const

/**
 * user_verification.status. Mirrors shared VerificationStatusSchema. NOTE: 'unverified' is the resting
 * state represented by the ABSENCE of a user_verification row — it is in the shared enum (so the tuple
 * matches) but is never stored in the column (whose CHECK allows only pending|verified|rejected).
 */
export const VERIFICATION_STATUS_VALUES = [
  "unverified",
  "pending",
  "verified",
  "rejected",
] as const

/**
 * media_assets.purpose. Mirrors shared MediaPurposeSchema. NOTE: 'post' (social-feed post media)
 * ships here AHEAD of the shared enum — the shared MediaPurposeSchema gains it in a parallel release;
 * test/unit/enums.test.ts tolerates exactly this one backend-ahead value (appended last) until the
 * bumped shared lands, then collapses back to exact equality (same precedent as ChatMessageKind
 * 'poll' / NotificationType 'group_chat').
 */
export const MEDIA_PURPOSE_VALUES = ["report", "verification", "post"] as const

/** user_moderation.account_status. Mirrors shared UserStatusSchema. */
export const USER_ACCOUNT_STATUS_VALUES = ["active", "suspended", "review", "banned"] as const

/** user_moderation.risk. Mirrors shared RiskSchema. */
export const USER_RISK_VALUES = ["low", "watch", "elevated", "high"] as const

/** moderation_items.kind. Mirrors shared ModerationKindSchema. */
export const MODERATION_KIND_VALUES = [
  "image",
  "pattern",
  "appeal",
  "gps",
  "duplicate",
  "user_report",
] as const

/** moderation_items.subject_type. Mirrors shared ModerationSubjectTypeSchema. */
export const MODERATION_SUBJECT_TYPE_VALUES = [
  "report",
  "user",
  "chat",
  "comment",
  "message",
  "event",
  "profile",
  "photo",
  "post",
] as const

/** moderation_items.priority. Mirrors shared PrioritySchema. */
export const MODERATION_PRIORITY_VALUES = ["low", "med", "high"] as const

/** moderation_items.status. */
export const MODERATION_STATUS_VALUES = ["open", "approved", "removed", "held"] as const

/** mail_threads.status. Mirrors shared MailStatusSchema (order matches the shared enum for the drift guard). */
export const MAIL_THREAD_STATUS_VALUES = [
  "sent",
  "delivered",
  "opened",
  "replied",
  "auto",
  "needs_action",
  "bounced",
] as const

/** mail_messages.direction. Mirrors shared MailDirectionSchema. */
export const MAIL_DIRECTION_VALUES = ["in", "out"] as const

/** mail_events.type. */
export const MAIL_EVENT_TYPE_VALUES = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "opened",
  "failed",
] as const

/** inbound_emails.status (catch-all inbox triage). Mirrors shared InboundEmailStatusSchema. */
export const INBOUND_EMAIL_STATUS_VALUES = ["unread", "read", "archived"] as const
