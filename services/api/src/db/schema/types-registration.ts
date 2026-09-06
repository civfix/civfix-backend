export const TICKET_TYPE_VISIBILITY_VALUES = ["public", "hidden", "access_code"] as const

export const REGISTRATION_STATUS_VALUES = ["registered", "cancelled", "transferred"] as const

export const REGISTRATION_SOURCE_VALUES = ["self", "waitlist", "walkup", "transfer"] as const

export const SEAT_STATUS_VALUES = ["active", "cancelled"] as const

export const CHECKIN_METHOD_VALUES = ["scan", "manual", "self", "walkup"] as const

export const WAITLIST_STATUS_VALUES = [
  "waiting",
  "offered",
  "claimed",
  "expired",
  "cancelled",
] as const

export const EVENT_QUESTION_KIND_VALUES = [
  "short_text",
  "long_text",
  "single_select",
  "multi_select",
  "checkbox",
  "consent",
] as const

export const EVENT_PAGE_STATUS_VALUES = ["draft", "published", "unpublished"] as const

export const EVENT_PAGE_BLOCK_KIND_VALUES = [
  "hero",
  "about",
  "agenda",
  "hosts",
  "faq",
  "location",
  "sponsors",
  "donate",
  "registration",
  "contact",
] as const

export const THEME_ACCENT_VALUES = ["bloom", "moss", "sun", "sky", "lilac"] as const

export type TicketTypeVisibilityValue = (typeof TICKET_TYPE_VISIBILITY_VALUES)[number]
export type RegistrationStatusValue = (typeof REGISTRATION_STATUS_VALUES)[number]
export type RegistrationSourceValue = (typeof REGISTRATION_SOURCE_VALUES)[number]
export type SeatStatusValue = (typeof SEAT_STATUS_VALUES)[number]
export type CheckinMethodValue = (typeof CHECKIN_METHOD_VALUES)[number]
export type WaitlistStatusValue = (typeof WAITLIST_STATUS_VALUES)[number]
export type EventQuestionKindValue = (typeof EVENT_QUESTION_KIND_VALUES)[number]
export type EventPageStatusValue = (typeof EVENT_PAGE_STATUS_VALUES)[number]
export type EventPageBlockKindValue = (typeof EVENT_PAGE_BLOCK_KIND_VALUES)[number]
export type ThemeAccentValue = (typeof THEME_ACCENT_VALUES)[number]
