import { FakeJobs, FakePayments, FakeStorage } from "@civfix/shared/fakes"
import { currentVersion } from "@civfix/shared/legal"
import type { ConnectedAccountStatus } from "@civfix/shared/interfaces"
import {
  makeMemoryOrgPaymentsRepository,
  type MemoryOrgPaymentsSeed,
} from "../../../src/services/payments/org-payments-repository.memory.js"
import { makeMemoryDonationRepository } from "../../../src/services/payments/donation-repository.memory.js"
import {
  makeDonationService,
  type DonationService,
} from "../../../src/services/payments/donation-service.js"
import type {
  DonationSettingsRecord,
  EligibilityRecord,
  OrgIdentityRow,
  StripeAccountRecord,
} from "../../../src/services/payments/org-payments-repository.drizzle.js"

export const NOW = new Date("2026-06-01T12:00:00.000Z")

export const ORG_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
export const ORG_SLUG = "reach-out-la"
export const USER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
export const DONATION_ID = "cccccccc-3333-4333-8333-cccccccccccc"
export const STATUS_TOKEN_KEY = "a-donation-status-token-key-of-32-chars"

export function orgRow(patch: Partial<OrgIdentityRow> = {}): OrgIdentityRow {
  return {
    id: ORG_ID,
    slug: ORG_SLUG,
    name: "Reach Out LA",
    logoUrl: null,
    verifiedStatus: "verified",
    verifiedKind: "nonprofit",
    suspended: false,
    ...patch,
  }
}

export function accountRow(patch: Partial<StripeAccountRecord> = {}): StripeAccountRecord {
  return {
    organizationId: ORG_ID,
    stripeAccountId: "acct_fake_1",
    livemode: false,
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    disabledReason: null,
    currentlyDue: [],
    pastDue: [],
    pendingVerification: [],
    futureCurrentlyDue: [],
    capabilities: { card_payments: "active", transfers: "active" },
    currentDeadline: null,
    onboardingState: "ready",
    paymentMethodDomains: [],
    deauthorizedAt: null,
    reconnectAttempts: 0,
    previousStripeAccountIds: [],
    reconciledThrough: null,
    lastSyncedAt: NOW,
    ...patch,
  }
}

export function settingsRow(patch: Partial<DonationSettingsRecord> = {}): DonationSettingsRecord {
  return {
    organizationId: ORG_ID,
    enabled: true,
    disabledReason: null,
    disabledReasonText: null,
    disabledBy: null,
    donorSharingDefault: false,
    missionBlurb: null,
    designationNote: null,
    refundPolicyText: null,
    agreedFeeBps: 500,
    consentAgreementVersion: currentVersion("org_donation_agreement"),
    consentAcceptedAt: NOW,
    consentAcceptedByName: "Owner",
    minAmountMinor: 500,
    maxAmountMinor: 1_000_000,
    suggestedAmountsMinor: [2500, 5000],
    ...patch,
  }
}

export function eligibilityRow(patch: Partial<EligibilityRecord> = {}): EligibilityRecord {
  return {
    organizationId: ORG_ID,
    verdict: "eligible",
    reasons: [],
    ein: "954327245",
    irsLegalName: "REACH OUT LOS ANGELES INC",
    irsAddress: { line1: "1 Civic Way", city: "Los Angeles", state: "CA", postalCode: "90012" },
    deductibilityCode: "1",
    foundationCode: "15",
    contributionsDeductible: true,
    groupExemptionSubordinate: false,
    centralOrgConfirmedAt: null,
    mnosFirstSeenOn: null,
    graceExpiresAt: null,
    evaluatedAt: NOW,
    nextCheckAt: null,
    ...patch,
  }
}

export function readyAccountStatus(patch: Partial<ConnectedAccountStatus> = {}): ConnectedAccountStatus {
  return {
    accountId: "acct_fake_1",
    livemode: false,
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    disabledReason: null,
    currentlyDue: [],
    pastDue: [],
    pendingVerification: [],
    futureCurrentlyDue: [],
    currentDeadlineSec: null,
    capabilities: { card_payments: "active", transfers: "active" },
    ...patch,
  }
}

export function currentConsent(): {
  termsVersion: string
  privacyVersion: string
  donationTermsVersion: string
  disclosureVersion: string
  surface: string
  screenRoute: string
  uiTemplateVersion: string
} {
  return {
    termsVersion: currentVersion("terms"),
    privacyVersion: currentVersion("privacy"),
    donationTermsVersion: currentVersion("donations"),
    disclosureVersion: currentVersion("donation_disclosure"),
    surface: "web_donate",
    screenRoute: "/donate/reach-out-la",
    uiTemplateVersion: "1",
  }
}

export interface DonationHarness {
  service: DonationService
  orgs: ReturnType<typeof makeMemoryOrgPaymentsRepository>
  donations: ReturnType<typeof makeMemoryDonationRepository>
  payments: FakePayments
  jobs: FakeJobs
  storage: FakeStorage
}

export function donationHarness(
  seed: MemoryOrgPaymentsSeed = {},
  overrides: {
    payments?: FakePayments
    paymentsEnabled?: boolean
    now?: () => Date
    newId?: () => string
  } = {},
): DonationHarness {
  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: seed.orgs ?? [orgRow()],
    accounts: seed.accounts ?? [accountRow()],
    settings: seed.settings ?? [settingsRow()],
    eligibility: seed.eligibility ?? [eligibilityRow()],
    ...(seed.checks !== undefined ? { checks: seed.checks } : {}),
    ...(seed.roles !== undefined ? { roles: seed.roles } : {}),
    ...(seed.events !== undefined ? { events: seed.events } : {}),
  })
  const donations = makeMemoryDonationRepository({ orgNameOf: () => "Reach Out LA" })
  const payments = overrides.payments ?? new FakePayments({ now: () => NOW.getTime() })
  const jobs = new FakeJobs()
  const storage = new FakeStorage()

  const service = makeDonationService({
    donations,
    orgs,
    payments,
    jobs,
    storage,
    env: {
      PAYMENTS_ENABLED: overrides.paymentsEnabled ?? true,
      DONATION_PLATFORM_FEE_BPS: 500,
      DONATION_MIN_MINOR: 500,
      DONATION_MAX_MINOR: 1_000_000,
      DONATION_STATUS_TOKEN_KEY: STATUS_TOKEN_KEY,
      ELIGIBILITY_STALE_GRACE_HOURS: 72,
      PUBLIC_WEB_ORIGIN: "https://civfix.org",
      CA_CFP_REGISTRATION_NUMBER: "CFP-123456",
    },
    now: overrides.now ?? (() => NOW),
    ...(overrides.newId !== undefined ? { newId: overrides.newId } : { newId: () => DONATION_ID }),
  })

  return { service, orgs, donations, payments, jobs, storage }
}

export async function seedConnectedAccount(payments: FakePayments): Promise<string> {
  const created = await payments.createConnectedAccount({
    orgId: ORG_ID,
    email: "org@civfix.org",
    legalName: "REACH OUT LOS ANGELES INC",
    idempotencyKey: `acct:${ORG_ID}:v1`,
  })
  payments.settleAccount(created.accountId)
  return created.accountId
}
