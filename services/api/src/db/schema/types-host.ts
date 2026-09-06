export const CLEANUP_MEMBER_ROLE_VALUES = ["organizer", "cohost", "member", "staff"] as const

export const MEDIA_PURPOSE_VALUES = [
  "report",
  "verification",
  "post",
  "event_cover",
  "event_gallery",
  "org_logo",
] as const

export const EVENT_VISIBILITY_VALUES = ["public", "unlisted", "private"] as const

export const ORGANIZATION_MEMBER_ROLE_VALUES = ["owner", "admin", "member"] as const

export const ORG_VERIFICATION_STATUS_VALUES = [
  "unverified",
  "pending",
  "verified",
  "rejected",
] as const

export const ORG_VERIFICATION_KIND_VALUES = ["nonprofit", "government", "community"] as const

export const EVENT_TEAM_ROLE_VALUES = ["cohost", "staff"] as const

export const EVENT_TEAM_INVITE_STATUS_VALUES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const

export const EVENT_CONSENT_SUBJECT_TYPE_VALUES = ["user", "guest"] as const
