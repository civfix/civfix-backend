export const DONATION_STATUS_VALUES = [
  "pending",
  "succeeded",
  "failed",
  "refunded",
  "partially_refunded",
] as const

export const DONATION_DISPUTE_STATE_VALUES = ["none", "open", "won", "lost", "warning"] as const

export const PAYOUT_STATUS_VALUES = [
  "pending",
  "in_transit",
  "paid",
  "failed",
  "canceled",
] as const

export const ORG_PAYMENTS_STATE_VALUES = [
  "not_started",
  "onboarding",
  "ready",
  "at_risk",
  "blocked",
] as const

export const DONATE_STATE_VALUES = ["READY", "AT_RISK", "BLOCKED", "OFF"] as const

export const ELIGIBILITY_VERDICT_VALUES = [
  "unknown",
  "eligible",
  "grace",
  "ineligible",
  "review_required",
] as const

export const ELIGIBILITY_SOURCE_VALUES = [
  "irs_pub78",
  "irs_eo_bmf",
  "irs_auto_revocation",
  "ftb_revoked",
  "ca_ag_mnos",
  "ofac_sdn",
  "central_org_confirmation",
] as const

export const EIN_SOURCE_VALUES = ["org_verification", "operator"] as const

export const LEGAL_DOCUMENT_TYPE_VALUES = [
  "terms",
  "privacy",
  "cookies",
  "subprocessors",
  "donations",
  "org_donation_agreement",
  "donation_disclosure",
] as const

export const CONSENT_SURFACE_VALUES = [
  "web_donate",
  "web_org_settings",
  "web_register",
  "mobile_register",
  "onboarding",
] as const

export const DONATIONS_DISABLED_REASON_VALUES = [
  "org",
  "operator",
  "eligibility",
  "stripe_blocked",
  "deauthorized",
] as const

export const STRIPE_EVENT_SCOPE_VALUES = ["connect", "platform"] as const

export const ELIGIBILITY_VERDICT_CONTRIBUTION_VALUES = [
  "supports",
  "disqualifies",
  "neutral",
] as const

export const APP_FEE_REFUND_STATE_VALUES = [
  "pending",
  "done",
  "skipped",
  "failed",
  "failed_after",
] as const

export const CONSENT_SUBJECT_KIND_VALUES = ["user", "donor", "organization"] as const

export const AGREEMENT_CHANGE_KIND_VALUES = [
  "accepted",
  "version_published",
  "fee_changed",
  "revoked",
] as const

export const RECONCILIATION_STATUS_VALUES = ["ok", "diverged", "failed"] as const

export type DonationStatusValue = (typeof DONATION_STATUS_VALUES)[number]
export type DonationDisputeStateValue = (typeof DONATION_DISPUTE_STATE_VALUES)[number]
export type PayoutStatusValue = (typeof PAYOUT_STATUS_VALUES)[number]
export type OrgPaymentsStateValue = (typeof ORG_PAYMENTS_STATE_VALUES)[number]
export type DonateStateValue = (typeof DONATE_STATE_VALUES)[number]
export type EligibilityVerdictValue = (typeof ELIGIBILITY_VERDICT_VALUES)[number]
export type EligibilitySourceValue = (typeof ELIGIBILITY_SOURCE_VALUES)[number]
export type EinSourceValue = (typeof EIN_SOURCE_VALUES)[number]
export type LegalDocumentTypeValue = (typeof LEGAL_DOCUMENT_TYPE_VALUES)[number]
export type ConsentSurfaceValue = (typeof CONSENT_SURFACE_VALUES)[number]
export type DonationsDisabledReason = (typeof DONATIONS_DISABLED_REASON_VALUES)[number]
export type StripeEventScope = (typeof STRIPE_EVENT_SCOPE_VALUES)[number]
export type EligibilityVerdictContribution =
  (typeof ELIGIBILITY_VERDICT_CONTRIBUTION_VALUES)[number]
export type AppFeeRefundState = (typeof APP_FEE_REFUND_STATE_VALUES)[number]
export type ConsentSubjectKind = (typeof CONSENT_SUBJECT_KIND_VALUES)[number]
export type AgreementChangeKind = (typeof AGREEMENT_CHANGE_KIND_VALUES)[number]
export type ReconciliationStatus = (typeof RECONCILIATION_STATUS_VALUES)[number]
