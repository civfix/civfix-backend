import { AppError } from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import { parseTimeCursor } from "../../db/cursor-helpers.js"
import type {
  DonationDisputeStateValue,
  DonationStatusValue,
  StripeEventScope,
} from "../../db/schema/types-payments.js"

export interface DonationRecord {
  id: string
  reference: string
  donorKey: string
  organizationId: string
  eventId: string | null
  userId: string | null
  donorEmail: string | null
  donorName: string | null
  shareIdentityWithOrg: boolean
  amountMinor: number
  currency: "USD"
  feeBps: number
  feePlatformMinor: number
  feeStripeMinor: number | null
  netMinor: number | null
  status: DonationStatusValue
  failureReason: string | null
  disputeState: DonationDisputeStateValue
  refundedTotalMinor: number
  feeRefundedMinor: number
  stripeAccountId: string
  stripeCheckoutSessionId: string | null
  stripePaymentIntentId: string | null
  stripeChargeId: string | null
  stripeApplicationFeeId: string | null
  cardBrand: string | null
  cardLast4: string | null
  livemode: boolean
  chargedAt: Date | null
  sessionExpiresAt: Date | null
  receiptSentAt: Date | null
  receiptKey: string | null
  receiptDocumentVersion: string | null
  consentTermsVersion: string | null
  consentDisclosureVersion: string | null
  createdAt: Date
  lastPolledAt: Date | null
}

export interface CreateDonationInput {
  id: string
  reference: string
  donorKey: string
  organizationId: string
  eventId: string | null
  userId: string | null
  donorEmail: string
  donorName: string | null
  shareIdentityWithOrg: boolean
  amountMinor: number
  feeBps: number
  feePlatformMinor: number
  stripeAccountId: string
  sessionExpiresAt: Date
  consentTermsVersion: string
  consentDisclosureVersion: string
  eligibilitySnapshot: Record<string, unknown>
  idempotencyOwner: string
  idempotencyKey: string
  livemode: boolean
  consents: readonly ConsentDocumentInput[]
  consentSurface: string
  consentScreenRoute: string | null
  consentUiTemplateVersion: string | null
  now: Date
}

export interface ConsentDocumentInput {
  documentType: string
  documentVersion: string
  documentSha256: string
}

export type CreateDonationOutcome =
  | { kind: "created"; donation: DonationRecord }
  | { kind: "replayed"; donation: DonationRecord }

export interface FulfillDonationInput {
  donationId: string
  chargeId: string | null
  paymentIntentId: string | null
  applicationFeeId: string | null
  stripeFeeMinor: number | null
  netMinor: number | null
  cardBrand: string | null
  cardLast4: string | null
  chargedAt: Date
  retentionUntil: Date
  now: Date
}

export interface RecordRefundInput {
  refundId: string
  donationId: string
  amountMinor: number
  status: string
  reason: string | null
  refundedAt: Date | null
}

export interface RecordDisputeInput {
  disputeId: string
  donationId: string
  amountMinor: number
  reason: string | null
  status: string
  state: DonationDisputeStateValue
  openedAt: Date | null
  closedAt: Date | null
  evidenceDueBy: Date | null
}

export interface OrgDonationListQuery {
  organizationId: string
  status?: DonationStatusValue
  from?: Date
  to?: Date
  cursor?: string
  limit: number
}

export interface AdminDonationListQuery {
  organizationId?: string
  status?: DonationStatusValue
  from?: Date
  to?: Date
  cursor?: string
  livemode: boolean
  limit: number
}

export interface DonationListRow extends DonationRecord {
  orgName: string
  orgSlug: string
  eventTitle: string | null
}

export const EXPIRED_CHECKOUT_CONTACT_RETENTION_DAYS = 30

export const STRIPE_EVENT_MAX_ATTEMPTS = 10

export const STRIPE_EVENT_BACKOFF_MAX_EXPONENT = 9

export interface AdminDonationOrgTotalsRow {
  organizationId: string
  orgName: string
  orgSlug: string
  count: number
  grossMinor: number
  platformFeeMinor: number
  refundedMinor: number
  firstChargedAt: Date | null
  lastChargedAt: Date | null
}

export interface EventDonationTotals extends DonationSummary {
  lastChargedAt: Date | null
}

interface DonationSummaryRowSelect {
  donation_count: string | number
  gross_minor: string | number
  platform_fee_minor: string | number
  processor_fee_minor: string | number
  net_minor: string | number
  refunded_minor: string | number
  disputed_count: string | number
}

function donationSummaryColumns(tag: Sql) {
  return tag`COUNT(*) AS donation_count,
             COALESCE(SUM(amount_minor), 0) AS gross_minor,
             COALESCE(SUM(fee_platform_minor - fee_refunded_minor), 0) AS platform_fee_minor,
             COALESCE(SUM(COALESCE(fee_stripe_minor, 0)), 0) AS processor_fee_minor,
             COALESCE(SUM(amount_minor - fee_platform_minor - COALESCE(fee_stripe_minor, 0) - refunded_total_minor), 0) AS net_minor,
             COALESCE(SUM(refunded_total_minor), 0) AS refunded_minor,
             COUNT(*) FILTER (WHERE dispute_state <> 'none') AS disputed_count`
}

function settledDonations(tag: Sql) {
  return tag`status IN ('succeeded','partially_refunded','refunded')`
}

function toDonationSummary(row: DonationSummaryRowSelect | undefined): DonationSummary {
  if (row === undefined) {
    return {
      donationCount: 0,
      grossMinor: 0,
      platformFeeMinor: 0,
      processorFeeMinor: 0,
      netMinor: 0,
      refundedMinor: 0,
      disputedCount: 0,
    }
  }
  return {
    donationCount: requiredNum(row.donation_count),
    grossMinor: requiredNum(row.gross_minor),
    platformFeeMinor: requiredNum(row.platform_fee_minor),
    processorFeeMinor: requiredNum(row.processor_fee_minor),
    netMinor: requiredNum(row.net_minor),
    refundedMinor: requiredNum(row.refunded_minor),
    disputedCount: requiredNum(row.disputed_count),
  }
}

export interface DonationSummary {
  donationCount: number
  grossMinor: number
  platformFeeMinor: number
  processorFeeMinor: number
  netMinor: number
  refundedMinor: number
  disputedCount: number
}

export interface RetentionSweepResult {
  contactNulled: number
  eventsDeleted: number
  checksDeleted: number
  revisionKeys: { source: string; sourceRevisionDate: string; r2Key: string }[]
}

export interface DonationRepository {
  create(input: CreateDonationInput): Promise<CreateDonationOutcome>
  findByIdempotency(owner: string, key: string): Promise<DonationRecord | null>
  findById(id: string): Promise<DonationRecord | null>
  findByIdForUser(id: string, userId: string): Promise<DonationRecord | null>
  findBySessionId(sessionId: string): Promise<DonationRecord | null>
  findByPaymentIntentId(paymentIntentId: string): Promise<DonationRecord | null>
  findByChargeId(chargeId: string): Promise<DonationRecord | null>
  attachCheckoutSession(input: {
    donationId: string
    sessionId: string
    paymentIntentId: string
    expiresAt: Date
  }): Promise<void>
  fulfill(input: FulfillDonationInput): Promise<boolean>
  markFailed(donationId: string, reason: string, now: Date): Promise<boolean>
  markExpired(donationId: string, now: Date): Promise<boolean>
  expirePending(now: Date, limit: number): Promise<string[]>
  touchPolled(donationId: string, now: Date): Promise<void>
  recordRefund(input: RecordRefundInput): Promise<boolean>
  refundedTotalOf(donationId: string): Promise<number>
  applyRefundTotals(input: {
    donationId: string
    refundedTotalMinor: number
    status: DonationStatusValue
    now: Date
  }): Promise<void>
  pendingAppFeeRefunds(donationId: string): Promise<
    { refundId: string; amountMinor: number; appFeeRefundState: string }[]
  >
  flagAppFeeRefundsAfterFailure(donationId: string, now: Date): Promise<string[]>
  recordAppFeeRefund(input: {
    refundId: string
    donationId: string
    appFeeRefundId: string | null
    amountMinor: number
    state: "done" | "skipped" | "failed"
    error: string | null
    now: Date
  }): Promise<void>
  recordDispute(input: RecordDisputeInput): Promise<void>
  setDisputeState(donationId: string, state: DonationDisputeStateValue, now: Date): Promise<void>
  claimReceipt(donationId: string, now: Date, reclaimAfterMs: number): Promise<DonationRecord | null>
  markReceiptSent(input: {
    donationId: string
    receiptKey: string
    documentVersion: string
    now: Date
  }): Promise<void>
  listForOrg(query: OrgDonationListQuery): Promise<DonationListRow[]>
  summaryForOrg(input: { organizationId: string; from?: Date; to?: Date }): Promise<DonationSummary>
  eventTotals(eventId: string): Promise<EventDonationTotals>
  listForUser(input: { userId: string; cursor?: string; limit: number }): Promise<DonationListRow[]>
  listForAdmin(query: AdminDonationListQuery): Promise<DonationListRow[]>
  adminTotals(query: AdminDonationListQuery): Promise<{
    grossMinor: number
    platformFeeMinor: number
    refundedMinor: number
    count: number
  }>
  adminTotalsByOrg(query: {
    from: Date
    to: Date
    status?: DonationStatusValue
    livemode: boolean
    limit: number
  }): Promise<AdminDonationOrgTotalsRow[]>
  lifetimeTotals(organizationId: string): Promise<{ grossMinor: number; count: number }>
  succeededSince(input: {
    organizationId: string
    since: Date | null
    until: Date
    limit: number
    after?: { chargedAt: Date; id: string } | null
  }): Promise<DonationRecord[]>
  unlinkUser(userId: string, now: Date): Promise<number>
  sweepContactRetention(now: Date, limit: number): Promise<number>
}

export interface StripeEventRepository {
  insert(input: {
    id: string
    scope: StripeEventScope
    type: string
    accountId: string | null
    objectId: string | null
    livemode: boolean
    apiVersion: string | null
    payload: Record<string, unknown>
    retentionUntil: Date
  }): Promise<boolean>
  find(id: string): Promise<{
    id: string
    scope: StripeEventScope
    type: string
    accountId: string | null
    livemode: boolean
    payload: Record<string, unknown>
    processedAt: Date | null
  } | null>
  markProcessed(id: string, now: Date): Promise<void>
  markFailed(id: string, error: string, now: Date): Promise<void>
  listUnprocessed(olderThan: Date, limit: number, maxAttempts: number): Promise<string[]>
  countDeadLettered(maxAttempts: number): Promise<number>
  deleteExpired(now: Date, limit: number): Promise<number>
}

interface DonationRowSelect {
  id: string
  reference: string
  donor_key: string
  organization_id: string
  event_id: string | null
  user_id: string | null
  donor_email: string | null
  donor_name: string | null
  share_identity_with_org: boolean
  amount_minor: string | number
  currency: string
  fee_bps: number
  fee_platform_minor: string | number
  fee_stripe_minor: string | number | null
  net_minor: string | number | null
  status: DonationStatusValue
  failure_reason: string | null
  dispute_state: DonationDisputeStateValue
  refunded_total_minor: string | number
  fee_refunded_minor: string | number
  stripe_account_id: string
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
  stripe_application_fee_id: string | null
  card_brand: string | null
  card_last4: string | null
  livemode: boolean
  charged_at: Date | null
  session_expires_at: Date | null
  receipt_sent_at: Date | null
  receipt_key: string | null
  receipt_document_version: string | null
  consent_terms_version: string | null
  consent_disclosure_version: string | null
  created_at: Date
  last_polled_at: Date | null
}

interface DonationListRowSelect extends DonationRowSelect {
  org_name: string
  org_slug: string
  event_title: string | null
}

function num(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === "number" ? value : Number(value)
}

function requiredNum(value: string | number): number {
  return typeof value === "number" ? value : Number(value)
}

function toDonation(row: DonationRowSelect): DonationRecord {
  return {
    id: row.id,
    reference: row.reference,
    donorKey: row.donor_key,
    organizationId: row.organization_id,
    eventId: row.event_id,
    userId: row.user_id,
    donorEmail: row.donor_email,
    donorName: row.donor_name,
    shareIdentityWithOrg: row.share_identity_with_org,
    amountMinor: requiredNum(row.amount_minor),
    currency: "USD",
    feeBps: row.fee_bps,
    feePlatformMinor: requiredNum(row.fee_platform_minor),
    feeStripeMinor: num(row.fee_stripe_minor),
    netMinor: num(row.net_minor),
    status: row.status,
    failureReason: row.failure_reason,
    disputeState: row.dispute_state,
    refundedTotalMinor: requiredNum(row.refunded_total_minor),
    feeRefundedMinor: requiredNum(row.fee_refunded_minor),
    stripeAccountId: row.stripe_account_id,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeChargeId: row.stripe_charge_id,
    stripeApplicationFeeId: row.stripe_application_fee_id,
    cardBrand: row.card_brand,
    cardLast4: row.card_last4,
    livemode: row.livemode,
    chargedAt: row.charged_at,
    sessionExpiresAt: row.session_expires_at,
    receiptSentAt: row.receipt_sent_at,
    receiptKey: row.receipt_key,
    receiptDocumentVersion: row.receipt_document_version,
    consentTermsVersion: row.consent_terms_version,
    consentDisclosureVersion: row.consent_disclosure_version,
    createdAt: row.created_at,
    lastPolledAt: row.last_polled_at,
  }
}

function toListRow(row: DonationListRowSelect): DonationListRow {
  return { ...toDonation(row), orgName: row.org_name, orgSlug: row.org_slug, eventTitle: row.event_title }
}

export interface KeysetCursor {
  at: string
  id: string
}

export function encodeDonationCursor(at: Date | null, id: string): string {
  return Buffer.from(`${at === null ? "" : at.toISOString()}|${id}`, "utf8").toString("base64url")
}

export function decodeDonationCursor(cursor: string | undefined): KeysetCursor | null {
  if (cursor === undefined || cursor.length === 0) return null
  const parsed = parseTimeCursor(Buffer.from(cursor, "base64url").toString("utf8"))
  if (parsed === null) throw AppError.validation({ cursor: "is not a valid page cursor" })
  return { at: parsed.at.toISOString(), id: parsed.id }
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505"
}

export function makeDrizzleDonationRepository(sql: Sql): DonationRepository {
  async function readOne(id: string): Promise<DonationRecord | null> {
    const rows = await sql<DonationRowSelect[]>`
      SELECT id, reference, donor_key, organization_id, event_id, user_id, donor_email, donor_name,
             share_identity_with_org, amount_minor, currency, fee_bps, fee_platform_minor,
             fee_stripe_minor, net_minor, status, failure_reason, dispute_state,
             refunded_total_minor, fee_refunded_minor, stripe_account_id,
             stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
             stripe_application_fee_id, card_brand, card_last4, livemode, charged_at,
             session_expires_at, receipt_sent_at, receipt_key, receipt_document_version,
             consent_terms_version, consent_disclosure_version, created_at, last_polled_at
        FROM donations WHERE id = ${id} LIMIT 1`
    return rows[0] === undefined ? null : toDonation(rows[0])
  }

  async function readByOwnerKey(owner: string, key: string): Promise<DonationRecord | null> {
    const rows = await sql<DonationRowSelect[]>`
      SELECT id, reference, donor_key, organization_id, event_id, user_id, donor_email, donor_name,
             share_identity_with_org, amount_minor, currency, fee_bps, fee_platform_minor,
             fee_stripe_minor, net_minor, status, failure_reason, dispute_state,
             refunded_total_minor, fee_refunded_minor, stripe_account_id,
             stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
             stripe_application_fee_id, card_brand, card_last4, livemode, charged_at,
             session_expires_at, receipt_sent_at, receipt_key, receipt_document_version,
             consent_terms_version, consent_disclosure_version, created_at, last_polled_at
        FROM donations WHERE idempotency_owner = ${owner} AND idempotency_key = ${key} LIMIT 1`
    return rows[0] === undefined ? null : toDonation(rows[0])
  }

  return {
    async create(input) {
      const replayed = await readByOwnerKey(input.idempotencyOwner, input.idempotencyKey)
      if (replayed !== null) return { kind: "replayed", donation: replayed }

      try {
        const donation = await sql.begin(async (tx) => {
          await tx`
            INSERT INTO donations (
              id, reference, donor_key, organization_id, event_id, user_id, donor_email, donor_name,
              share_identity_with_org, amount_minor, fee_bps, fee_platform_minor, stripe_account_id,
              session_expires_at, consent_terms_version, consent_disclosure_version,
              eligibility_snapshot, idempotency_owner, idempotency_key, livemode, created_at, updated_at
            ) VALUES (
              ${input.id}, ${input.reference}, ${input.donorKey}, ${input.organizationId},
              ${input.eventId}, ${input.userId}, ${input.donorEmail}, ${input.donorName},
              ${input.shareIdentityWithOrg}, ${input.amountMinor}, ${input.feeBps},
              ${input.feePlatformMinor}, ${input.stripeAccountId}, ${input.sessionExpiresAt},
              ${input.consentTermsVersion}, ${input.consentDisclosureVersion},
              ${tx.json(input.eligibilitySnapshot as Parameters<typeof tx.json>[0])}, ${input.idempotencyOwner}, ${input.idempotencyKey},
              ${input.livemode}, ${input.now}, ${input.now}
            )`

          let firstConsentId: string | null = null
          for (const document of input.consents) {
            const rows = await tx<{ id: string }[]>`
              INSERT INTO consent_records (
                subject_kind, user_id, organization_id, donation_id, donor_key, document_type,
                document_version, document_sha256, accepted_at, surface, screen_route, ui_template_version
              ) VALUES (
                ${input.userId === null ? "donor" : "user"}, ${input.userId}, ${input.organizationId},
                ${input.id}, ${input.donorKey}, ${document.documentType}, ${document.documentVersion},
                ${document.documentSha256}, ${input.now}, ${input.consentSurface},
                ${input.consentScreenRoute}, ${input.consentUiTemplateVersion}
              ) RETURNING id`
            if (firstConsentId === null) firstConsentId = rows[0]?.id ?? null
          }

          if (firstConsentId !== null) {
            await tx`UPDATE donations SET consent_record_id = ${firstConsentId} WHERE id = ${input.id}`
          }

          const rows = await tx<DonationRowSelect[]>`
            SELECT id, reference, donor_key, organization_id, event_id, user_id, donor_email, donor_name,
                   share_identity_with_org, amount_minor, currency, fee_bps, fee_platform_minor,
                   fee_stripe_minor, net_minor, status, failure_reason, dispute_state,
                   refunded_total_minor, fee_refunded_minor, stripe_account_id,
                   stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
                   stripe_application_fee_id, card_brand, card_last4, livemode, charged_at,
                   session_expires_at, receipt_sent_at, receipt_key, receipt_document_version,
                   consent_terms_version, consent_disclosure_version, created_at, last_polled_at
              FROM donations WHERE id = ${input.id} LIMIT 1`
          const row = rows[0]
          if (row === undefined) throw new Error("donation row vanished mid-create-transaction")
          return toDonation(row)
        })
        return { kind: "created", donation }
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        const existing = await readByOwnerKey(input.idempotencyOwner, input.idempotencyKey)
        if (existing === null) throw err
        return { kind: "replayed", donation: existing }
      }
    },

    findByIdempotency(owner, key) {
      return readByOwnerKey(owner, key)
    },

    findById: readOne,

    async findByIdForUser(id, userId) {
      const donation = await readOne(id)
      if (donation === null || donation.userId !== userId) return null
      return donation
    },

    async findBySessionId(sessionId) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM donations WHERE stripe_checkout_session_id = ${sessionId} LIMIT 1`
      const id = rows[0]?.id
      return id === undefined ? null : readOne(id)
    },

    async findByPaymentIntentId(paymentIntentId) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM donations WHERE stripe_payment_intent_id = ${paymentIntentId} LIMIT 1`
      const id = rows[0]?.id
      return id === undefined ? null : readOne(id)
    },

    async findByChargeId(chargeId) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM donations WHERE stripe_charge_id = ${chargeId} LIMIT 1`
      const id = rows[0]?.id
      return id === undefined ? null : readOne(id)
    },

    async attachCheckoutSession({ donationId, sessionId, paymentIntentId, expiresAt }) {
      await sql`
        UPDATE donations
           SET stripe_checkout_session_id = ${sessionId},
               stripe_payment_intent_id   = ${paymentIntentId},
               session_expires_at         = ${expiresAt},
               updated_at                 = now()
         WHERE id = ${donationId} AND stripe_checkout_session_id IS NULL`
    },

    async fulfill(input) {
      const rows = await sql<{ id: string }[]>`
        UPDATE donations SET
          status                    = 'succeeded',
          stripe_charge_id          = COALESCE(${input.chargeId}, stripe_charge_id),
          stripe_payment_intent_id  = COALESCE(stripe_payment_intent_id, ${input.paymentIntentId}),
          stripe_application_fee_id = COALESCE(${input.applicationFeeId}, stripe_application_fee_id),
          fee_stripe_minor          = COALESCE(${input.stripeFeeMinor}, fee_stripe_minor),
          net_minor                 = COALESCE(${input.netMinor}, net_minor),
          card_brand                = COALESCE(${input.cardBrand}, card_brand),
          card_last4                = COALESCE(${input.cardLast4}, card_last4),
          charged_at                = COALESCE(charged_at, ${input.chargedAt}),
          retention_until           = COALESCE(retention_until, ${input.retentionUntil}),
          updated_at                = ${input.now}
        WHERE id = ${input.donationId} AND status = 'pending'
        RETURNING id`
      return rows.length > 0
    },

    async markFailed(donationId, reason, now) {
      const rows = await sql<{ id: string }[]>`
        UPDATE donations
           SET status = 'failed', failure_reason = ${reason}, updated_at = ${now}
         WHERE id = ${donationId} AND status = 'pending'
        RETURNING id`
      return rows.length > 0
    },

    async markExpired(donationId, now) {
      const rows = await sql<{ id: string }[]>`
        UPDATE donations
           SET status = 'failed',
               failure_reason = 'session_expired',
               retention_until = COALESCE(
                 retention_until,
                 ${now}::timestamptz + ${`${EXPIRED_CHECKOUT_CONTACT_RETENTION_DAYS} days`}::interval
               ),
               updated_at = ${now}
         WHERE id = ${donationId} AND status = 'pending'
        RETURNING id`
      return rows.length > 0
    },

    async expirePending(now, limit) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM donations
         WHERE status = 'pending' AND session_expires_at IS NOT NULL AND session_expires_at < ${now}
         ORDER BY session_expires_at ASC
         LIMIT ${limit}`
      return rows.map((row) => row.id)
    },

    async touchPolled(donationId, now) {
      await sql`UPDATE donations SET last_polled_at = ${now} WHERE id = ${donationId}`
    },

    async recordRefund(input) {
      const rows = await sql<{ inserted: boolean }[]>`
        INSERT INTO donation_refunds (id, donation_id, amount_minor, status, reason, refunded_at)
        VALUES (${input.refundId}, ${input.donationId}, ${input.amountMinor}, ${input.status},
                ${input.reason}, ${input.refundedAt})
        ON CONFLICT (id) DO UPDATE SET
          status      = EXCLUDED.status,
          reason      = COALESCE(EXCLUDED.reason, donation_refunds.reason),
          refunded_at = COALESCE(EXCLUDED.refunded_at, donation_refunds.refunded_at),
          updated_at  = now()
        RETURNING (xmax = 0) AS inserted`
      return rows[0]?.inserted === true
    },

    async refundedTotalOf(donationId) {
      const rows = await sql<{ total: string | number | null }[]>`
        SELECT COALESCE(SUM(amount_minor), 0) AS total
          FROM donation_refunds
         WHERE donation_id = ${donationId}
           AND status NOT IN ('failed','canceled')`
      return num(rows[0]?.total ?? 0) ?? 0
    },

    async applyRefundTotals({ donationId, refundedTotalMinor, status, now }) {
      await sql`
        UPDATE donations
           SET refunded_total_minor = ${refundedTotalMinor},
               status               = ${status},
               updated_at           = ${now}
         WHERE id = ${donationId}`
    },

    async pendingAppFeeRefunds(donationId) {
      const rows = await sql<
        { id: string; amount_minor: string | number; app_fee_refund_state: string }[]
      >`
        SELECT id, amount_minor, app_fee_refund_state
          FROM donation_refunds
         WHERE donation_id = ${donationId}
           AND app_fee_refund_state IN ('pending','failed')
           AND status NOT IN ('failed','canceled')
         ORDER BY created_at ASC
         LIMIT 100`
      return rows.map((row) => ({
        refundId: row.id,
        amountMinor: requiredNum(row.amount_minor),
        appFeeRefundState: row.app_fee_refund_state,
      }))
    },

    async flagAppFeeRefundsAfterFailure(donationId, now) {
      const rows = await sql<{ id: string }[]>`
        UPDATE donation_refunds
           SET app_fee_refund_state = 'failed_after',
               app_fee_refund_error = 'refund failed at stripe after its application fee share was returned',
               updated_at           = ${now}
         WHERE donation_id = ${donationId}
           AND status IN ('failed','canceled')
           AND app_fee_refund_state = 'done'
        RETURNING id`
      return rows.map((row) => row.id)
    },

    async recordAppFeeRefund(input) {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE donation_refunds
             SET app_fee_refund_id    = ${input.appFeeRefundId},
                 app_fee_refund_minor = ${input.amountMinor},
                 app_fee_refund_state = ${input.state},
                 app_fee_refund_error = ${input.error},
                 updated_at           = ${input.now}
           WHERE id = ${input.refundId}`
        if (input.state === "done" && input.amountMinor > 0) {
          await tx`
            UPDATE donations
               SET fee_refunded_minor = LEAST(fee_platform_minor, fee_refunded_minor + ${input.amountMinor}),
                   updated_at         = ${input.now}
             WHERE id = ${input.donationId}`
        }
      })
    },

    async recordDispute(input) {
      await sql`
        INSERT INTO donation_disputes (
          id, donation_id, amount_minor, reason, status, state, opened_at, closed_at, evidence_due_by
        ) VALUES (
          ${input.disputeId}, ${input.donationId}, ${input.amountMinor}, ${input.reason},
          ${input.status}, ${input.state}, ${input.openedAt}, ${input.closedAt}, ${input.evidenceDueBy}
        )
        ON CONFLICT (id) DO UPDATE SET
          amount_minor    = EXCLUDED.amount_minor,
          reason          = EXCLUDED.reason,
          status          = EXCLUDED.status,
          state           = EXCLUDED.state,
          closed_at       = COALESCE(EXCLUDED.closed_at, donation_disputes.closed_at),
          evidence_due_by = COALESCE(EXCLUDED.evidence_due_by, donation_disputes.evidence_due_by),
          updated_at      = now()`
    },

    async setDisputeState(donationId, state, now) {
      await sql`
        UPDATE donations SET dispute_state = ${state}, updated_at = ${now} WHERE id = ${donationId}`
    },

    async claimReceipt(donationId, now, reclaimAfterMs) {
      const cutoff = new Date(now.getTime() - reclaimAfterMs)
      const rows = await sql<{ id: string }[]>`
        UPDATE donations
           SET receipt_attempt_at = ${now}, updated_at = ${now}
         WHERE id = ${donationId}
           AND receipt_sent_at IS NULL
           AND status IN ('succeeded','partially_refunded','refunded')
           AND (receipt_attempt_at IS NULL OR receipt_attempt_at < ${cutoff})
        RETURNING id`
      return rows.length === 0 ? null : readOne(donationId)
    },

    async markReceiptSent({ donationId, receiptKey, documentVersion, now }) {
      await sql`
        UPDATE donations
           SET receipt_sent_at = ${now}, receipt_key = ${receiptKey},
               receipt_document_version = ${documentVersion}, updated_at = ${now}
         WHERE id = ${donationId}`
    },

    async listForOrg(query) {
      const cursor = decodeDonationCursor(query.cursor)
      const rows = await sql<DonationListRowSelect[]>`
        SELECT d.id, d.reference, d.donor_key, d.organization_id, d.event_id, d.user_id,
               d.donor_email, d.donor_name, d.share_identity_with_org, d.amount_minor, d.currency,
               d.fee_bps, d.fee_platform_minor, d.fee_stripe_minor, d.net_minor, d.status,
               d.failure_reason, d.dispute_state, d.refunded_total_minor, d.fee_refunded_minor,
               d.stripe_account_id, d.stripe_checkout_session_id, d.stripe_payment_intent_id,
               d.stripe_charge_id, d.stripe_application_fee_id, d.card_brand, d.card_last4,
               d.livemode, d.charged_at, d.session_expires_at, d.receipt_sent_at, d.receipt_key,
               d.receipt_document_version, d.consent_terms_version, d.consent_disclosure_version,
               d.created_at, d.last_polled_at,
               o.name AS org_name, o.slug AS org_slug, c.title AS event_title
          FROM donations d
          JOIN organizations o ON o.id = d.organization_id
          LEFT JOIN cleanups c ON c.id = d.event_id
         WHERE d.organization_id = ${query.organizationId}
           AND d.status <> 'pending'
           AND (${query.status ?? null}::text IS NULL OR d.status = ${query.status ?? null})
           AND (${query.from ?? null}::timestamptz IS NULL OR d.charged_at >= ${query.from ?? null})
           AND (${query.to ?? null}::timestamptz IS NULL OR d.charged_at <= ${query.to ?? null})
           AND (
             ${cursor === null}
             OR (d.created_at, d.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
           )
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${query.limit}`
      return rows.map(toListRow)
    },

    async summaryForOrg({ organizationId, from, to }) {
      const rows = await sql<DonationSummaryRowSelect[]>`
        SELECT ${donationSummaryColumns(sql)}
          FROM donations
         WHERE organization_id = ${organizationId}
           AND ${settledDonations(sql)}
           AND (${from ?? null}::timestamptz IS NULL OR charged_at >= ${from ?? null})
           AND (${to ?? null}::timestamptz IS NULL OR charged_at <= ${to ?? null})`
      return toDonationSummary(rows[0])
    },

    async eventTotals(eventId) {
      const rows = await sql<(DonationSummaryRowSelect & { last_charged_at: Date | null })[]>`
        SELECT ${donationSummaryColumns(sql)},
               MAX(charged_at) AS last_charged_at
          FROM donations
         WHERE event_id = ${eventId}
           AND ${settledDonations(sql)}`
      const row = rows[0]
      return { ...toDonationSummary(row), lastChargedAt: row?.last_charged_at ?? null }
    },

    async listForUser({ userId, cursor, limit }) {
      const decoded = decodeDonationCursor(cursor)
      const rows = await sql<DonationListRowSelect[]>`
        SELECT d.id, d.reference, d.donor_key, d.organization_id, d.event_id, d.user_id,
               d.donor_email, d.donor_name, d.share_identity_with_org, d.amount_minor, d.currency,
               d.fee_bps, d.fee_platform_minor, d.fee_stripe_minor, d.net_minor, d.status,
               d.failure_reason, d.dispute_state, d.refunded_total_minor, d.fee_refunded_minor,
               d.stripe_account_id, d.stripe_checkout_session_id, d.stripe_payment_intent_id,
               d.stripe_charge_id, d.stripe_application_fee_id, d.card_brand, d.card_last4,
               d.livemode, d.charged_at, d.session_expires_at, d.receipt_sent_at, d.receipt_key,
               d.receipt_document_version, d.consent_terms_version, d.consent_disclosure_version,
               d.created_at, d.last_polled_at,
               o.name AS org_name, o.slug AS org_slug, c.title AS event_title
          FROM donations d
          JOIN organizations o ON o.id = d.organization_id
          LEFT JOIN cleanups c ON c.id = d.event_id
         WHERE d.user_id = ${userId}
           AND d.status <> 'pending'
           AND (
             ${decoded === null}
             OR (d.created_at, d.id) < (${decoded?.at ?? null}::timestamptz, ${decoded?.id ?? null}::uuid)
           )
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${limit}`
      return rows.map(toListRow)
    },

    async listForAdmin(query) {
      const cursor = decodeDonationCursor(query.cursor)
      const rows = await sql<DonationListRowSelect[]>`
        SELECT d.id, d.reference, d.donor_key, d.organization_id, d.event_id, d.user_id,
               d.donor_email, d.donor_name, d.share_identity_with_org, d.amount_minor, d.currency,
               d.fee_bps, d.fee_platform_minor, d.fee_stripe_minor, d.net_minor, d.status,
               d.failure_reason, d.dispute_state, d.refunded_total_minor, d.fee_refunded_minor,
               d.stripe_account_id, d.stripe_checkout_session_id, d.stripe_payment_intent_id,
               d.stripe_charge_id, d.stripe_application_fee_id, d.card_brand, d.card_last4,
               d.livemode, d.charged_at, d.session_expires_at, d.receipt_sent_at, d.receipt_key,
               d.receipt_document_version, d.consent_terms_version, d.consent_disclosure_version,
               d.created_at, d.last_polled_at,
               o.name AS org_name, o.slug AS org_slug, c.title AS event_title
          FROM donations d
          JOIN organizations o ON o.id = d.organization_id
          LEFT JOIN cleanups c ON c.id = d.event_id
         WHERE d.livemode = ${query.livemode}
           AND (${query.organizationId ?? null}::uuid IS NULL OR d.organization_id = ${query.organizationId ?? null})
           AND (${query.status ?? null}::text IS NULL OR d.status = ${query.status ?? null})
           AND (${query.from ?? null}::timestamptz IS NULL OR d.created_at >= ${query.from ?? null})
           AND (${query.to ?? null}::timestamptz IS NULL OR d.created_at <= ${query.to ?? null})
           AND (
             ${cursor === null}
             OR (d.created_at, d.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
           )
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${query.limit}`
      return rows.map(toListRow)
    },

    async adminTotals(query) {
      const rows = await sql<
        {
          gross_minor: string | number
          platform_fee_minor: string | number
          refunded_minor: string | number
          count: string | number
        }[]
      >`
        SELECT COALESCE(SUM(amount_minor), 0) AS gross_minor,
               COALESCE(SUM(fee_platform_minor - fee_refunded_minor), 0) AS platform_fee_minor,
               COALESCE(SUM(refunded_total_minor), 0) AS refunded_minor,
               COUNT(*) AS count
          FROM donations
         WHERE status IN ('succeeded','partially_refunded','refunded')
           AND livemode = ${query.livemode}
           AND (${query.organizationId ?? null}::uuid IS NULL OR organization_id = ${query.organizationId ?? null})
           AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
           AND (${query.from ?? null}::timestamptz IS NULL OR created_at >= ${query.from ?? null})
           AND (${query.to ?? null}::timestamptz IS NULL OR created_at <= ${query.to ?? null})`
      const row = rows[0]
      return {
        grossMinor: row === undefined ? 0 : requiredNum(row.gross_minor),
        platformFeeMinor: row === undefined ? 0 : requiredNum(row.platform_fee_minor),
        refundedMinor: row === undefined ? 0 : requiredNum(row.refunded_minor),
        count: row === undefined ? 0 : requiredNum(row.count),
      }
    },

    async adminTotalsByOrg(query) {
      const rows = await sql<
        {
          organization_id: string
          org_name: string
          org_slug: string
          count: string | number
          gross_minor: string | number
          platform_fee_minor: string | number
          refunded_minor: string | number
          first_charged_at: Date | null
          last_charged_at: Date | null
        }[]
      >`
        SELECT d.organization_id, o.name AS org_name, o.slug::text AS org_slug,
               COUNT(*) AS count,
               COALESCE(SUM(d.amount_minor), 0) AS gross_minor,
               COALESCE(SUM(d.fee_platform_minor - d.fee_refunded_minor), 0) AS platform_fee_minor,
               COALESCE(SUM(d.refunded_total_minor), 0) AS refunded_minor,
               MIN(d.charged_at) AS first_charged_at,
               MAX(d.charged_at) AS last_charged_at
          FROM donations d
          JOIN organizations o ON o.id = d.organization_id
         WHERE d.status IN ('succeeded','partially_refunded','refunded')
           AND d.livemode = ${query.livemode}
           AND (${query.status ?? null}::text IS NULL OR d.status = ${query.status ?? null})
           AND d.charged_at IS NOT NULL
           AND d.charged_at >= ${query.from}
           AND d.charged_at <= ${query.to}
         GROUP BY d.organization_id, o.name, o.slug
         ORDER BY gross_minor DESC, d.organization_id
         LIMIT ${query.limit}`
      return rows.map((row) => ({
        organizationId: row.organization_id,
        orgName: row.org_name,
        orgSlug: row.org_slug,
        count: requiredNum(row.count),
        grossMinor: requiredNum(row.gross_minor),
        platformFeeMinor: requiredNum(row.platform_fee_minor),
        refundedMinor: requiredNum(row.refunded_minor),
        firstChargedAt: row.first_charged_at,
        lastChargedAt: row.last_charged_at,
      }))
    },

    async lifetimeTotals(organizationId) {
      const rows = await sql<{ gross_minor: string | number; count: string | number }[]>`
        SELECT COALESCE(SUM(amount_minor), 0) AS gross_minor, COUNT(*) AS count
          FROM donations
         WHERE organization_id = ${organizationId}
           AND status IN ('succeeded','partially_refunded','refunded')`
      const row = rows[0]
      return {
        grossMinor: row === undefined ? 0 : requiredNum(row.gross_minor),
        count: row === undefined ? 0 : requiredNum(row.count),
      }
    },

    async succeededSince({ organizationId, since, until, limit, after }) {
      const rows = await sql<DonationRowSelect[]>`
        SELECT id, reference, donor_key, organization_id, event_id, user_id, donor_email, donor_name,
               share_identity_with_org, amount_minor, currency, fee_bps, fee_platform_minor,
               fee_stripe_minor, net_minor, status, failure_reason, dispute_state,
               refunded_total_minor, fee_refunded_minor, stripe_account_id,
               stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
               stripe_application_fee_id, card_brand, card_last4, livemode, charged_at,
               session_expires_at, receipt_sent_at, receipt_key, receipt_document_version,
               consent_terms_version, consent_disclosure_version, created_at, last_polled_at
          FROM donations
         WHERE organization_id = ${organizationId}
           AND status IN ('succeeded','partially_refunded','refunded')
           AND charged_at IS NOT NULL
           AND (${since}::timestamptz IS NULL OR charged_at > ${since})
           AND charged_at <= ${until}
           AND (
             ${after === undefined || after === null}
             OR (charged_at, id) > (${after?.chargedAt ?? null}::timestamptz, ${after?.id ?? null}::uuid)
           )
         ORDER BY charged_at ASC, id ASC
         LIMIT ${limit}`
      return rows.map(toDonation)
    },

    async unlinkUser(userId, now) {
      const rows = await sql<{ id: string }[]>`
        UPDATE donations
           SET user_id = NULL, profile_unlinked_at = COALESCE(profile_unlinked_at, ${now}),
               updated_at = ${now}
         WHERE user_id = ${userId}
        RETURNING id`
      return rows.length
    },

    async sweepContactRetention(now, limit) {
      const rows = await sql<{ id: string }[]>`
        WITH due AS (
          SELECT id FROM donations
           WHERE retention_until IS NOT NULL
             AND retention_until <= ${now}
             AND (donor_email IS NOT NULL OR donor_name IS NOT NULL)
           ORDER BY retention_until ASC
           LIMIT ${limit}
        )
        UPDATE donations d
           SET donor_email = NULL, donor_name = NULL, updated_at = ${now}
          FROM due
         WHERE d.id = due.id
        RETURNING d.id`
      return rows.length
    },
  }
}

export function makeDrizzleStripeEventRepository(sql: Sql): StripeEventRepository {
  return {
    async insert(input) {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO stripe_events (
          id, scope, type, account_id, object_id, livemode, api_version, payload, retention_until
        ) VALUES (
          ${input.id}, ${input.scope}, ${input.type}, ${input.accountId}, ${input.objectId},
          ${input.livemode}, ${input.apiVersion}, ${sql.json(input.payload as Parameters<typeof sql.json>[0])}, ${input.retentionUntil}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id`
      return rows.length > 0
    },

    async find(id) {
      const rows = await sql<
        {
          id: string
          scope: StripeEventScope
          type: string
          account_id: string | null
          livemode: boolean
          payload: Record<string, unknown>
          processed_at: Date | null
        }[]
      >`
        SELECT id, scope, type, account_id, livemode, payload, processed_at
          FROM stripe_events WHERE id = ${id} LIMIT 1`
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: row.id,
        scope: row.scope,
        type: row.type,
        accountId: row.account_id,
        livemode: row.livemode,
        payload: row.payload,
        processedAt: row.processed_at,
      }
    },

    async markProcessed(id, now) {
      await sql`
        UPDATE stripe_events
           SET processed_at = ${now}, error = NULL, attempts = attempts + 1
         WHERE id = ${id}`
    },

    async markFailed(id, error, now) {
      await sql`
        UPDATE stripe_events
           SET error = ${error.slice(0, 2000)}, attempts = attempts + 1, processed_at = NULL
         WHERE id = ${id} AND ${now}::timestamptz IS NOT NULL`
    },

    async listUnprocessed(olderThan, limit, maxAttempts) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM stripe_events
         WHERE processed_at IS NULL
           AND attempts < ${maxAttempts}
           AND received_at <
               ${olderThan}::timestamptz
               - (interval '1 minute' * ((2 ^ LEAST(attempts, ${STRIPE_EVENT_BACKOFF_MAX_EXPONENT})) - 1)::double precision)
         ORDER BY received_at ASC
         LIMIT ${limit}`
      return rows.map((row) => row.id)
    },

    async countDeadLettered(maxAttempts) {
      const rows = await sql<{ count: string | number }[]>`
        SELECT COUNT(*) AS count FROM stripe_events
         WHERE processed_at IS NULL AND attempts >= ${maxAttempts}`
      return requiredNum(rows[0]?.count ?? 0)
    },

    async deleteExpired(now, limit) {
      const rows = await sql<{ id: string }[]>`
        WITH due AS (
          SELECT id FROM stripe_events WHERE retention_until <= ${now}
           ORDER BY retention_until ASC LIMIT ${limit}
        )
        DELETE FROM stripe_events e USING due WHERE e.id = due.id RETURNING e.id`
      return rows.length
    },
  }
}
