export const LEGAL_DOCUMENT_TYPE_VALUES = ["terms", "privacy", "cookies", "subprocessors"] as const

export const CONSENT_SURFACE_VALUES = ["web_register", "mobile_register", "onboarding"] as const

/** consent_records.surface: the event registration surfaces, then the account acceptance ones (0231). */
export const CONSENT_RECORD_SURFACE_VALUES = [
  ...CONSENT_SURFACE_VALUES,
  "signup",
  "prompt",
  "notice",
  "event_registration",
] as const

export const CONSENT_ACTION_VALUES = ["accepted", "acknowledged"] as const

export const CONSENT_SUBJECT_KIND_VALUES = ["user", "donor", "organization"] as const

export type LegalDocumentTypeValue = (typeof LEGAL_DOCUMENT_TYPE_VALUES)[number]
export type ConsentSurfaceValue = (typeof CONSENT_SURFACE_VALUES)[number]
export type ConsentRecordSurfaceValue = (typeof CONSENT_RECORD_SURFACE_VALUES)[number]
export type ConsentActionValue = (typeof CONSENT_ACTION_VALUES)[number]
export type ConsentSubjectKind = (typeof CONSENT_SUBJECT_KIND_VALUES)[number]
