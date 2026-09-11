
import { customType } from "drizzle-orm/pg-core"

export type GeometrySubtype = "Point" | "MultiPolygon" | "Polygon" | "Geometry"

export interface GeometryConfig {
  subtype?: GeometrySubtype
  srid?: number
}

export const geometry = customType<{ data: unknown; driverData: string; config: GeometryConfig }>({
  dataType(config) {
    const subtype = config?.subtype ?? "Geometry"
    const srid = config?.srid ?? 4326
    return `geometry(${subtype},${srid})`
  },
})

export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext"
  },
})

export const ROLE_VALUES = ["citizen", "gov_user", "gov_admin", "operator"] as const

export const REPORT_CATEGORY_VALUES = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "encampment",
  "water",
  "other",
] as const

export const REPORT_TYPE_VALUES = [
  "dump",
  "encampment",
  "graffiti",
  "infrastructure",
  "pavement",
  "vegetation",
  "other",
] as const

export const REPORT_STATUS_VALUES = [
  "submitted",
  "held",
  "published",
  "acknowledged",
  "in_progress",
  "resolved",
  "rejected",
] as const

export const GEOM_SOURCE_VALUES = ["device", "exif", "manual"] as const

export const REPORT_VISIBILITY_VALUES = ["public", "hidden"] as const

export const MEDIA_KIND_VALUES = ["image", "video"] as const

export const MEDIA_STATUS_VALUES = ["validating", "ready", "rejected", "held"] as const

export const JURISDICTION_LAYER_VALUES = ["place", "county", "state", "federal", "tribal"] as const

export const CLEANUP_TYPE_VALUES = ["site", "route"] as const

export const CLEANUP_STATUS_VALUES = ["upcoming", "active", "done", "cancelled"] as const

export const EVENT_KIND_VALUES = ["cleanup", "other_volunteer"] as const

export const CHAT_MESSAGE_KIND_VALUES = [
  "text",
  "share_pin",
  "task_complete",
  "rsvp_change",
  "system",
  "poll",
] as const

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
  "cleanup_slot",
  "hours_logged",
  "event_broadcast",
  "event_team_invite",
  "org_invite",
] as const

export const POST_KIND_VALUES = ["post", "repost", "quote", "reply"] as const

export const PUSH_PLATFORM_VALUES = ["ios", "android", "web"] as const

export const OAUTH_PROVIDER_VALUES = ["apple", "google", "email"] as const

export const REPORT_CHAT_ROLE_VALUES = ["owner", "member"] as const

export const GROUP_MEMBER_ROLE_VALUES = ["owner", "admin", "member"] as const

export const GUEST_CONTACT_CHANNEL_VALUES = ["email", "sms"] as const

export const ABUSE_SUBJECT_TYPE_VALUES = ["report", "media", "user", "anon_token"] as const

export const ABUSE_REASON_VALUES = [
  "nsfw",
  "phash_dup",
  "honeypot",
  "gps",
  "manual",
  "other",
] as const

export const ABUSE_SOURCE_VALUES = ["worker", "api", "user_report"] as const

export const DISCOVERY_STATUS_VALUES = ["open", "in_progress", "done"] as const


export const GOV_METHOD_VALUES = ["email", "cold_outreach"] as const

export const GOV_CLAIM_STATUS_VALUES = ["pending", "approved", "rejected"] as const

export const VERIFICATION_STATUS_VALUES = [
  "unverified",
  "pending",
  "verified",
  "rejected",
] as const

export const USER_ACCOUNT_STATUS_VALUES = ["active", "suspended", "review", "banned"] as const

export const USER_RISK_VALUES = ["low", "watch", "elevated", "high"] as const

export const MODERATION_KIND_VALUES = [
  "image",
  "pattern",
  "appeal",
  "gps",
  "duplicate",
  "user_report",
] as const

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

export const MODERATION_PRIORITY_VALUES = ["low", "med", "high"] as const

export const MODERATION_STATUS_VALUES = ["open", "approved", "removed", "held"] as const

export const MAIL_THREAD_STATUS_VALUES = [
  "sent",
  "delivered",
  "opened",
  "replied",
  "auto",
  "needs_action",
  "bounced",
] as const

export const MAIL_DIRECTION_VALUES = ["in", "out"] as const

export const MAIL_EVENT_TYPE_VALUES = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "opened",
  "failed",
] as const

export const INBOUND_EMAIL_STATUS_VALUES = ["unread", "read", "archived"] as const
