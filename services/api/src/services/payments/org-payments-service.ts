import {
  AppError,
  type DonateState,
  type OrgDonationAgreementDTO,
  type OrgDonationSettingsDTO,
  type OrgEligibilityDTO,
  type OrgPaymentsStatusDTO,
} from "@civfix/shared"
import { effectiveFeeBps, verdictPermitsDonations } from "@civfix/shared/payments"
import { currentVersion } from "@civfix/shared/legal"
import type { ConnectedAccountStatus, Jobs, Payments } from "@civfix/shared/interfaces"
import type {
  DonationsDisabledReason,
  OrgPaymentsStateValue,
} from "../../db/schema/types-payments.js"
import { assertConsentVersionsCurrent, currentLegalDocument } from "./legal-service.js"
import {
  STRIPE_ACCOUNT_SYNC_JOB,
  STRIPE_PMD_REGISTER_JOB,
  PAYMENTS_JOB_RETRY_LIMIT,
} from "./payments-queues.js"
import type {
  DonationSettingsRecord,
  EligibilityRecord,
  OrgPaymentsRepository,
  OrgPaymentsView,
  PaymentMethodDomainRecord,
  StripeAccountRecord,
  UpdateDonationSettingsInput,
} from "./org-payments-repository.drizzle.js"

export const ACCOUNT_LINK_KIND_ONBOARDING = "onboarding"

export const AGREEMENT_DOCUMENT_TYPE = "org_donation_agreement" as const

export const MAX_AGREEMENT_HISTORY = 20

export const MAX_ELIGIBILITY_CHECKS_SHOWN = 20

export interface OrgPaymentsServiceDeps {
  repo: OrgPaymentsRepository
  payments: Payments
  jobs: Jobs
  env: {
    PAYMENTS_ENABLED: boolean
    DONATION_PLATFORM_FEE_BPS: number
    DONATION_MIN_MINOR: number
    DONATION_MAX_MINOR: number
    PAYMENT_METHOD_DOMAINS: string[]
    PUBLIC_WEB_ORIGIN: string
  }
  now?: () => Date
  logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
}

export interface OrgPaymentsService {
  status(organizationId: string): Promise<OrgPaymentsStatusDTO>
  createAccount(organizationId: string, userId: string): Promise<OrgPaymentsStatusDTO>
  createAccountLink(
    organizationId: string,
    kind: "onboarding" | "update",
  ): Promise<{ url: string; expiresAt: string }>
  settings(organizationId: string): Promise<OrgDonationSettingsDTO>
  updateSettings(
    input: UpdateDonationSettingsInput & { enabled?: boolean; userId: string },
  ): Promise<OrgDonationSettingsDTO>
  acceptAgreement(input: {
    organizationId: string
    userId: string
    version: string
    documentSha256?: string
    surface: string
    screenRoute?: string
    uiTemplateVersion?: string
  }): Promise<OrgDonationAgreementDTO>
  syncAccount(organizationId: string, eventId?: string | null): Promise<OrgPaymentsStateValue>
  registerPaymentMethodDomains(organizationId: string): Promise<void>
  handleDeauthorization(stripeAccountId: string): Promise<string | null>
  setDonationsEnabledByOperator(input: {
    organizationId: string
    enabled: boolean
    reasonText: string
    actorUserId: string
  }): Promise<boolean>
}

export function computeOnboardingState(
  status: ConnectedAccountStatus,
  deauthorized: boolean,
): OrgPaymentsStateValue {
  if (deauthorized) return "blocked"
  if (!status.chargesEnabled || status.disabledReason !== null) return "blocked"
  if (status.currentlyDue.length > 0 || status.futureCurrentlyDue.length > 0) return "at_risk"
  if (!status.detailsSubmitted) return "onboarding"
  return "ready"
}

export function computeDonateState(input: {
  paymentsEnabled: boolean
  account: StripeAccountRecord | null
  settings: DonationSettingsRecord | null
  eligibility: EligibilityRecord | null
  agreementCurrent: boolean
}): DonateState {
  if (!input.paymentsEnabled) return "OFF"
  if (input.account === null) return "OFF"
  if (input.account.onboardingState === "blocked") return "BLOCKED"
  if (input.settings === null || !input.settings.enabled) return "OFF"
  if (!input.agreementCurrent) return "OFF"
  const verdict = input.eligibility?.verdict ?? "unknown"
  if (verdict === "ineligible") return "BLOCKED"
  if (verdict === "unknown") return "OFF"
  if (!verdictPermitsDonations(verdict)) return "BLOCKED"
  if (
    input.account.onboardingState === "at_risk" ||
    verdict === "grace" ||
    verdict === "review_required"
  ) {
    return "AT_RISK"
  }
  if (input.account.onboardingState !== "ready") return "OFF"
  return "READY"
}

export function walletsFromDomains(domains: readonly PaymentMethodDomainRecord[]): string[] {
  return domains.some((domain) => domain.enabled) ? ["apple_pay", "google_pay", "link"] : []
}

export function einLast4(ein: string | null): string | null {
  if (ein === null) return null
  const digits = ein.replace(/\D/g, "")
  return digits.length >= 4 ? digits.slice(-4) : null
}

function agreementDto(settings: DonationSettingsRecord | null): OrgDonationAgreementDTO {
  const required = currentVersion(AGREEMENT_DOCUMENT_TYPE)
  return {
    version: settings?.consentAgreementVersion ?? null,
    acceptedAt: settings?.consentAcceptedAt?.toISOString() ?? null,
    acceptedByName: settings?.consentAcceptedByName ?? null,
    current: settings?.consentAgreementVersion === required,
    requiredVersion: required,
  }
}

function eligibilityDto(
  eligibility: EligibilityRecord | null,
  checks: OrgEligibilityDTO["checks"],
): OrgEligibilityDTO {
  return {
    verdict: eligibility?.verdict ?? "unknown",
    reasons: eligibility?.reasons ?? [],
    einLast4: einLast4(eligibility?.ein ?? null),
    irsLegalName: eligibility?.irsLegalName ?? null,
    deductibilityCode: eligibility?.deductibilityCode ?? null,
    foundationCode: eligibility?.foundationCode ?? null,
    graceExpiresAt: eligibility?.graceExpiresAt?.toISOString() ?? null,
    evaluatedAt: eligibility?.evaluatedAt?.toISOString() ?? null,
    nextCheckAt: eligibility?.nextCheckAt?.toISOString() ?? null,
    checks,
  }
}

export const FULL_PASS_THROUGH_CLAIM_RE = /100\s*(?:%|percent)/iu

export function assertRefundPolicyClaimAllowed(text: string | null | undefined): void {
  if (typeof text !== "string") return
  if (!FULL_PASS_THROUGH_CLAIM_RE.test(text)) return
  throw AppError.validation({
    refundPolicyText:
      "cannot claim that 100% of a donation reaches the organization — a processing fee is always " +
      "deducted, and the donate page states the real split",
  })
}

export const PLATFORM_DISABLED_REASONS: readonly DonationsDisabledReason[] = [
  "operator",
  "eligibility",
  "stripe_blocked",
  "deauthorized",
]

export const DISABLED_BY_PLATFORM_MESSAGE: Readonly<Record<string, string>> = {
  operator: "Donations were disabled by civfix and cannot be changed here.",
  eligibility:
    "Donations are disabled until this organization's good standing is re-established. They turn back on with the next eligibility check.",
  stripe_blocked:
    "Donations are disabled because the payout account cannot accept payments. They turn back on once the payout account is ready again.",
  deauthorized:
    "Donations are disabled because the payout account was disconnected from civfix. Connect a payout account again to fundraise: donations turn back on once the reconnected account can accept payments.",
}

export function isPlatformDisabledReason(reason: DonationsDisabledReason): boolean {
  return PLATFORM_DISABLED_REASONS.includes(reason)
}

export function makeOrgPaymentsService(deps: OrgPaymentsServiceDeps): OrgPaymentsService {
  const now = deps.now ?? (() => new Date())

  function requirePaymentsEnabled(): void {
    if (!deps.env.PAYMENTS_ENABLED) {
      throw AppError.paymentUnavailable("Donations are not available.")
    }
  }

  async function loadView(organizationId: string): Promise<OrgPaymentsView> {
    const view = await deps.repo.paymentsView(organizationId)
    if (view === null) throw AppError.notFound("Organization not found")
    return view
  }

  /**
   * The org-scoped write gate for an operator-suspended org (DECISIONS §32), same code + wording as
   * the org service's own self-service gate: reads keep working, and the platform/operator paths
   * (sync, deauthorization, operator disable) keep working, but the org cannot connect a payout
   * account, mint an onboarding link, change its donation settings or accept the agreement.
   */
  async function loadWritableView(organizationId: string): Promise<OrgPaymentsView> {
    const view = await loadView(organizationId)
    if (view.org.suspended) {
      throw AppError.forbidden(
        "This organization has been suspended, so it can't be changed right now.",
      )
    }
    return view
  }

  async function clearDeauthorizedDisable(organizationId: string): Promise<void> {
    const refreshed = await loadView(organizationId)
    if (refreshed.settings?.disabledReason !== "deauthorized") return
    await deps.repo.setDonationsEnabled({
      organizationId,
      enabled: true,
      reason: null,
      reasonText: null,
      actorUserId: null,
      now: now(),
    })
  }

  async function statusDto(view: OrgPaymentsView): Promise<OrgPaymentsStatusDTO> {
    const checks = await deps.repo.recentChecks(view.org.id, MAX_ELIGIBILITY_CHECKS_SHOWN)
    const agreement = agreementDto(view.settings)
    const account = view.account
    return {
      organizationId: view.org.id,
      state: account?.onboardingState ?? "not_started",
      stripeAccountId: account?.stripeAccountId ?? null,
      livemode: account?.livemode ?? false,
      detailsSubmitted: account?.detailsSubmitted ?? false,
      chargesEnabled: account?.chargesEnabled ?? false,
      payoutsEnabled: account?.payoutsEnabled ?? false,
      disabledReason: account?.disabledReason ?? null,
      currentlyDue: account?.currentlyDue ?? [],
      pastDue: account?.pastDue ?? [],
      pendingVerification: account?.pendingVerification ?? [],
      futureCurrentlyDue: account?.futureCurrentlyDue ?? [],
      currentDeadline: account?.currentDeadline?.toISOString() ?? null,
      capabilities: account?.capabilities ?? {},
      paymentMethodDomains: (account?.paymentMethodDomains ?? []).map((domain) => ({
        domain: domain.domain,
        enabled: domain.enabled,
        registeredAt: domain.registeredAt,
      })),
      walletsAvailable: walletsFromDomains(account?.paymentMethodDomains ?? []),
      donationsEnabled: view.settings?.enabled ?? false,
      donationsDisabledReason: view.settings?.disabledReason ?? null,
      agreement,
      eligibility: eligibilityDto(
        view.eligibility,
        checks.map((check) => ({
          source: check.source as OrgEligibilityDTO["checks"][number]["source"],
          sourceRevisionDate: check.sourceRevisionDate,
          matched: check.matched,
          verdictContribution: check.verdictContribution,
          detail: check.detail,
          checkedAt: check.checkedAt.toISOString(),
        })),
      ),
      donateState: computeDonateState({
        paymentsEnabled: deps.env.PAYMENTS_ENABLED,
        account: view.account,
        settings: view.settings,
        eligibility: view.eligibility,
        agreementCurrent: agreement.current,
      }),
      lastSyncedAt: account?.lastSyncedAt?.toISOString() ?? null,
    }
  }

  async function settingsDto(view: OrgPaymentsView): Promise<OrgDonationSettingsDTO> {
    const settings =
      view.settings ?? (await deps.repo.ensureSettings(view.org.id, deps.env.DONATION_PLATFORM_FEE_BPS))
    const checks = await deps.repo.recentChecks(view.org.id, MAX_ELIGIBILITY_CHECKS_SHOWN)
    const agreement = agreementDto(settings)
    return {
      organizationId: view.org.id,
      enabled: settings.enabled,
      donorSharingDefault: settings.donorSharingDefault,
      missionBlurb: settings.missionBlurb,
      designationNote: settings.designationNote,
      refundPolicyText: settings.refundPolicyText,
      minAmountMinor: settings.minAmountMinor,
      maxAmountMinor: settings.maxAmountMinor,
      suggestedAmountsMinor: settings.suggestedAmountsMinor,
      agreedFeeBps: settings.agreedFeeBps,
      effectiveFeeBps: effectiveFeeBps(deps.env.DONATION_PLATFORM_FEE_BPS, settings.agreedFeeBps),
      legalName: view.eligibility?.irsLegalName ?? null,
      einLast4: einLast4(view.eligibility?.ein ?? null),
      agreement,
      eligibility: eligibilityDto(
        view.eligibility,
        checks.map((check) => ({
          source: check.source as OrgEligibilityDTO["checks"][number]["source"],
          sourceRevisionDate: check.sourceRevisionDate,
          matched: check.matched,
          verdictContribution: check.verdictContribution,
          detail: check.detail,
          checkedAt: check.checkedAt.toISOString(),
        })),
      ),
      donateState: computeDonateState({
        paymentsEnabled: deps.env.PAYMENTS_ENABLED,
        account: view.account,
        settings,
        eligibility: view.eligibility,
        agreementCurrent: agreement.current,
      }),
    }
  }

  return {
    async status(organizationId) {
      return statusDto(await loadView(organizationId))
    },

    async createAccount(organizationId, userId) {
      requirePaymentsEnabled()
      const view = await loadWritableView(organizationId)

      const reconnecting = view.account !== null && view.account.deauthorizedAt !== null
      if (view.account !== null && !reconnecting) return statusDto(view)

      if (view.org.verifiedStatus !== "verified" || view.org.verifiedKind !== "nonprofit") {
        throw AppError.paymentUnavailable(
          "Only a verified nonprofit organization can connect a payout account.",
        )
      }
      if (!verdictPermitsDonations(view.eligibility?.verdict ?? "unknown")) {
        throw AppError.paymentUnavailable(
          "This organization is not currently eligible to receive donations.",
        )
      }
      const settings =
        view.settings ??
        (await deps.repo.ensureSettings(organizationId, deps.env.DONATION_PLATFORM_FEE_BPS))
      if (settings.consentAgreementVersion !== currentVersion(AGREEMENT_DOCUMENT_TYPE)) {
        throw AppError.conflict(
          "The organization must accept the current donation agreement before connecting a payout account.",
        )
      }

      const legalName = view.eligibility?.irsLegalName ?? view.org.name
      const connectingEmail = await deps.repo.findVerifiedUserEmail(userId)

      if (reconnecting && view.account !== null) {
        const reauthorized = await deps.payments.retrieveAccount(view.account.stripeAccountId)
        if (reauthorized.chargesEnabled) {
          await deps.repo.clearDeauthorization(organizationId, now())
          await deps.repo.upsertStripeAccount({
            organizationId,
            status: reauthorized,
            state: computeOnboardingState(reauthorized, false),
            now: now(),
          })
          await clearDeauthorizedDisable(organizationId)
          return statusDto(await loadView(organizationId))
        }

        const attempt = view.account.reconnectAttempts + 1
        const replacement = await deps.payments.createConnectedAccount({
          orgId: organizationId,
          ...(connectingEmail === null ? {} : { email: connectingEmail }),
          legalName,
          url: `${deps.env.PUBLIC_WEB_ORIGIN}/donate/${view.org.slug}`,
          idempotencyKey: `acct:${organizationId}:v2:${attempt}`,
        })
        await deps.repo.relinkStripeAccount({
          organizationId,
          status: replacement,
          state: computeOnboardingState(replacement, false),
          now: now(),
        })
        await deps.jobs
          .enqueue(
            STRIPE_ACCOUNT_SYNC_JOB,
            { organizationId },
            { singletonKey: `account-sync:${organizationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
          )
          .catch((err: unknown) =>
            deps.logger?.warn({ err, organizationId }, "account sync enqueue failed"),
          )
        return statusDto(await loadView(organizationId))
      }

      const created = await deps.payments.createConnectedAccount({
        orgId: organizationId,
        ...(connectingEmail === null ? {} : { email: connectingEmail }),
        legalName,
        url: `${deps.env.PUBLIC_WEB_ORIGIN}/donate/${view.org.slug}`,
        idempotencyKey: `acct:${organizationId}:v1`,
      })

      await deps.repo.insertStripeAccount({
        organizationId,
        status: created,
        state: computeOnboardingState(created, false),
      })
      await deps.jobs
        .enqueue(
          STRIPE_ACCOUNT_SYNC_JOB,
          { organizationId },
          { singletonKey: `account-sync:${organizationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
        )
        .catch((err: unknown) => deps.logger?.warn({ err, organizationId }, "account sync enqueue failed"))

      return statusDto(await loadView(organizationId))
    },

    async createAccountLink(organizationId, kind) {
      requirePaymentsEnabled()
      const view = await loadWritableView(organizationId)
      if (view.account === null) {
        throw AppError.conflict("Connect a payout account before requesting an onboarding link.")
      }
      const base = `${deps.env.PUBLIC_WEB_ORIGIN}/manage/orgs/${organizationId}/payments`
      const link = await deps.payments.createAccountLink({
        accountId: view.account.stripeAccountId,
        type: kind,
        refreshUrl: `${base}?stripe=refresh`,
        returnUrl: `${base}?stripe=return`,
      })
      return { url: link.url, expiresAt: new Date(link.expiresAtSec * 1000).toISOString() }
    },

    async settings(organizationId) {
      return settingsDto(await loadView(organizationId))
    },

    async updateSettings(input) {
      const view = await loadWritableView(input.organizationId)
      const settings =
        view.settings ??
        (await deps.repo.ensureSettings(input.organizationId, deps.env.DONATION_PLATFORM_FEE_BPS))

      assertRefundPolicyClaimAllowed(input.refundPolicyText)

      const min = input.minAmountMinor ?? settings.minAmountMinor
      const max = input.maxAmountMinor ?? settings.maxAmountMinor
      if (min < deps.env.DONATION_MIN_MINOR) {
        throw AppError.validation({
          minAmountMinor: `must be at least ${deps.env.DONATION_MIN_MINOR}`,
        })
      }
      if (max > deps.env.DONATION_MAX_MINOR) {
        throw AppError.validation({
          maxAmountMinor: `must be at most ${deps.env.DONATION_MAX_MINOR}`,
        })
      }
      if (max < min) {
        throw AppError.validation({ maxAmountMinor: "must be greater than the minimum amount" })
      }
      for (const amount of input.suggestedAmountsMinor ?? []) {
        if (amount < min || amount > max) {
          throw AppError.validation({
            suggestedAmountsMinor: "every suggested amount must sit within the donation range",
          })
        }
      }

      await deps.repo.updateSettings({
        organizationId: input.organizationId,
        ...(input.donorSharingDefault !== undefined
          ? { donorSharingDefault: input.donorSharingDefault }
          : {}),
        ...(input.missionBlurb !== undefined ? { missionBlurb: input.missionBlurb } : {}),
        ...(input.designationNote !== undefined ? { designationNote: input.designationNote } : {}),
        ...(input.refundPolicyText !== undefined ? { refundPolicyText: input.refundPolicyText } : {}),
        ...(input.minAmountMinor !== undefined ? { minAmountMinor: input.minAmountMinor } : {}),
        ...(input.maxAmountMinor !== undefined ? { maxAmountMinor: input.maxAmountMinor } : {}),
        ...(input.suggestedAmountsMinor !== undefined
          ? { suggestedAmountsMinor: input.suggestedAmountsMinor }
          : {}),
      })

      if (input.enabled !== undefined) {
        const refreshed = await loadView(input.organizationId)
        const currentReason = refreshed.settings?.disabledReason ?? null
        if (currentReason !== null && isPlatformDisabledReason(currentReason)) {
          throw AppError.forbidden(DISABLED_BY_PLATFORM_MESSAGE[currentReason])
        }
        if (input.enabled) {
          const agreement = agreementDto(refreshed.settings)
          const state = computeDonateState({
            paymentsEnabled: deps.env.PAYMENTS_ENABLED,
            account: refreshed.account,
            settings: { ...(refreshed.settings ?? settings), enabled: true },
            eligibility: refreshed.eligibility,
            agreementCurrent: agreement.current,
          })
          if (state === "OFF" || state === "BLOCKED") {
            throw AppError.paymentUnavailable(
              "Donations cannot be turned on until the payout account is ready, the organization is eligible, and the current agreement is accepted.",
            )
          }
        }
        await deps.repo.setDonationsEnabled({
          organizationId: input.organizationId,
          enabled: input.enabled,
          reason: input.enabled ? null : "org",
          reasonText: null,
          actorUserId: input.userId,
          now: now(),
        })
      }

      return settingsDto(await loadView(input.organizationId))
    },

    async acceptAgreement(input) {
      const document = currentLegalDocument(AGREEMENT_DOCUMENT_TYPE)
      assertConsentVersionsCurrent([{ type: AGREEMENT_DOCUMENT_TYPE, version: input.version }])
      if (input.documentSha256 !== undefined && input.documentSha256 !== document.sha256) {
        throw AppError.conflict(
          "The agreement text shown to you has changed. Reload and review it before accepting.",
        )
      }
      const view = await loadWritableView(input.organizationId)
      const settings =
        view.settings ??
        (await deps.repo.ensureSettings(input.organizationId, deps.env.DONATION_PLATFORM_FEE_BPS))

      await deps.repo.acceptAgreement({
        organizationId: input.organizationId,
        userId: input.userId,
        version: document.version,
        documentSha256: document.sha256,
        surface: input.surface,
        screenRoute: input.screenRoute ?? null,
        uiTemplateVersion: input.uiTemplateVersion ?? null,
        feeBps: settings.agreedFeeBps,
        now: now(),
      })

      const refreshed = await loadView(input.organizationId)
      return agreementDto(refreshed.settings)
    },

    async syncAccount(organizationId, eventId) {
      const view = await loadView(organizationId)
      if (view.account === null) return "not_started"

      const status = await deps.payments.retrieveAccount(view.account.stripeAccountId)
      const deauthorized = view.account.deauthorizedAt !== null
      const state = computeOnboardingState(status, deauthorized)
      const previousChargesEnabled = view.account.chargesEnabled

      await deps.repo.upsertStripeAccount({
        organizationId,
        status,
        state,
        eventId: eventId ?? null,
        now: now(),
      })

      if (state === "blocked" && view.settings?.enabled === true) {
        await deps.repo.setDonationsEnabled({
          organizationId,
          enabled: false,
          reason: deauthorized ? "deauthorized" : "stripe_blocked",
          reasonText: null,
          actorUserId: null,
          now: now(),
        })
      }

      const platformDisable = view.settings?.disabledReason ?? null
      const clearable =
        platformDisable === "stripe_blocked" ||
        (platformDisable === "deauthorized" && !deauthorized && status.chargesEnabled)
      if (state !== "blocked" && view.settings?.enabled === false && clearable) {
        await deps.repo.setDonationsEnabled({
          organizationId,
          enabled: true,
          reason: null,
          reasonText: null,
          actorUserId: null,
          now: now(),
        })
      }

      if (!previousChargesEnabled && status.chargesEnabled && deps.env.PAYMENT_METHOD_DOMAINS.length > 0) {
        await deps.jobs
          .enqueue(
            STRIPE_PMD_REGISTER_JOB,
            { organizationId },
            { singletonKey: `pmd:${organizationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
          )
          .catch((err: unknown) =>
            deps.logger?.warn({ err, organizationId }, "payment method domain enqueue failed"),
          )
      }

      return state
    },

    async registerPaymentMethodDomains(organizationId) {
      const view = await loadView(organizationId)
      if (view.account === null || !view.account.chargesEnabled) return

      const registered: PaymentMethodDomainRecord[] = [...view.account.paymentMethodDomains]
      for (const domain of deps.env.PAYMENT_METHOD_DOMAINS) {
        if (registered.some((entry) => entry.domain === domain && entry.enabled)) continue
        const result = await deps.payments.registerPaymentMethodDomain(
          view.account.stripeAccountId,
          domain,
        )
        const existingIndex = registered.findIndex((entry) => entry.domain === domain)
        const record: PaymentMethodDomainRecord = {
          domain: result.domain,
          id: result.id,
          enabled: result.enabled,
          registeredAt: now().toISOString(),
        }
        if (existingIndex >= 0) registered[existingIndex] = record
        else registered.push(record)
      }
      await deps.repo.setPaymentMethodDomains(organizationId, registered)
    },

    async handleDeauthorization(stripeAccountId) {
      const organizationId = await deps.repo.markDeauthorized(stripeAccountId, now())
      if (organizationId === null) return null
      await deps.repo.setDonationsEnabled({
        organizationId,
        enabled: false,
        reason: "deauthorized",
        reasonText: null,
        actorUserId: null,
        now: now(),
      })
      return organizationId
    },

    async setDonationsEnabledByOperator(input) {
      const view = await loadView(input.organizationId)
      if (view.settings === null) {
        await deps.repo.ensureSettings(input.organizationId, deps.env.DONATION_PLATFORM_FEE_BPS)
      }
      return deps.repo.setDonationsEnabled({
        organizationId: input.organizationId,
        enabled: input.enabled,
        reason: input.enabled ? null : "operator",
        reasonText: input.enabled ? null : input.reasonText,
        actorUserId: input.actorUserId,
        now: now(),
      })
    },
  }
}
