export const BROADCAST_KIND_VALUES = [
  "host_broadcast",
  "confirmation",
  "waitlist_promoted",
  "reminder",
  "event_updated",
  "event_cancelled",
  "thank_you",
] as const

export const BROADCAST_STATUS_VALUES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
  "failed",
] as const

export const BROADCAST_CHANNEL_VALUES = ["inapp", "push", "email", "sms"] as const

export const DELIVERY_STATUS_VALUES = [
  "pending",
  "in_flight",
  "sent",
  "failed",
  "suppressed",
  "skipped",
] as const

export const DELIVERY_SUPPRESSION_REASON_VALUES = [
  "unsubscribed",
  "muted",
  "prefs_off",
  "stop_listed",
  "bounce_suppressed",
  "no_contact",
  "contact_scrubbed",
  "kill_switch",
  "banned",
  "deleted_user",
  "cap",
  "cancelled",
] as const

export const DELIVERY_FAILURE_KIND_VALUES = [
  "transient",
  "permanent",
  "auth",
  "oversize",
  "unknown",
] as const

export const BROADCAST_RECIPIENT_KIND_VALUES = ["member", "guest"] as const

export const UNSUBSCRIBE_SCOPE_VALUES = ["event", "global"] as const

export const UNSUBSCRIBE_REASON_VALUES = ["one_click", "manual", "complaint"] as const

export const EMAIL_SUPPRESSION_REASON_VALUES = ["hard_bounce", "complaint", "manual"] as const

export const PAGE_VIEW_SOURCE_VALUES = [
  "direct",
  "search",
  "social",
  "referral",
  "app",
  "other",
] as const

export const HOST_EXPORT_KIND_VALUES = ["roster", "answers", "checkins"] as const

export const HOST_EXPORT_STATUS_VALUES = [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
] as const

export type BroadcastKindValue = (typeof BROADCAST_KIND_VALUES)[number]
export type BroadcastStatusValue = (typeof BROADCAST_STATUS_VALUES)[number]
export type BroadcastChannelValue = (typeof BROADCAST_CHANNEL_VALUES)[number]
export type DeliveryStatusValue = (typeof DELIVERY_STATUS_VALUES)[number]
export type DeliverySuppressionReasonValue = (typeof DELIVERY_SUPPRESSION_REASON_VALUES)[number]
export type DeliveryFailureKindValue = (typeof DELIVERY_FAILURE_KIND_VALUES)[number]
export type BroadcastRecipientKindValue = (typeof BROADCAST_RECIPIENT_KIND_VALUES)[number]
export type UnsubscribeScopeValue = (typeof UNSUBSCRIBE_SCOPE_VALUES)[number]
export type UnsubscribeReasonValue = (typeof UNSUBSCRIBE_REASON_VALUES)[number]
export type EmailSuppressionReasonValue = (typeof EMAIL_SUPPRESSION_REASON_VALUES)[number]
export type PageViewSourceValue = (typeof PAGE_VIEW_SOURCE_VALUES)[number]
export type HostExportKindValue = (typeof HOST_EXPORT_KIND_VALUES)[number]
export type HostExportStatusValue = (typeof HOST_EXPORT_STATUS_VALUES)[number]
