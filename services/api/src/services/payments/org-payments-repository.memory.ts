import type { OrganizationMemberRole } from "@civfix/shared"
import type { ConnectedAccountStatus } from "@civfix/shared/interfaces"
import type { OrgPaymentsStateValue } from "../../db/schema/types-payments.js"
import type {
  AcceptAgreementInput,
  AgreementChangeRecord,
  DonationSettingsRecord,
  EligibilityCheckRecord,
  EligibilityRecord,
  OrgIdentityRow,
  OrgPaymentsRepository,
  OrgPaymentsView,
  PaymentMethodDomainRecord,
  SetDonationsEnabledInput,
  StripeAccountRecord,
  UpdateDonationSettingsInput,
} from "./org-payments-repository.drizzle.js"

export interface MemoryOrgPaymentsSeed {
  orgs?: OrgIdentityRow[]
  accounts?: StripeAccountRecord[]
  settings?: DonationSettingsRecord[]
  eligibility?: EligibilityRecord[]
  checks?: Record<string, EligibilityCheckRecord[]>
  roles?: Record<string, Record<string, OrganizationMemberRole>>
  events?: Record<string, { id: string; title: string; startsAt: string; organizationId?: string }>
  userEmails?: Record<string, string>
}

export function makeMemoryOrgPaymentsRepository(
  seed: MemoryOrgPaymentsSeed = {},
): OrgPaymentsRepository & { state: Required<MemoryOrgPaymentsSeed> } {
  const state: Required<MemoryOrgPaymentsSeed> = {
    orgs: seed.orgs ?? [],
    accounts: seed.accounts ?? [],
    settings: seed.settings ?? [],
    eligibility: seed.eligibility ?? [],
    checks: seed.checks ?? {},
    roles: seed.roles ?? {},
    events: seed.events ?? {},
    userEmails: seed.userEmails ?? {},
  }
  const agreementChanges: Record<string, AgreementChangeRecord[]> = {}

  function orgById(id: string): OrgIdentityRow | null {
    return state.orgs.find((org) => org.id === id) ?? null
  }
  function accountOf(id: string): StripeAccountRecord | null {
    return state.accounts.find((account) => account.organizationId === id) ?? null
  }
  function settingsOf(id: string): DonationSettingsRecord | null {
    return state.settings.find((entry) => entry.organizationId === id) ?? null
  }
  function eligibilityOf(id: string): EligibilityRecord | null {
    return state.eligibility.find((entry) => entry.organizationId === id) ?? null
  }
  function accountFrom(
    organizationId: string,
    status: ConnectedAccountStatus,
    onboardingState: OrgPaymentsStateValue,
    previous: StripeAccountRecord | null,
  ): StripeAccountRecord {
    return {
      organizationId,
      stripeAccountId: status.accountId,
      livemode: status.livemode,
      detailsSubmitted: status.detailsSubmitted,
      chargesEnabled: status.chargesEnabled,
      payoutsEnabled: status.payoutsEnabled,
      disabledReason: status.disabledReason,
      currentlyDue: status.currentlyDue,
      pastDue: status.pastDue,
      pendingVerification: status.pendingVerification,
      futureCurrentlyDue: status.futureCurrentlyDue,
      capabilities: status.capabilities,
      currentDeadline:
        status.currentDeadlineSec === null ? null : new Date(status.currentDeadlineSec * 1000),
      onboardingState,
      paymentMethodDomains: previous?.paymentMethodDomains ?? [],
      deauthorizedAt: previous?.deauthorizedAt ?? null,
      reconnectAttempts: previous?.reconnectAttempts ?? 0,
      previousStripeAccountIds: previous?.previousStripeAccountIds ?? [],
      reconciledThrough: previous?.reconciledThrough ?? null,
      lastSyncedAt: new Date(),
    }
  }

  return {
    state,

    findOrgById(organizationId) {
      return Promise.resolve(orgById(organizationId))
    },

    findOrgBySlug(slug) {
      return Promise.resolve(state.orgs.find((org) => org.slug === slug) ?? null)
    },

    paymentsView(organizationId) {
      const org = orgById(organizationId)
      if (org === null) return Promise.resolve(null)
      const view: OrgPaymentsView = {
        org,
        account: accountOf(organizationId),
        settings: settingsOf(organizationId),
        eligibility: eligibilityOf(organizationId),
      }
      return Promise.resolve(view)
    },

    insertStripeAccount({ organizationId, status, state: onboardingState }) {
      const existing = accountOf(organizationId)
      if (existing !== null) return Promise.resolve(existing)
      const record = accountFrom(organizationId, status, onboardingState, null)
      state.accounts.push(record)
      return Promise.resolve(record)
    },

    upsertStripeAccount({ organizationId, status, state: onboardingState }) {
      const existing = accountOf(organizationId)
      const record = accountFrom(organizationId, status, onboardingState, existing)
      if (existing === null) state.accounts.push(record)
      else Object.assign(existing, record)
      return Promise.resolve(existing ?? record)
    },

    setPaymentMethodDomains(organizationId, domains) {
      const account = accountOf(organizationId)
      if (account !== null) account.paymentMethodDomains = [...domains] as PaymentMethodDomainRecord[]
      return Promise.resolve()
    },

    markDeauthorized(stripeAccountId, now) {
      const account = state.accounts.find((entry) => entry.stripeAccountId === stripeAccountId)
      if (account === undefined) return Promise.resolve(null)
      account.deauthorizedAt = account.deauthorizedAt ?? now
      account.onboardingState = "blocked"
      account.chargesEnabled = false
      return Promise.resolve(account.organizationId)
    },

    relinkStripeAccount({ organizationId, status, state: onboardingState, now }) {
      const existing = accountOf(organizationId)
      if (existing === null) throw new Error("org_stripe_accounts relink matched no row")
      const previousIds = [...existing.previousStripeAccountIds]
      if (existing.stripeAccountId !== status.accountId) previousIds.push(existing.stripeAccountId)
      Object.assign(existing, accountFrom(organizationId, status, onboardingState, existing), {
        paymentMethodDomains: [],
        deauthorizedAt: null,
        reconnectAttempts: existing.reconnectAttempts + 1,
        previousStripeAccountIds: previousIds,
        lastSyncedAt: now,
      })
      return Promise.resolve(existing)
    },

    clearDeauthorization(organizationId, now) {
      const account = accountOf(organizationId)
      if (account === null || account.deauthorizedAt === null) return Promise.resolve(false)
      account.deauthorizedAt = null
      account.lastSyncedAt = now
      return Promise.resolve(true)
    },

    findOrgIdByStripeAccount(stripeAccountId) {
      return Promise.resolve(
        state.accounts.find((entry) => entry.stripeAccountId === stripeAccountId)?.organizationId ??
          null,
      )
    },

    ensureSettings(organizationId, defaultFeeBps) {
      const existing = settingsOf(organizationId)
      if (existing !== null) return Promise.resolve(existing)
      const record: DonationSettingsRecord = {
        organizationId,
        enabled: false,
        disabledReason: null,
        disabledReasonText: null,
        disabledBy: null,
        donorSharingDefault: false,
        missionBlurb: null,
        designationNote: null,
        refundPolicyText: null,
        agreedFeeBps: defaultFeeBps,
        consentAgreementVersion: null,
        consentAcceptedAt: null,
        consentAcceptedByName: null,
        minAmountMinor: 500,
        maxAmountMinor: 1_000_000,
        suggestedAmountsMinor: [],
      }
      state.settings.push(record)
      return Promise.resolve(record)
    },

    updateSettings(input: UpdateDonationSettingsInput) {
      const settings = settingsOf(input.organizationId)
      if (settings === null) return Promise.resolve()
      if (input.donorSharingDefault !== undefined) {
        settings.donorSharingDefault = input.donorSharingDefault
      }
      if (input.missionBlurb !== undefined) settings.missionBlurb = input.missionBlurb
      if (input.designationNote !== undefined) settings.designationNote = input.designationNote
      if (input.refundPolicyText !== undefined) settings.refundPolicyText = input.refundPolicyText
      if (input.minAmountMinor !== undefined) settings.minAmountMinor = input.minAmountMinor
      if (input.maxAmountMinor !== undefined) settings.maxAmountMinor = input.maxAmountMinor
      if (input.suggestedAmountsMinor !== undefined) {
        settings.suggestedAmountsMinor = [...input.suggestedAmountsMinor]
      }
      return Promise.resolve()
    },

    setDonationsEnabled(input: SetDonationsEnabledInput) {
      const settings = settingsOf(input.organizationId)
      if (settings === null) return Promise.resolve(false)
      settings.enabled = input.enabled
      settings.disabledReason = input.enabled ? null : input.reason
      settings.disabledReasonText = input.enabled ? null : input.reasonText
      settings.disabledBy =
        input.enabled || input.actorUserId === null
          ? null
          : { id: input.actorUserId, name: "Operator", handle: "", joined: input.now.toISOString() }
      return Promise.resolve(settings.enabled)
    },

    acceptAgreement(input: AcceptAgreementInput) {
      const settings = settingsOf(input.organizationId)
      if (settings !== null) {
        settings.consentAgreementVersion = input.version
        settings.consentAcceptedAt = input.now
        settings.agreedFeeBps = input.feeBps
      }
      const history = agreementChanges[input.organizationId] ?? []
      history.unshift({
        version: input.version,
        acceptedAt: input.now,
        acceptedByName: null,
        surface: input.surface,
      })
      agreementChanges[input.organizationId] = history
      return Promise.resolve()
    },

    agreementHistory(organizationId, limit) {
      return Promise.resolve((agreementChanges[organizationId] ?? []).slice(0, limit))
    },

    recentChecks(organizationId, limit) {
      return Promise.resolve((state.checks[organizationId] ?? []).slice(0, limit))
    },

    listAccountsForSync(limit) {
      return Promise.resolve(
        state.accounts
          .filter((account) => account.deauthorizedAt === null)
          .slice(0, limit)
          .map((account) => ({
            organizationId: account.organizationId,
            stripeAccountId: account.stripeAccountId,
          })),
      )
    },

    listOnboardedAccounts(limit, afterOrganizationId) {
      return Promise.resolve(
        state.accounts
          .filter((account) => account.deauthorizedAt === null)
          .filter(
            (account) =>
              afterOrganizationId === null || account.organizationId > afterOrganizationId,
          )
          .sort((a, b) => a.organizationId.localeCompare(b.organizationId))
          .slice(0, limit)
          .map((account) => ({
            organizationId: account.organizationId,
            stripeAccountId: account.stripeAccountId,
            reconciledThrough: account.reconciledThrough,
          })),
      )
    },

    findEventRef(eventId, organizationId) {
      const event = state.events[eventId]
      if (event === undefined) return Promise.resolve(null)
      if (event.organizationId !== undefined && event.organizationId !== organizationId) {
        return Promise.resolve(null)
      }
      return Promise.resolve({ id: event.id, title: event.title, startsAt: event.startsAt })
    },

    findVerifiedUserEmail(userId) {
      return Promise.resolve(state.userEmails[userId] ?? null)
    },

    orgRoleOf(organizationId, userId) {
      return Promise.resolve(state.roles[organizationId]?.[userId] ?? null)
    },
  }
}
