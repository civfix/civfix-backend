import { createHash, randomUUID } from "node:crypto"
import {
  AppError,
  DONATION_CURRENCY,
  type DonationDTO,
  type DonationPageDTO,
  type DonationStatusDTO,
  type FeeBreakdownDTO,
  type OrgDonationRowDTO,
  type OrgDonationSummaryDTO,
} from "@civfix/shared"
import type { Jobs, Payments } from "@civfix/shared/interfaces"
import {
  DEFAULT_PROCESSOR_FEE_BPS,
  DEFAULT_PROCESSOR_FEE_FIXED_MINOR,
  effectiveFeeBps,
  platformFeeMinor,
  previewDonationFees,
} from "@civfix/shared/payments"
import {
  currentVersion,
  platformFeePercent,
  renderDonationDisclosures,
} from "@civfix/shared/legal"
import type { DonationStatusValue } from "../../db/schema/types-payments.js"
import {
  assertConsentVersionsCurrent,
  consentDocumentsFor,
  legalDocumentVersions,
} from "./legal-service.js"
import { computeDonateState, einLast4 } from "./org-payments-service.js"
import type { OrgPaymentsRepository, OrgPaymentsView } from "./org-payments-repository.drizzle.js"
import type {
  DonationListRow,
  DonationRecord,
  DonationRepository,
} from "./donation-repository.drizzle.js"
import { encodeDonationCursor } from "./donation-repository.drizzle.js"
import { mintDonationStatusToken, verifyDonationStatusToken } from "./donation-status-token.js"
import { DONATION_FULFILL_JOB, PAYMENTS_JOB_RETRY_LIMIT } from "./payments-queues.js"

export const CHECKOUT_SESSION_TTL_SEC = 45 * 60

export const CHECKOUT_SESSION_MIN_TTL_SEC = 30 * 60

export const DONATION_RETENTION_YEARS = 7

export const RECEIPT_URL_TTL_SEC = 300

export const STATUS_BACKSTOP_MIN_INTERVAL_MS = 5000

export const DEFAULT_SUGGESTED_AMOUNTS_MINOR = [2500, 5000, 10000] as const

export const FEE_PREVIEW_DEFAULT_AMOUNT_MINOR = 5000

export interface DonationStorage {
  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string>
}

export interface DonationServiceDeps {
  donations: DonationRepository
  orgs: OrgPaymentsRepository
  payments: Payments
  jobs: Jobs
  storage: DonationStorage
  env: {
    PAYMENTS_ENABLED: boolean
    DONATION_PLATFORM_FEE_BPS: number
    DONATION_MIN_MINOR: number
    DONATION_MAX_MINOR: number
    DONATION_STATUS_TOKEN_KEY: string
    ELIGIBILITY_STALE_GRACE_HOURS: number
    PUBLIC_WEB_ORIGIN: string
    CA_CFP_REGISTRATION_NUMBER?: string
  }
  now?: () => Date
  newId?: () => string
  logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
}

export interface CreateCheckoutInput {
  orgSlug: string
  amountMinor: number
  email: string
  name?: string
  eventId?: string
  shareIdentity: boolean
  idempotencyKey: string
  userId: string | null
  beforeAuthorize?: () => Promise<void>
  consent: {
    termsVersion: string
    privacyVersion: string
    donationTermsVersion: string
    disclosureVersion: string
    surface: string
    screenRoute: string
    uiTemplateVersion: string
  }
}

export interface CreateCheckoutResult {
  donationId: string
  clientSecret: string
  stripeAccount: string
  statusToken: string
  returnUrl: string
  expiresAt: string
  feeBreakdown: FeeBreakdownDTO
}

export interface DonationService {
  publicPage(slug: string, eventId?: string): Promise<DonationPageDTO>
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>
  status(input: { donationId: string; token?: string; userId: string | null }): Promise<DonationStatusDTO>
  listMine(input: { userId: string; cursor?: string; limit: number }): Promise<{
    items: DonationDTO[]
    nextCursor: string | null
  }>
  receiptUrl(input: {
    donationId: string
    userId: string
  }): Promise<{ url: string; expiresAt: string; filename: string }>
  listForOrg(input: {
    organizationId: string
    status?: DonationStatusValue
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }): Promise<{ items: OrgDonationRowDTO[]; nextCursor: string | null }>
  summaryForOrg(input: {
    organizationId: string
    from?: Date
    to?: Date
  }): Promise<OrgDonationSummaryDTO>
}

export function maskEmail(email: string | null): string | null {
  if (email === null) return null
  const at = email.indexOf("@")
  if (at <= 0) return "***"
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const head = local.slice(0, 1)
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`
}

export function donationReference(id: string): string {
  return `CFD-${id.replace(/-/g, "").slice(0, 12).toUpperCase()}`
}

export function feeBreakdownOf(amountMinor: number, feeBps: number): FeeBreakdownDTO {
  const preview = previewDonationFees({ amountMinor, platformFeeBps: feeBps })
  return {
    grossMinor: preview.grossMinor,
    platformFeeMinor: preview.platformFeeMinor,
    processorFeeMinor: preview.estimatedProcessingFeeMinor,
    processorFeeIsEstimate: true,
    netMinor: preview.estimatedNetMinor,
    platformFeeBps: preview.platformFeeBps,
    currency: DONATION_CURRENCY,
  }
}

function settledFeeBreakdown(donation: DonationRecord): FeeBreakdownDTO {
  const processorFeeMinor = donation.feeStripeMinor
  const settled = processorFeeMinor !== null
  return {
    grossMinor: donation.amountMinor,
    platformFeeMinor: donation.feePlatformMinor - donation.feeRefundedMinor,
    processorFeeMinor: settled
      ? processorFeeMinor
      : Math.round((donation.amountMinor * DEFAULT_PROCESSOR_FEE_BPS) / 10000) +
        DEFAULT_PROCESSOR_FEE_FIXED_MINOR,
    processorFeeIsEstimate: !settled,
    netMinor:
      donation.netMinor ??
      donation.amountMinor - donation.feePlatformMinor - (processorFeeMinor ?? 0),
    platformFeeBps: donation.feeBps,
    currency: DONATION_CURRENCY,
  }
}

export function toDonationDto(row: DonationListRow): DonationDTO {
  return {
    id: row.id,
    reference: row.reference,
    organizationId: row.organizationId,
    orgName: row.orgName,
    orgLegalName: null,
    amount: { amountMinor: row.amountMinor, currency: DONATION_CURRENCY },
    fees: settledFeeBreakdown(row),
    status: row.status,
    disputeState: row.disputeState,
    refundedTotalMinor: row.refundedTotalMinor,
    createdAt: row.createdAt.toISOString(),
    chargedAt: row.chargedAt?.toISOString() ?? null,
    cardBrand: row.cardBrand,
    cardLast4: row.cardLast4,
    receiptAvailable: row.receiptKey !== null,
    receiptSentAt: row.receiptSentAt?.toISOString() ?? null,
    sharedIdentityWithOrg: row.shareIdentityWithOrg,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
  }
}

export function toOrgDonationRowDto(row: DonationListRow): OrgDonationRowDTO {
  const shared = row.shareIdentityWithOrg
  const fees = settledFeeBreakdown(row)
  return {
    id: row.id,
    reference: row.reference,
    amount: { amountMinor: row.amountMinor, currency: DONATION_CURRENCY },
    platformFeeMinor: fees.platformFeeMinor,
    processorFeeMinor: fees.processorFeeMinor,
    netMinor: fees.netMinor,
    status: row.status,
    disputeState: row.disputeState,
    refundedTotalMinor: row.refundedTotalMinor,
    chargedAt: row.chargedAt?.toISOString() ?? null,
    donorName: shared ? row.donorName : null,
    donorEmail: shared ? row.donorEmail : null,
    sharedIdentity: shared,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    receiptSentAt: row.receiptSentAt?.toISOString() ?? null,
  }
}

function receiptFilename(reference: string): string {
  return `civfix-donation-receipt-${reference}.pdf`
}

export function makeDonationService(deps: DonationServiceDeps): DonationService {
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? randomUUID

  function notFoundOrg(): AppError {
    return AppError.notFound("Organization not found")
  }

  function statusNotFound(): AppError {
    return AppError.notFound("Donation not found")
  }

  async function requireOrgView(slug: string): Promise<OrgPaymentsView> {
    const org = await deps.orgs.findOrgBySlug(slug)
    if (org === null) throw notFoundOrg()
    const view = await deps.orgs.paymentsView(org.id)
    if (view === null) throw notFoundOrg()
    return view
  }

  function eligibilityIsFresh(evaluatedAt: Date | null): boolean {
    if (evaluatedAt === null) return false
    const ageMs = now().getTime() - evaluatedAt.getTime()
    return ageMs <= deps.env.ELIGIBILITY_STALE_GRACE_HOURS * 3600_000
  }

  return {
    async publicPage(slug, eventId) {
      const view = await requireOrgView(slug)
      // An operator-suspended org (DECISIONS §32) is treated like a BLOCKED donate state: the public
      // donate page 404s exactly as it does for an org that cannot accept donations.
      if (view.org.suspended) throw notFoundOrg()
      const settings = view.settings
      const account = view.account
      const eligibility = view.eligibility
      const agreementCurrent =
        settings?.consentAgreementVersion === currentVersion("org_donation_agreement")

      const donateState = computeDonateState({
        paymentsEnabled: deps.env.PAYMENTS_ENABLED,
        account,
        settings,
        eligibility,
        agreementCurrent,
      })
      if (donateState === "OFF" || donateState === "BLOCKED") throw notFoundOrg()

      const feeBps = effectiveFeeBps(
        deps.env.DONATION_PLATFORM_FEE_BPS,
        settings?.agreedFeeBps ?? deps.env.DONATION_PLATFORM_FEE_BPS,
      )
      const minAmountMinor = Math.max(
        settings?.minAmountMinor ?? deps.env.DONATION_MIN_MINOR,
        deps.env.DONATION_MIN_MINOR,
      )
      const maxAmountMinor = Math.min(
        settings?.maxAmountMinor ?? deps.env.DONATION_MAX_MINOR,
        deps.env.DONATION_MAX_MINOR,
      )
      const legalName = eligibility?.irsLegalName ?? view.org.name
      const deductible = eligibility?.contributionsDeductible === true
      const disclosureCopy = renderDonationDisclosures(
        {
          orgLegalName: legalName,
          platformFeePercent: platformFeePercent(feeBps),
          webOrigin: deps.env.PUBLIC_WEB_ORIGIN,
        },
        { deductible, refundPolicyText: settings?.refundPolicyText ?? null },
      )
      const disclosureVersion = currentVersion("donation_disclosure")
      const eventRef =
        eventId === undefined ? null : await deps.orgs.findEventRef(eventId, view.org.id)

      return {
        org: {
          slug: view.org.slug,
          displayName: view.org.name,
          legalName,
          logoUrl: view.org.logoUrl,
          verified: view.org.verifiedStatus === "verified",
          einLast4: einLast4(eligibility?.ein ?? null),
          city: eligibility?.irsAddress?.city ?? null,
          state: eligibility?.irsAddress?.state ?? null,
        },
        donateState,
        donationsEnabled: settings?.enabled ?? false,
        stripeAccount: account?.stripeAccountId ?? null,
        eligibility: { state: "open", closedReason: null },
        currency: DONATION_CURRENCY,
        minAmountMinor,
        maxAmountMinor,
        suggestedAmountsMinor:
          settings !== null && settings.suggestedAmountsMinor.length > 0
            ? settings.suggestedAmountsMinor
            : [...DEFAULT_SUGGESTED_AMOUNTS_MINOR],
        platformFeeBps: feeBps,
        processingFeeBps: DEFAULT_PROCESSOR_FEE_BPS,
        processingFeeFixedMinor: DEFAULT_PROCESSOR_FEE_FIXED_MINOR,
        feePreview: feeBreakdownOf(FEE_PREVIEW_DEFAULT_AMOUNT_MINOR, feeBps),
        disclosures: {
          ...disclosureCopy,
          deductibilityCheckedAt: eligibility?.evaluatedAt?.toISOString() ?? null,
        },
        disclosureVersion,
        registrationNumber: deps.env.CA_CFP_REGISTRATION_NUMBER ?? null,
        taxDeductibility: {
          deductible,
          percentage: deductible ? 100 : null,
          statement: deductible
            ? "No goods or services were provided in exchange for this contribution, so the full amount may be deductible."
            : "This contribution may not be tax deductible.",
          checkedAt: eligibility?.evaluatedAt?.toISOString() ?? null,
        },
        donorSharing: {
          defaultOn: false,
          optInLabel: `Share my name and email with ${view.org.name}`,
          whatIsShared:
            "Only your name and email address, and only if you tick this box. Your payment details are never shared with the organization by civfix.",
        },
        legalVersions: legalDocumentVersions(),
        walletsAvailable: (account?.paymentMethodDomains ?? []).some((domain) => domain.enabled)
          ? ["apple_pay", "google_pay", "link"]
          : [],
        requiresTurnstile: true,
        event: eventRef,
      }
    },

    async createCheckout(input) {
      if (!deps.env.PAYMENTS_ENABLED) {
        throw AppError.paymentUnavailable("Donations are not available.")
      }

      const view = await requireOrgView(input.orgSlug)
      if (view.org.suspended) {
        throw AppError.paymentUnavailable(
          "This organization cannot accept donations right now. Nothing was charged.",
        )
      }
      const settings = view.settings
      const account = view.account
      const eligibility = view.eligibility
      const agreementCurrent =
        settings?.consentAgreementVersion === currentVersion("org_donation_agreement")

      const donateState = computeDonateState({
        paymentsEnabled: true,
        account,
        settings,
        eligibility,
        agreementCurrent,
      })
      if (donateState === "OFF") throw notFoundOrg()
      if (donateState === "BLOCKED") {
        throw AppError.paymentUnavailable(
          "This organization cannot accept donations right now. Nothing was charged.",
        )
      }
      if (account === null || settings === null) throw notFoundOrg()
      if (!eligibilityIsFresh(eligibility?.evaluatedAt ?? null)) {
        throw AppError.paymentUnavailable(
          "We are re-checking this organization's good standing. Please try again shortly.",
        )
      }

      const minAmountMinor = Math.max(settings.minAmountMinor, deps.env.DONATION_MIN_MINOR)
      const maxAmountMinor = Math.min(settings.maxAmountMinor, deps.env.DONATION_MAX_MINOR)
      if (input.amountMinor < minAmountMinor || input.amountMinor > maxAmountMinor) {
        throw AppError.validation({
          amountMinor: `must be between ${minAmountMinor} and ${maxAmountMinor} cents`,
        })
      }

      assertConsentVersionsCurrent([
        { type: "terms", version: input.consent.termsVersion },
        { type: "privacy", version: input.consent.privacyVersion },
        { type: "donations", version: input.consent.donationTermsVersion },
        { type: "donation_disclosure", version: input.consent.disclosureVersion },
      ])

      const eventRef =
        input.eventId === undefined
          ? null
          : await deps.orgs.findEventRef(input.eventId, view.org.id)
      if (input.eventId !== undefined && eventRef === null) {
        throw AppError.validation({ eventId: "does not belong to this organization" })
      }

      const feeBps = effectiveFeeBps(deps.env.DONATION_PLATFORM_FEE_BPS, settings.agreedFeeBps)
      const feePlatformMinor = platformFeeMinor(input.amountMinor, feeBps)
      const owner =
        input.userId === null ? `donor:${donorHash(input.email)}` : `user:${input.userId}`

      const replayed = await deps.donations.findByIdempotency(owner, input.idempotencyKey)
      if (replayed === null && input.beforeAuthorize !== undefined) {
        await input.beforeAuthorize()
      }

      const donationId = newId()
      const stamped = now()
      const expiresAt = new Date(stamped.getTime() + CHECKOUT_SESSION_TTL_SEC * 1000)

      const outcome = await deps.donations.create({
        id: donationId,
        reference: donationReference(donationId),
        donorKey: donorKeyFor(input.email),
        organizationId: view.org.id,
        eventId: input.eventId ?? null,
        userId: input.userId,
        donorEmail: input.email,
        donorName: input.name ?? null,
        shareIdentityWithOrg: input.shareIdentity,
        amountMinor: input.amountMinor,
        feeBps,
        feePlatformMinor,
        stripeAccountId: account.stripeAccountId,
        sessionExpiresAt: expiresAt,
        consentTermsVersion: input.consent.termsVersion,
        consentDisclosureVersion: input.consent.disclosureVersion,
        eligibilitySnapshot: {
          verdict: eligibility?.verdict ?? "unknown",
          reasons: eligibility?.reasons ?? [],
          evaluatedAt: eligibility?.evaluatedAt?.toISOString() ?? null,
          irsLegalName: eligibility?.irsLegalName ?? null,
          einLast4: einLast4(eligibility?.ein ?? null),
        },
        idempotencyOwner: owner,
        idempotencyKey: input.idempotencyKey,
        livemode: deps.payments.mode() === "live",
        consents: consentDocumentsFor([
          { type: "terms", version: input.consent.termsVersion },
          { type: "privacy", version: input.consent.privacyVersion },
          { type: "donations", version: input.consent.donationTermsVersion },
          { type: "donation_disclosure", version: input.consent.disclosureVersion },
        ]),
        consentSurface: input.consent.surface,
        consentScreenRoute: input.consent.screenRoute,
        consentUiTemplateVersion: input.consent.uiTemplateVersion,
        now: stamped,
      })

      const donation = outcome.donation
      const legalName = eligibility?.irsLegalName ?? view.org.name

      if (outcome.kind === "replayed") {
        if (donation.status !== "pending") {
          throw AppError.conflict(
            "This donation was already completed. Start a new donation to give again.",
          )
        }
        if (donation.stripeCheckoutSessionId !== null) {
          const existing = await deps.payments.retrieveCheckoutSession(
            donation.stripeAccountId,
            donation.stripeCheckoutSessionId,
          )
          if (existing.status !== "open" || existing.clientSecret === null) {
            throw AppError.conflict(
              "This donation's checkout session has expired. Start a new donation.",
            )
          }
          const statusToken = mintDonationStatusToken(
            deps.env.DONATION_STATUS_TOKEN_KEY,
            donation.id,
          )
          const expiresAt = new Date(
            (existing.expiresAtSec ?? Math.floor(now().getTime() / 1000)) * 1000,
          )
          return {
            donationId: donation.id,
            clientSecret: existing.clientSecret,
            stripeAccount: donation.stripeAccountId,
            statusToken,
            returnUrl: donationReturnUrl({
              origin: deps.env.PUBLIC_WEB_ORIGIN,
              slug: view.org.slug,
              donationId: donation.id,
              statusToken,
            }),
            expiresAt: expiresAt.toISOString(),
            feeBreakdown: feeBreakdownOf(donation.amountMinor, donation.feeBps),
          }
        }
      }

      const session = await deps.payments.createDonationCheckout({
        accountId: donation.stripeAccountId,
        donationId: donation.id,
        orgId: view.org.id,
        amountMinor: donation.amountMinor,
        currency: "usd",
        productName: `Donation to ${legalName}`,
        customerEmail: donation.donorEmail ?? input.email,
        applicationFeeMinor: donation.feePlatformMinor,
        expiresAtSec: Math.floor(now().getTime() / 1000) + CHECKOUT_SESSION_TTL_SEC,
        idempotencyKey: `donation:${donation.id}:checkout:v1`,
      })

      await deps.donations.attachCheckoutSession({
        donationId: donation.id,
        sessionId: session.sessionId,
        paymentIntentId: session.paymentIntentId,
        expiresAt: new Date(session.expiresAtSec * 1000),
      })

      const statusToken = mintDonationStatusToken(deps.env.DONATION_STATUS_TOKEN_KEY, donation.id)
      return {
        donationId: donation.id,
        clientSecret: session.clientSecret,
        stripeAccount: donation.stripeAccountId,
        statusToken,
        returnUrl: donationReturnUrl({
          origin: deps.env.PUBLIC_WEB_ORIGIN,
          slug: view.org.slug,
          donationId: donation.id,
          statusToken,
        }),
        expiresAt: new Date(session.expiresAtSec * 1000).toISOString(),
        feeBreakdown: feeBreakdownOf(donation.amountMinor, donation.feeBps),
      }
    },

    async status({ donationId, token, userId }) {
      const donation = await deps.donations.findById(donationId)
      if (donation === null) throw statusNotFound()

      const isOwner = userId !== null && donation.userId === userId
      if (!isOwner && !verifyDonationStatusToken(deps.env.DONATION_STATUS_TOKEN_KEY, donationId, token)) {
        throw statusNotFound()
      }

      const stamped = now()
      const lastPolled = donation.lastPolledAt
      if (
        donation.status === "pending" &&
        (lastPolled === null || stamped.getTime() - lastPolled.getTime() > STATUS_BACKSTOP_MIN_INTERVAL_MS)
      ) {
        await deps.donations.touchPolled(donationId, stamped)
        await deps.jobs
          .enqueue(
            DONATION_FULFILL_JOB,
            { donationId },
            { singletonKey: `fulfill:${donationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
          )
          .catch((err: unknown) =>
            deps.logger?.warn({ err, donationId }, "status backstop fulfill enqueue failed"),
          )
      }

      const org = await deps.orgs.paymentsView(donation.organizationId)
      return {
        status: donation.status,
        amount: { amountMinor: donation.amountMinor, currency: DONATION_CURRENCY },
        orgLegalName: org?.eligibility?.irsLegalName ?? org?.org.name ?? "",
        maskedEmail: maskEmail(donation.donorEmail),
        reference: donation.reference,
        chargedAt: donation.chargedAt?.toISOString() ?? null,
        receiptSent: donation.receiptSentAt !== null,
      }
    },

    async listMine({ userId, cursor, limit }) {
      const rows = await deps.donations.listForUser({ userId, cursor, limit: limit + 1 })
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page.map(toDonationDto),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeDonationCursor(last.createdAt, last.id)
            : null,
      }
    },

    async receiptUrl({ donationId, userId }) {
      const donation = await deps.donations.findByIdForUser(donationId, userId)
      if (donation === null) throw AppError.notFound("Donation not found")
      if (donation.receiptKey === null) {
        throw AppError.conflict("The receipt for this donation is not ready yet.")
      }
      const url = await deps.storage.presignGet(donation.receiptKey, RECEIPT_URL_TTL_SEC, {
        forceSigned: true,
      })
      return {
        url,
        expiresAt: new Date(now().getTime() + RECEIPT_URL_TTL_SEC * 1000).toISOString(),
        filename: receiptFilename(donation.reference),
      }
    },

    async listForOrg(input) {
      const rows = await deps.donations.listForOrg({ ...input, limit: input.limit + 1 })
      const page = rows.slice(0, input.limit)
      const last = page[page.length - 1]
      return {
        items: page.map(toOrgDonationRowDto),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeDonationCursor(last.createdAt, last.id)
            : null,
      }
    },

    async summaryForOrg(input) {
      const summary = await deps.donations.summaryForOrg(input)
      return {
        currency: DONATION_CURRENCY,
        donationCount: summary.donationCount,
        grossMinor: summary.grossMinor,
        platformFeeMinor: summary.platformFeeMinor,
        processorFeeMinor: summary.processorFeeMinor,
        netMinor: summary.netMinor,
        refundedMinor: summary.refundedMinor,
        disputedCount: summary.disputedCount,
        from: input.from?.toISOString() ?? null,
        to: input.to?.toISOString() ?? null,
      }
    },
  }
}

export function donationReturnUrl(input: {
  origin: string
  slug: string
  donationId: string
  statusToken: string
}): string {
  return `${input.origin}/donate/${input.slug}/complete?session_id={CHECKOUT_SESSION_ID}&donation=${input.donationId}&t=${input.statusToken}`
}

export function donorHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex")
}

export function donorKeyFor(email: string): string {
  const hex = donorHash(email).slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-")
}
