export const STRIPE_EVENT_PROCESS_JOB = "stripe.event.process"
export const STRIPE_EVENTS_SWEEP_JOB = "stripe.events.sweep"
export const STRIPE_ACCOUNT_SYNC_JOB = "stripe.account.sync"
export const STRIPE_PMD_REGISTER_JOB = "stripe.pmd.register"
export const DONATION_FULFILL_JOB = "donation.fulfill"
export const DONATION_RECEIPT_JOB = "donation.receipt"
export const DONATION_REFUND_SYNC_JOB = "donation.refund.sync"
export const DONATION_DISPUTE_SYNC_JOB = "donation.dispute.sync"
export const PAYMENTS_RECONCILE_JOB = "payments.reconcile"
export const ELIGIBILITY_IMPORT_JOB_PREFIX = "eligibility.import"
export const ELIGIBILITY_EVALUATE_JOB = "eligibility.evaluate"

export const ELIGIBILITY_IMPORT_SOURCES = [
  "irs_pub78",
  "irs_eo_bmf",
  "irs_auto_revocation",
  "ftb_revoked",
  "ca_ag_mnos",
  "ofac_sdn",
] as const

export type EligibilityImportSource = (typeof ELIGIBILITY_IMPORT_SOURCES)[number]

export function eligibilityImportQueue(source: EligibilityImportSource): string {
  return `${ELIGIBILITY_IMPORT_JOB_PREFIX}.${source}`
}

export const ELIGIBILITY_IMPORT_QUEUES = ELIGIBILITY_IMPORT_SOURCES.map(eligibilityImportQueue)
export const DONATION_RETENTION_SWEEP_JOB = "donation.retention.sweep"

export const PAYMENTS_QUEUE_NAMES = [
  STRIPE_EVENT_PROCESS_JOB,
  STRIPE_EVENTS_SWEEP_JOB,
  STRIPE_ACCOUNT_SYNC_JOB,
  STRIPE_PMD_REGISTER_JOB,
  DONATION_FULFILL_JOB,
  DONATION_RECEIPT_JOB,
  DONATION_REFUND_SYNC_JOB,
  DONATION_DISPUTE_SYNC_JOB,
  PAYMENTS_RECONCILE_JOB,
  ...ELIGIBILITY_IMPORT_QUEUES,
  ELIGIBILITY_EVALUATE_JOB,
  DONATION_RETENTION_SWEEP_JOB,
] as const

export type PaymentsQueueName = (typeof PAYMENTS_QUEUE_NAMES)[number]

export const PAYMENTS_JOB_RETRY_LIMIT = 5
