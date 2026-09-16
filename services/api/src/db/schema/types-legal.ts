export const LEGAL_DOCUMENT_TYPE_VALUES = ["terms", "privacy", "cookies", "subprocessors"] as const

export const CONSENT_SURFACE_VALUES = ["web_register", "mobile_register", "onboarding"] as const

export const CONSENT_SUBJECT_KIND_VALUES = ["user", "donor", "organization"] as const

export type LegalDocumentTypeValue = (typeof LEGAL_DOCUMENT_TYPE_VALUES)[number]
export type ConsentSurfaceValue = (typeof CONSENT_SURFACE_VALUES)[number]
export type ConsentSubjectKind = (typeof CONSENT_SUBJECT_KIND_VALUES)[number]
