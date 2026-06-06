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

// ---------------------------------------------------------------------------
// PostGIS geometry custom type
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CITEXT custom type
// ---------------------------------------------------------------------------

/**
 * Case-insensitive text via the CITEXT extension. Identical to `text` in JS (`data: string`); the
 * database does the case-insensitive comparison and uniqueness. Used for email + handle columns.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext"
  },
})

// ---------------------------------------------------------------------------
// Enum value tuples (mirrors of @civfix/shared zod enums; see file header)
// ---------------------------------------------------------------------------

/** users.role / cleanup_members.role authority enum. Mirrors shared RoleSchema. */
export const ROLE_VALUES = ["citizen", "gov_user", "gov_admin", "operator"] as const

/** reports.category. Mirrors shared ReportCategorySchema. */
export const REPORT_CATEGORY_VALUES = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
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
export const JURISDICTION_LAYER_VALUES = ["place", "county", "state"] as const

/** cleanups.type. Mirrors shared CleanupTypeSchema. */
export const CLEANUP_TYPE_VALUES = ["site", "route"] as const

/** cleanups.status. Mirrors shared CleanupStatusSchema. */
export const CLEANUP_STATUS_VALUES = ["upcoming", "active", "done", "cancelled"] as const

/** chat_messages.kind. Mirrors shared ChatMessageKindSchema. */
export const CHAT_MESSAGE_KIND_VALUES = [
  "text",
  "share_pin",
  "task_complete",
  "rsvp_change",
] as const

/** notifications.type. Mirrors shared NotificationTypeSchema. */
export const NOTIFICATION_TYPE_VALUES = [
  "report_update",
  "cleanup_chat",
  "cleanup_reminder",
  "new_follower",
  "claim_available",
  "system",
] as const

/** push_tokens.platform. Mirrors the shared PushPlatformSchema. */
export const PUSH_PLATFORM_VALUES = ["ios", "android", "web"] as const

/** oauth_identities.provider. Mirrors shared OAuthProviderSchema. */
export const OAUTH_PROVIDER_VALUES = ["apple", "google", "email"] as const

/** cleanup_members.role. Mirrors shared CleanupMemberRoleSchema. */
export const CLEANUP_MEMBER_ROLE_VALUES = ["organizer", "member"] as const

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

// ---------------------------------------------------------------------------
// Phase 2 (admin / operator) enum value tuples. These mirror the @civfix/shared
// admin enums and the CHECK constraints in drizzle/0007_admin_phase2.sql.
// ---------------------------------------------------------------------------

/** gov_claims.method. Mirrors shared GovMethodSchema. */
export const GOV_METHOD_VALUES = ["email", "cold_outreach"] as const

/** gov_claims.status. Mirrors shared GovClaimStatusSchema. */
export const GOV_CLAIM_STATUS_VALUES = ["pending", "approved", "rejected"] as const

/** user_moderation.account_status. Mirrors shared UserStatusSchema. */
export const USER_ACCOUNT_STATUS_VALUES = ["active", "suspended", "review", "banned"] as const

/** user_moderation.risk. Mirrors shared RiskSchema. */
export const USER_RISK_VALUES = ["low", "watch", "elevated", "high"] as const

/** moderation_items.kind. Mirrors shared ModerationKindSchema. */
export const MODERATION_KIND_VALUES = ["image", "pattern", "appeal", "gps", "duplicate"] as const

/** moderation_items.subject_type. */
export const MODERATION_SUBJECT_TYPE_VALUES = ["report", "user", "chat"] as const

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
] as const
