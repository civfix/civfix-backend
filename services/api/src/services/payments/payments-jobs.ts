import type { FastifyBaseLogger } from "fastify"
import type { Jobs, Mailer, Payments, Storage } from "@civfix/shared/interfaces"
import {
  advanceStatus,
  isRefundStatusCorrection,
  isSettledDonationStatus,
  refundedDonationStatus,
} from "@civfix/shared/payments"
import type { Container } from "../../di.js"
import type { Sql } from "../../db/client.js"
import type { PaymentsEnv } from "../../env/payments-env.js"
import type {
  DonationDisputeStateValue,
  DonationStatusValue,
  PayoutStatusValue,
} from "../../db/schema/types-payments.js"
import { drainTable, registerRetentionLane } from "../host/retention-lanes.js"
import {
  makeDrizzleDonationRepository,
  makeDrizzleStripeEventRepository,
  STRIPE_EVENT_MAX_ATTEMPTS,
} from "./donation-repository.drizzle.js"
import type { DonationRepository, StripeEventRepository } from "./donation-repository.drizzle.js"
import { makeDrizzleOrgPaymentsRepository } from "./org-payments-repository.drizzle.js"
import type { OrgPaymentsRepository } from "./org-payments-repository.drizzle.js"
import { makeDrizzleOrgPayoutsRepository } from "./org-payouts-repository.drizzle.js"
import type { OrgPayoutsRepository } from "./org-payouts-repository.types.js"
import { makeDrizzleEligibilityRepository } from "./eligibility-repository.drizzle.js"
import { makeEligibilityService, type EligibilityService } from "./eligibility-service.js"
import { makeOrgPaymentsService, type OrgPaymentsService } from "./org-payments-service.js"
import { DONATION_RETENTION_YEARS } from "./donation-service.js"
import { buildDonationReceiptModel } from "./donation-receipt-model.js"
import { buildDonationReceiptPdf } from "./donation-receipt-pdf.js"
import { runPaymentsReconciliation } from "./donation-reconcile.js"
import { registerDonationExportBuilder } from "./donation-export-builder.js"
import {
  DONATION_DISPUTE_SYNC_JOB,
  DONATION_FULFILL_JOB,
  DONATION_RECEIPT_JOB,
  DONATION_REFUND_SYNC_JOB,
  DONATION_RETENTION_SWEEP_JOB,
  ELIGIBILITY_EVALUATE_JOB,
  ELIGIBILITY_IMPORT_SOURCES,
  eligibilityImportQueue,
  type EligibilityImportSource,
  PAYMENTS_JOB_RETRY_LIMIT,
  PAYMENTS_RECONCILE_JOB,
  STRIPE_ACCOUNT_SYNC_JOB,
  STRIPE_EVENTS_SWEEP_JOB,
  STRIPE_EVENT_PROCESS_JOB,
  STRIPE_PMD_REGISTER_JOB,
} from "./payments-queues.js"

export const RECEIPT_RECLAIM_MS = 10 * 60 * 1000

export const RECEIPT_KEY_PREFIX = "receipts/donations"

export const STRIPE_EVENT_RETENTION_DAYS = 400

export const STRIPE_EVENT_SWEEP_AGE_MS = 60_000

export const STRIPE_EVENT_SWEEP_LIMIT = 200

export const DONATION_EXPIRY_SWEEP_LIMIT = 500

export const ELIGIBILITY_CHECK_SWEEP_LIMIT = 1000

export const CIVFIX_PLATFORM_LEGAL_NAME = "Reach Out Los Angeles"

export const RECEIPT_EVIDENCE_SOURCES: readonly string[] = ["irs_pub78", "irs_eo_bmf"]

export const MAX_RECEIPT_EVIDENCE_CHECKS = 20

export const PAYOUT_WEBHOOK_FAILURE_MESSAGE =
  "The bank rejected this payout. Check the payout details in Stripe, then try again."

export interface PaymentsRuntime {
  sql: Sql
  env: PaymentsEnv
  jobs: Jobs
  donations: DonationRepository
  events: StripeEventRepository
  orgs: OrgPaymentsRepository
  payouts: OrgPayoutsRepository
  orgPayments: OrgPaymentsService
  eligibility: EligibilityService
  payments: Payments
  mailer: Mailer
  storage: Storage
  now: () => Date
}

export function makePaymentsRuntime(
  container: Container,
  logger?: FastifyBaseLogger,
): PaymentsRuntime {
  const env = container.env
  const sql = container.getDb().sql
  const donations = makeDrizzleDonationRepository(sql)
  const orgs = makeDrizzleOrgPaymentsRepository(sql)
  const eligibilityRepo = makeDrizzleEligibilityRepository(sql)
  const webOrigin = container.env.WEB_ORIGINS[0] ?? "https://civfix.org"

  return {
    sql,
    env,
    jobs: container.jobs,
    donations,
    events: makeDrizzleStripeEventRepository(sql),
    orgs,
    payouts: makeDrizzleOrgPayoutsRepository(sql),
    orgPayments: makeOrgPaymentsService({
      repo: orgs,
      payments: container.payments,
      jobs: container.jobs,
      env: {
        PAYMENTS_ENABLED: env.PAYMENTS_ENABLED,
        DONATION_PLATFORM_FEE_BPS: env.DONATION_PLATFORM_FEE_BPS,
        DONATION_MIN_MINOR: env.DONATION_MIN_MINOR,
        DONATION_MAX_MINOR: env.DONATION_MAX_MINOR,
        PAYMENT_METHOD_DOMAINS: env.PAYMENT_METHOD_DOMAINS,
        PUBLIC_WEB_ORIGIN: webOrigin,
      },
      ...(logger !== undefined ? { logger } : {}),
    }),
    eligibility: makeEligibilityService({
      eligibility: eligibilityRepo,
      orgs,
      storage: container.storage,
      jobs: container.jobs,
      ...(logger !== undefined ? { logger } : {}),
    }),
    payments: container.payments,
    mailer: container.mailer,
    storage: container.storage,
    now: () => new Date(),
  }
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null
  const value = (source as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readNumber(source: unknown, key: string): number | null {
  if (typeof source !== "object" || source === null) return null
  const value = (source as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function jobDataString(data: unknown, key: string): string | null {
  return readString(data, key)
}

export async function processStripeEvent(
  runtime: PaymentsRuntime,
  eventId: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const event = await runtime.events.find(eventId)
  if (event === null) {
    logger?.warn({ eventId }, "stripe.event.process: event row missing (skipped)")
    return
  }
  if (event.processedAt !== null) return

  const object = (event.payload as { data?: { object?: unknown } }).data?.object ?? null

  try {
    switch (event.type) {
      case "account.updated": {
        const accountId = event.accountId ?? readString(object, "id")
        if (accountId === null) break
        const organizationId = await runtime.orgs.findOrgIdByStripeAccount(accountId)
        if (organizationId === null) break
        await runtime.orgPayments.syncAccount(organizationId, event.id)
        break
      }
      case "account.application.deauthorized": {
        const accountId = event.accountId ?? readString(object, "id")
        if (accountId === null) break
        await runtime.orgPayments.handleDeauthorization(accountId)
        break
      }
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const sessionId = readString(object, "id")
        if (sessionId === null) break
        const donation = await runtime.donations.findBySessionId(sessionId)
        if (donation !== null) await fulfillDonation(runtime, donation.id, logger)
        break
      }
      case "checkout.session.expired": {
        const sessionId = readString(object, "id")
        if (sessionId === null) break
        const donation = await runtime.donations.findBySessionId(sessionId)
        if (donation !== null) await runtime.donations.markExpired(donation.id, runtime.now())
        break
      }
      case "payment_intent.succeeded": {
        const paymentIntentId = readString(object, "id")
        if (paymentIntentId === null) break
        const donation = await runtime.donations.findByPaymentIntentId(paymentIntentId)
        if (donation !== null) await fulfillDonation(runtime, donation.id, logger)
        break
      }
      case "payment_intent.payment_failed": {
        const paymentIntentId = readString(object, "id")
        if (paymentIntentId === null) break
        const donation = await runtime.donations.findByPaymentIntentId(paymentIntentId)
        if (donation === null) break
        logger?.info(
          { donationId: donation.id },
          "payment_intent.payment_failed recorded; the session may still be retried",
        )
        break
      }
      case "charge.refunded":
      case "charge.refund.updated": {
        const chargeId =
          event.type === "charge.refunded"
            ? (readString(object, "id") ?? readString(object, "charge"))
            : (readString(object, "charge") ?? readString(object, "id"))
        if (chargeId === null) break
        const donation = await runtime.donations.findByChargeId(chargeId)
        if (donation !== null) await syncRefunds(runtime, donation.id, logger)
        break
      }
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated": {
        await syncDispute(runtime, object, logger)
        break
      }
      case "payout.paid":
      case "payout.failed":
      case "payout.canceled":
      case "payout.updated": {
        await syncPayout(runtime, event.accountId, object, logger)
        break
      }
      case "radar.early_fraud_warning.created": {
        const chargeId = readString(object, "charge")
        if (chargeId === null) break
        const donation = await runtime.donations.findByChargeId(chargeId)
        if (donation === null) break
        await runtime.donations.setDisputeState(donation.id, "warning", runtime.now())
        logger?.error(
          { donationId: donation.id, organizationId: donation.organizationId },
          "early fraud warning on a donation: operator review required, no automatic refund",
        )
        break
      }
      default:
        break
    }
    await runtime.events.markProcessed(event.id, runtime.now())
  } catch (err) {
    await runtime.events.markFailed(
      event.id,
      err instanceof Error ? err.message : "unknown error",
      runtime.now(),
    )
    throw err
  }
}

export async function fulfillDonation(
  runtime: PaymentsRuntime,
  donationId: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const donation = await runtime.donations.findById(donationId)
  if (donation === null) return
  if (donation.stripeCheckoutSessionId === null) return
  if (donation.status !== "pending") return

  const snapshot = await runtime.payments.retrieveDonation(
    donation.stripeAccountId,
    donation.stripeCheckoutSessionId,
  )

  if (snapshot.livemode !== donation.livemode) {
    logger?.warn(
      { donationId, expected: donation.livemode, observed: snapshot.livemode },
      "donation.fulfill: livemode mismatch (ignored)",
    )
    return
  }
  if (snapshot.paymentStatus !== "paid") return

  if (
    snapshot.applicationFeeMinor !== null &&
    snapshot.applicationFeeMinor !== donation.feePlatformMinor
  ) {
    logger?.error(
      {
        donationId,
        organizationId: donation.organizationId,
        expected: donation.feePlatformMinor,
        observed: snapshot.applicationFeeMinor,
      },
      "donation.fulfill: the application fee Stripe took differs from the fee civfix agreed",
    )
  }

  const chargedAt =
    snapshot.chargedAtSec === null ? runtime.now() : new Date(snapshot.chargedAtSec * 1000)
  const retentionUntil = new Date(chargedAt)
  retentionUntil.setUTCFullYear(retentionUntil.getUTCFullYear() + DONATION_RETENTION_YEARS)

  const advanced = await runtime.donations.fulfill({
    donationId,
    chargeId: snapshot.chargeId,
    paymentIntentId: null,
    applicationFeeId: snapshot.applicationFeeId,
    stripeFeeMinor: snapshot.stripeFeeMinor,
    netMinor: snapshot.netMinor,
    cardBrand: snapshot.cardBrand,
    cardLast4: snapshot.cardLast4,
    chargedAt,
    retentionUntil,
    now: runtime.now(),
  })

  if (!advanced) return

  await runtime.jobs
    .enqueue(
      DONATION_RECEIPT_JOB,
      { donationId },
      { singletonKey: `receipt:${donationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
    )
    .catch((err: unknown) => {
      logger?.warn({ err, donationId }, "donation.receipt enqueue failed; the sweep will retry")
    })
}

export function refundStatusOf(
  current: DonationStatusValue,
  amountMinor: number,
  refundedTotalMinor: number,
): DonationStatusValue {
  if (isSettledDonationStatus(current)) {
    return refundedDonationStatus({ current, amountMinor, refundedTotalMinor })
  }
  if (refundedTotalMinor <= 0) return current
  return advanceStatus(
    current,
    refundedTotalMinor >= amountMinor ? "refunded" : "partially_refunded",
  )
}

export async function syncRefunds(
  runtime: PaymentsRuntime,
  donationId: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const donation = await runtime.donations.findById(donationId)
  if (donation === null) return
  if (donation.stripeChargeId === null) return

  const refunds = await runtime.payments.listRefunds(
    donation.stripeAccountId,
    donation.stripeChargeId,
  )
  if (refunds.length === 0) return

  for (const refund of refunds) {
    await runtime.donations.recordRefund({
      refundId: refund.id,
      donationId,
      amountMinor: refund.amountMinor,
      status: refund.status,
      reason: refund.reason,
      refundedAt: refund.createdSec === null ? null : new Date(refund.createdSec * 1000),
    })
  }

  const refundedTotalMinor = await runtime.donations.refundedTotalOf(donationId)
  const nextStatus = refundStatusOf(donation.status, donation.amountMinor, refundedTotalMinor)
  if (isRefundStatusCorrection(donation.status, nextStatus)) {
    logger?.error(
      {
        donationId,
        organizationId: donation.organizationId,
        from: donation.status,
        to: nextStatus,
        refundedTotalMinor,
      },
      "donation refund status corrected downward: a recorded refund failed at stripe",
    )
  }
  await runtime.donations.applyRefundTotals({
    donationId,
    refundedTotalMinor,
    status: nextStatus,
    now: runtime.now(),
  })

  const reversedAfterFailure = await runtime.donations.flagAppFeeRefundsAfterFailure(
    donationId,
    runtime.now(),
  )
  if (reversedAfterFailure.length > 0) {
    logger?.error(
      {
        donationId,
        organizationId: donation.organizationId,
        refundIds: reversedAfterFailure,
      },
      "application fee was refunded for a refund that later failed: stripe cannot un-refund an application fee, so civfix is short that fee until it is recovered by hand",
    )
  }

  if (!runtime.env.DONATION_REFUND_APP_FEE) return
  if (donation.stripeApplicationFeeId === null || donation.feePlatformMinor === 0) return

  const owedTotal = Math.round(
    (donation.feePlatformMinor * refundedTotalMinor) / donation.amountMinor,
  )
  let returnedMinor = donation.feeRefundedMinor
  const pending = await runtime.donations.pendingAppFeeRefunds(donationId)

  for (const target of pending) {
    const share = Math.min(
      Math.round((donation.feePlatformMinor * target.amountMinor) / donation.amountMinor),
      owedTotal - returnedMinor,
    )
    if (share <= 0) continue

    try {
      const result = await runtime.payments.refundApplicationFee(
        donation.stripeApplicationFeeId,
        share,
        `appfeerefund:${donationId}:${target.refundId}:${share}:v1`,
      )
      const returned = result.status === "skipped" ? 0 : result.amountMinor
      await runtime.donations.recordAppFeeRefund({
        refundId: target.refundId,
        donationId,
        appFeeRefundId: result.id,
        amountMinor: returned,
        state: result.status === "skipped" ? "skipped" : "done",
        error: null,
        now: runtime.now(),
      })
      returnedMinor += returned
    } catch (err) {
      await runtime.donations.recordAppFeeRefund({
        refundId: target.refundId,
        donationId,
        appFeeRefundId: null,
        amountMinor: 0,
        state: "failed",
        error: err instanceof Error ? err.message.slice(0, 500) : "unknown error",
        now: runtime.now(),
      })
      logger?.error(
        { donationId, organizationId: donation.organizationId },
        "application fee refund failed: civfix is holding a fee on refunded money",
      )
    }
  }
}

const PAYOUT_STATUS_BY_PROVIDER: Readonly<Record<string, PayoutStatusValue>> = {
  pending: "pending",
  in_transit: "in_transit",
  paid: "paid",
  failed: "failed",
  canceled: "canceled",
}

export function payoutStatusOf(status: string | null): PayoutStatusValue {
  return status === null ? "pending" : (PAYOUT_STATUS_BY_PROVIDER[status] ?? "pending")
}

export async function syncPayout(
  runtime: PaymentsRuntime,
  accountId: string | null,
  payoutObject: unknown,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (accountId === null) return
  const stripePayoutId = readString(payoutObject, "id")
  if (stripePayoutId === null) return
  const amountMinor = readNumber(payoutObject, "amount")
  if (amountMinor === null || amountMinor <= 0) return

  const organizationId = await runtime.orgs.findOrgIdByStripeAccount(accountId)
  if (organizationId === null) {
    logger?.warn({ stripePayoutId }, "payout webhook for an account civfix does not know (skipped)")
    return
  }

  const status = payoutStatusOf(readString(payoutObject, "status"))
  const arrivalSec = readNumber(payoutObject, "arrival_date")
  const createdSec = readNumber(payoutObject, "created")

  await runtime.payouts.upsertFromProvider({
    organizationId,
    stripeAccountId: accountId,
    stripePayoutId,
    amountMinor,
    status,
    arrivalDate: arrivalSec === null || arrivalSec <= 0 ? null : new Date(arrivalSec * 1000),
    failureMessage: status === "failed" ? PAYOUT_WEBHOOK_FAILURE_MESSAGE : null,
    createdAt: createdSec === null ? runtime.now() : new Date(createdSec * 1000),
    now: runtime.now(),
  })

  if (status === "failed") {
    logger?.error(
      { organizationId, stripePayoutId },
      "a payout on an organization's connected account failed: the money stayed on the account",
    )
  }
}

const DISPUTE_STATE_BY_STATUS: Readonly<Record<string, DonationDisputeStateValue>> = {
  needs_response: "open",
  under_review: "open",
  warning_needs_response: "warning",
  warning_under_review: "warning",
  warning_closed: "none",
  charge_refunded: "none",
  won: "won",
  lost: "lost",
  prevented: "lost",
}

export const TERMINAL_DISPUTE_STATUSES = new Set([
  "warning_closed",
  "charge_refunded",
  "won",
  "lost",
  "prevented",
])

export function disputeStateOf(status: string): DonationDisputeStateValue {
  return DISPUTE_STATE_BY_STATUS[status] ?? "open"
}

export async function syncDispute(
  runtime: PaymentsRuntime,
  disputeObject: unknown,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const disputeId = readString(disputeObject, "id")
  const chargeId = readString(disputeObject, "charge")
  if (disputeId === null || chargeId === null) return

  const donation = await runtime.donations.findByChargeId(chargeId)
  if (donation === null) return

  const status = readString(disputeObject, "status") ?? "needs_response"
  const state = disputeStateOf(status)
  const createdSec = readNumber(disputeObject, "created")
  const evidenceDetails = (disputeObject as { evidence_details?: unknown } | null)?.evidence_details
  const dueBySec = readNumber(evidenceDetails, "due_by")

  await runtime.donations.recordDispute({
    disputeId,
    donationId: donation.id,
    amountMinor: readNumber(disputeObject, "amount") ?? 0,
    reason: readString(disputeObject, "reason"),
    status,
    state,
    openedAt: createdSec === null ? null : new Date(createdSec * 1000),
    closedAt: TERMINAL_DISPUTE_STATUSES.has(status) ? runtime.now() : null,
    evidenceDueBy: dueBySec === null || dueBySec <= 0 ? null : new Date(dueBySec * 1000),
  })
  await runtime.donations.setDisputeState(donation.id, state, runtime.now())

  logger?.error(
    { donationId: donation.id, organizationId: donation.organizationId, state },
    "donation dispute state changed: the organization's balance is debited, not civfix's",
  )
}

export async function sendDonationReceipt(
  runtime: PaymentsRuntime,
  donationId: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const donation = await runtime.donations.claimReceipt(donationId, runtime.now(), RECEIPT_RECLAIM_MS)
  if (donation === null) return
  if (donation.chargedAt === null || donation.donorEmail === null) return

  const view = await runtime.orgs.paymentsView(donation.organizationId)
  if (view === null) return

  const eligibility = view.eligibility
  const deductible = eligibility?.contributionsDeductible === true
  const address = eligibility?.irsAddress ?? null
  const checks = await runtime.orgs.recentChecks(donation.organizationId, MAX_RECEIPT_EVIDENCE_CHECKS)
  const evidence = checks.find(
    (check) => check.matched && RECEIPT_EVIDENCE_SOURCES.includes(check.source),
  )

  const model = buildDonationReceiptModel({
    donationId: donation.id,
    reference: donation.reference,
    status: donation.status,
    amountMinor: donation.amountMinor,
    refundedTotalMinor: donation.refundedTotalMinor,
    chargedAt: donation.chargedAt,
    donorEmail: donation.donorEmail,
    donorName: donation.donorName,
    feeBps: donation.feeBps,
    feePlatformMinor: donation.feePlatformMinor,
    feeStripeMinor: donation.feeStripeMinor,
    netMinor: donation.netMinor,
    deductible,
    deductiblePercentage: deductible ? 100 : null,
    donee: {
      legalName: eligibility?.irsLegalName ?? view.org.name,
      ein: eligibility?.ein ?? null,
      addressLine1: address?.line1 ?? null,
      city: address?.city ?? null,
      state: address?.state ?? null,
      postalCode: address?.postalCode ?? null,
      evidenceSource: evidence?.source ?? "irs",
      evidenceRevisionDate: evidence?.sourceRevisionDate ?? null,
    },
    orgContactEmail: null,
    registrationNumber: runtime.env.CA_CFP_REGISTRATION_NUMBER ?? null,
    platformLegalName: CIVFIX_PLATFORM_LEGAL_NAME,
  })

  const pdf = await buildDonationReceiptPdf(model)
  const charged = donation.chargedAt
  const key = `${RECEIPT_KEY_PREFIX}/${charged.getUTCFullYear()}/${String(charged.getUTCMonth() + 1).padStart(2, "0")}/${donation.id}.pdf`
  const filename = `civfix-donation-receipt-${donation.reference}.pdf`

  await runtime.storage.put(key, pdf, {
    contentType: "application/pdf",
    contentDisposition: `attachment; filename="${filename}"`,
  })

  await runtime.mailer.sendOutbound({
    from: runtime.env.MAIL_FROM_RECEIPTS,
    to: donation.donorEmail,
    subject: `Your donation receipt from ${model.donee.legalName}`,
    text: receiptEmailText(model.donee.legalName, model.reference),
    attachments: [{ filename, contentType: "application/pdf", content: pdf }],
    headers: { "Auto-Submitted": "auto-generated" },
  })

  await runtime.donations.markReceiptSent({
    donationId: donation.id,
    receiptKey: key,
    documentVersion: model.documentVersion,
    now: runtime.now(),
  })

  logger?.info({ donationId: donation.id }, "donation receipt sent")
}

function receiptEmailText(legalName: string, reference: string): string {
  return [
    `Thank you for your donation to ${legalName}.`,
    "",
    `Your receipt (reference ${reference}) is attached as a PDF. Keep it for your records.`,
    "",
    `${legalName} received your donation directly and is the merchant of record for the payment.`,
    "civfix facilitated it and never held the funds.",
    "",
    "This is an automated receipt. civfix does not provide tax advice.",
  ].join("\n")
}

export async function runPaymentsRetentionLanes(
  sql: Sql,
  now: Date,
  deps: { storage: Storage; logger?: Pick<FastifyBaseLogger, "warn"> },
): Promise<{ contactNulled: number; eventsDeleted: number; checksDeleted: number; revisionsDeleted: number }> {
  const donations = makeDrizzleDonationRepository(sql)
  const events = makeDrizzleStripeEventRepository(sql)
  const eligibility = makeDrizzleEligibilityRepository(sql)

  const contactNulled = await drainTable((batch) => donations.sweepContactRetention(now, batch))
  const eventsDeleted = await drainTable((batch) => events.deleteExpired(now, batch))
  const checksDeleted = await drainTable((batch) =>
    eligibility.deleteExpiredChecks(now, Math.min(batch, ELIGIBILITY_CHECK_SWEEP_LIMIT)),
  )

  let revisionsDeleted = 0
  const expired = await eligibility.expiredRevisions(now, 100)
  for (const revision of expired) {
    try {
      await deps.storage.delete(revision.r2Key)
    } catch (err) {
      deps.logger?.warn(
        { err, key: revision.r2Key },
        "payments retention: archived compliance object could not be deleted; keeping its row",
      )
      continue
    }
    await eligibility.deleteRevision(revision.source, revision.sourceRevisionDate)
    revisionsDeleted++
  }

  return { contactNulled, eventsDeleted, checksDeleted, revisionsDeleted }
}

export async function registerPaymentsJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const env = container.env
  if (!env.PAYMENTS_ENABLED) return

  const runtime = () => makePaymentsRuntime(container, logger)

  registerDonationExportBuilder(() => container.getDb().sql)
  registerRetentionLane("payments", async (sql, now) => {
    const result = await runPaymentsRetentionLanes(sql, now, {
      storage: container.storage,
      ...(logger !== undefined ? { logger } : {}),
    })
    return (
      result.contactNulled + result.eventsDeleted + result.checksDeleted + result.revisionsDeleted
    )
  })

  await container.jobs.work(STRIPE_EVENT_PROCESS_JOB, async (job) => {
    const eventId = jobDataString(job.data, "eventId")
    if (eventId === null) {
      logger?.warn({ jobId: job.id }, "stripe.event.process: malformed job data (skipped)")
      return
    }
    await processStripeEvent(runtime(), eventId, logger)
  })

  await container.jobs.schedule(STRIPE_EVENTS_SWEEP_JOB, env.STRIPE_EVENTS_SWEEP_CRON)
  await container.jobs.work(STRIPE_EVENTS_SWEEP_JOB, async () => {
    const active = runtime()
    const stale = await active.events.listUnprocessed(
      new Date(active.now().getTime() - STRIPE_EVENT_SWEEP_AGE_MS),
      STRIPE_EVENT_SWEEP_LIMIT,
      STRIPE_EVENT_MAX_ATTEMPTS,
    )
    for (const eventId of stale) {
      await container.jobs.enqueue(
        STRIPE_EVENT_PROCESS_JOB,
        { eventId },
        { singletonKey: `stripe-event:${eventId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
      )
    }
    const deadLettered = await active.events.countDeadLettered(STRIPE_EVENT_MAX_ATTEMPTS)
    if (deadLettered > 0) {
      logger?.error(
        { evt: "stripe.events.dead_letter", events: deadLettered, maxAttempts: STRIPE_EVENT_MAX_ATTEMPTS },
        "stripe events exhausted their retries and are no longer being re-enqueued: money may have moved that civfix has not recorded",
      )
    }
    if (stale.length > 0) {
      logger?.info({ evt: "stripe.events.sweep", requeued: stale.length }, "stripe event sweep")
    }
  })

  await container.jobs.work(STRIPE_ACCOUNT_SYNC_JOB, async (job) => {
    const organizationId = jobDataString(job.data, "organizationId")
    if (organizationId === null) return
    await runtime().orgPayments.syncAccount(organizationId)
  })

  await container.jobs.work(STRIPE_PMD_REGISTER_JOB, async (job) => {
    const organizationId = jobDataString(job.data, "organizationId")
    if (organizationId === null) return
    await runtime().orgPayments.registerPaymentMethodDomains(organizationId)
  })

  await container.jobs.work(DONATION_FULFILL_JOB, async (job) => {
    const donationId = jobDataString(job.data, "donationId")
    if (donationId === null) return
    const active = runtime()
    await fulfillDonation(active, donationId, logger)
    const donation = await active.donations.findById(donationId)
    if (donation !== null && donation.status !== "pending" && donation.receiptSentAt === null) {
      await container.jobs.enqueue(
        DONATION_RECEIPT_JOB,
        { donationId },
        { singletonKey: `receipt:${donationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
      )
    }
  })

  await container.jobs.work(DONATION_RECEIPT_JOB, async (job) => {
    const donationId = jobDataString(job.data, "donationId")
    if (donationId === null) return
    await sendDonationReceipt(runtime(), donationId, logger)
  })

  await container.jobs.work(DONATION_REFUND_SYNC_JOB, async (job) => {
    const donationId = jobDataString(job.data, "donationId")
    if (donationId === null) return
    const active = runtime()
    await syncRefunds(active, donationId, logger)
  })

  await container.jobs.work(DONATION_DISPUTE_SYNC_JOB, async (job) => {
    const eventId = jobDataString(job.data, "eventId")
    if (eventId === null) return
    await processStripeEvent(runtime(), eventId, logger)
  })

  await container.jobs.schedule(PAYMENTS_RECONCILE_JOB, env.PAYMENTS_RECONCILE_CRON)
  await container.jobs.work(PAYMENTS_RECONCILE_JOB, async () => {
    const active = runtime()
    const result = await runPaymentsReconciliation({
      sql: active.sql,
      donations: active.donations,
      orgs: active.orgs,
      payments: active.payments,
      now: active.now,
      ...(logger !== undefined ? { logger } : {}),
    })
    logger?.info({ evt: "payments.reconcile.done", ...result }, "payments reconciliation complete")
  })

  let importChain: Promise<void> = Promise.resolve()
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const slot = importChain.then(run, run)
    importChain = slot.then(
      () => undefined,
      () => undefined,
    )
    return slot
  }

  for (const schedule of eligibilityImportSchedules(env)) {
    await container.jobs.schedule(schedule.queue, schedule.cron, { source: schedule.source })
    await container.jobs.work(schedule.queue, async () => {
      const active = runtime()
      const result = await serialized(() => active.eligibility.importSource(schedule.source))
      logger?.info(
        {
          evt: "eligibility.import.done",
          source: result.source,
          revision: result.revision,
          skipped: result.skipped,
          rows: result.rowCount,
          matched: result.matchedCount,
        },
        "eligibility import complete",
      )
      for (const organizationId of result.organizationsTouched) {
        await container.jobs.enqueue(
          ELIGIBILITY_EVALUATE_JOB,
          { organizationId },
          { singletonKey: `eligibility:${organizationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
        )
      }
    })
  }

  await container.jobs.work(ELIGIBILITY_EVALUATE_JOB, async (job) => {
    const organizationId = jobDataString(job.data, "organizationId")
    if (organizationId === null) return
    const result = await runtime().eligibility.evaluate(organizationId)
    if (result.previous !== result.verdict) {
      logger?.info(
        {
          evt: "eligibility.verdict.changed",
          organizationId,
          from: result.previous,
          to: result.verdict,
          reasons: result.reasons,
          screened: result.screening?.screened ?? [],
        },
        "organization eligibility verdict changed",
      )
    }
  })

  await container.jobs.schedule(DONATION_RETENTION_SWEEP_JOB, env.DONATION_RETENTION_CRON)
  await container.jobs.work(DONATION_RETENTION_SWEEP_JOB, async () => {
    const active = runtime()
    const expired = await active.donations.expirePending(active.now(), DONATION_EXPIRY_SWEEP_LIMIT)
    for (const donationId of expired) {
      await active.donations.markExpired(donationId, active.now())
    }
    logger?.info(
      { evt: "donation.expiry.done", expired: expired.length },
      "abandoned donation checkout sweep complete",
    )
  })
}

export interface EligibilityImportSchedule {
  source: EligibilityImportSource
  queue: string
  cron: string
}

export function eligibilityImportSchedules(env: PaymentsEnv): EligibilityImportSchedule[] {
  const crons: Record<EligibilityImportSource, string> = {
    irs_pub78: env.ELIGIBILITY_IRS_CRON,
    irs_eo_bmf: env.ELIGIBILITY_IRS_CRON,
    irs_auto_revocation: env.ELIGIBILITY_IRS_CRON,
    ftb_revoked: env.ELIGIBILITY_FTB_CRON,
    ca_ag_mnos: env.ELIGIBILITY_MNOS_CRON,
    ofac_sdn: env.ELIGIBILITY_OFAC_CRON,
  }
  return ELIGIBILITY_IMPORT_SOURCES.map((source) => ({
    source,
    queue: eligibilityImportQueue(source),
    cron: crons[source],
  }))
}
