import { describe, expect, it } from "vitest"
import { AppError, ErrorCode } from "@civfix/shared"
import { FakeJobs, FakePayments } from "@civfix/shared/fakes"
import { currentVersion } from "@civfix/shared/legal"
import {
  assertRefundPolicyClaimAllowed,
  computeDonateState,
  computeOnboardingState,
  einLast4,
  makeOrgPaymentsService,
  walletsFromDomains,
  type OrgPaymentsService,
} from "../../../src/services/payments/org-payments-service.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import {
  NOW,
  ORG_ID,
  USER_ID,
  accountRow,
  eligibilityRow,
  orgRow,
  readyAccountStatus,
  settingsRow,
} from "./helpers.js"

function harness(
  seed: Parameters<typeof makeMemoryOrgPaymentsRepository>[0] = {},
  env: { paymentsEnabled?: boolean; domains?: string[] } = {},
): {
  service: OrgPaymentsService
  repo: ReturnType<typeof makeMemoryOrgPaymentsRepository>
  payments: FakePayments
  jobs: FakeJobs
} {
  const repo = makeMemoryOrgPaymentsRepository({
    orgs: seed.orgs ?? [orgRow()],
    accounts: seed.accounts ?? [],
    settings: seed.settings ?? [settingsRow()],
    eligibility: seed.eligibility ?? [eligibilityRow()],
    ...(seed.checks !== undefined ? { checks: seed.checks } : {}),
  })
  const payments = new FakePayments({ now: () => NOW.getTime() })
  const jobs = new FakeJobs()
  const service = makeOrgPaymentsService({
    repo,
    payments,
    jobs,
    env: {
      PAYMENTS_ENABLED: env.paymentsEnabled ?? true,
      DONATION_PLATFORM_FEE_BPS: 500,
      DONATION_MIN_MINOR: 500,
      DONATION_MAX_MINOR: 1_000_000,
      PAYMENT_METHOD_DOMAINS: env.domains ?? [],
      PUBLIC_WEB_ORIGIN: "https://civfix.org",
    },
    now: () => NOW,
  })
  return { service, repo, payments, jobs }
}

async function codeOf(run: () => Promise<unknown>): Promise<ErrorCode | "none"> {
  try {
    await run()
    return "none"
  } catch (err) {
    return err instanceof AppError ? err.code : "none"
  }
}

describe("three-state onboarding gate", () => {
  it("is ready only when charges are on, nothing is disabled and nothing is due", () => {
    expect(computeOnboardingState(readyAccountStatus(), false)).toBe("ready")
  })

  it("is at_risk while Stripe still wants information but charges are on", () => {
    expect(
      computeOnboardingState(readyAccountStatus({ currentlyDue: ["company.tax_id"] }), false),
    ).toBe("at_risk")
    expect(
      computeOnboardingState(readyAccountStatus({ futureCurrentlyDue: ["person.id"] }), false),
    ).toBe("at_risk")
  })

  it("is blocked whenever charges are off or Stripe named a disabled reason", () => {
    expect(computeOnboardingState(readyAccountStatus({ chargesEnabled: false }), false)).toBe(
      "blocked",
    )
    expect(
      computeOnboardingState(readyAccountStatus({ disabledReason: "requirements.past_due" }), false),
    ).toBe("blocked")
  })

  it("lets a disabled reason win over an empty requirements list", () => {
    expect(
      computeOnboardingState(
        readyAccountStatus({ disabledReason: "rejected.fraud", currentlyDue: [] }),
        false,
      ),
    ).toBe("blocked")
  })

  it("is blocked once the account is deauthorized, whatever Stripe reports", () => {
    expect(computeOnboardingState(readyAccountStatus(), true)).toBe("blocked")
  })

  it("is onboarding before details are submitted", () => {
    expect(
      computeOnboardingState(
        readyAccountStatus({ detailsSubmitted: false, currentlyDue: [] }),
        false,
      ),
    ).toBe("onboarding")
  })
})

describe("donate state", () => {
  const base = {
    paymentsEnabled: true,
    account: accountRow(),
    settings: settingsRow(),
    eligibility: eligibilityRow(),
    agreementCurrent: true,
  }

  it("is READY only when every gate is open", () => {
    expect(computeDonateState(base)).toBe("READY")
  })

  it("is OFF when payments are disabled platform-wide", () => {
    expect(computeDonateState({ ...base, paymentsEnabled: false })).toBe("OFF")
  })

  it("is OFF with no connected account, no settings, or donations switched off", () => {
    expect(computeDonateState({ ...base, account: null })).toBe("OFF")
    expect(computeDonateState({ ...base, settings: null })).toBe("OFF")
    expect(computeDonateState({ ...base, settings: settingsRow({ enabled: false }) })).toBe("OFF")
  })

  it("is OFF until the current agreement version is accepted", () => {
    expect(computeDonateState({ ...base, agreementCurrent: false })).toBe("OFF")
  })

  it("is BLOCKED on a blocked account or an ineligible verdict", () => {
    expect(
      computeDonateState({ ...base, account: accountRow({ onboardingState: "blocked" }) }),
    ).toBe("BLOCKED")
    expect(
      computeDonateState({ ...base, eligibility: eligibilityRow({ verdict: "ineligible" }) }),
    ).toBe("BLOCKED")
  })

  it("is AT_RISK on an at-risk account, a grace verdict, or an OFAC review flag (never auto-blocked)", () => {
    expect(
      computeDonateState({ ...base, account: accountRow({ onboardingState: "at_risk" }) }),
    ).toBe("AT_RISK")
    expect(computeDonateState({ ...base, eligibility: eligibilityRow({ verdict: "grace" }) })).toBe(
      "AT_RISK",
    )
    expect(
      computeDonateState({ ...base, eligibility: eligibilityRow({ verdict: "review_required" }) }),
    ).toBe("AT_RISK")
  })

  it("is OFF, never READY, on an unknown verdict", () => {
    expect(computeDonateState({ ...base, eligibility: null })).toBe("OFF")
    expect(computeDonateState({ ...base, eligibility: eligibilityRow({ verdict: "unknown" }) })).toBe(
      "OFF",
    )
  })
})

describe("connect onboarding refusals", () => {
  it("refuses while payments are disabled", async () => {
    const h = harness({}, { paymentsEnabled: false })
    expect(await codeOf(() => h.service.createAccount(ORG_ID, USER_ID))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
  })

  it("refuses an organization that is not a verified nonprofit", async () => {
    const h = harness({ orgs: [orgRow({ verifiedStatus: "pending" })] })
    expect(await codeOf(() => h.service.createAccount(ORG_ID, USER_ID))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
    const government = harness({ orgs: [orgRow({ verifiedKind: "government" })] })
    expect(await codeOf(() => government.service.createAccount(ORG_ID, USER_ID))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
  })

  it("refuses an ineligible organization", async () => {
    const h = harness({ eligibility: [eligibilityRow({ verdict: "ineligible" })] })
    expect(await codeOf(() => h.service.createAccount(ORG_ID, USER_ID))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
  })

  it("refuses until the current agreement version is accepted", async () => {
    const h = harness({ settings: [settingsRow({ consentAgreementVersion: "1900-01-01" })] })
    expect(await codeOf(() => h.service.createAccount(ORG_ID, USER_ID))).toBe(ErrorCode.CONFLICT)
  })

  it("creates the account once and is idempotent afterwards", async () => {
    const h = harness()
    const first = await h.service.createAccount(ORG_ID, USER_ID)
    expect(first.stripeAccountId).not.toBeNull()
    const second = await h.service.createAccount(ORG_ID, USER_ID)
    expect(second.stripeAccountId).toBe(first.stripeAccountId)
    expect(h.repo.state.accounts).toHaveLength(1)
  })

  it("refuses an onboarding link before an account exists", async () => {
    const h = harness()
    expect(await codeOf(() => h.service.createAccountLink(ORG_ID, "onboarding"))).toBe(
      ErrorCode.CONFLICT,
    )
  })

  it("mints a fresh, short-lived account link once an account exists", async () => {
    const h = harness()
    await h.service.createAccount(ORG_ID, USER_ID)
    const link = await h.service.createAccountLink(ORG_ID, "onboarding")
    expect(link.url.length).toBeGreaterThan(0)
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(NOW.getTime())
  })
})

describe("org suspension gate (DECISIONS §32)", () => {
  it("refuses every self-service mutation on a suspended org, but keeps the reads", async () => {
    const h = harness({ orgs: [orgRow({ suspended: true })], accounts: [accountRow()] })
    expect(await codeOf(() => h.service.createAccount(ORG_ID, USER_ID))).toBe(ErrorCode.FORBIDDEN)
    expect(await codeOf(() => h.service.createAccountLink(ORG_ID, "onboarding"))).toBe(
      ErrorCode.FORBIDDEN,
    )
    expect(
      await codeOf(() =>
        h.service.updateSettings({ organizationId: ORG_ID, userId: USER_ID, missionBlurb: "x" }),
      ),
    ).toBe(ErrorCode.FORBIDDEN)
    expect(
      await codeOf(() =>
        h.service.acceptAgreement({
          organizationId: ORG_ID,
          userId: USER_ID,
          version: currentVersion("org_donation_agreement"),
          surface: "web_org_settings",
        }),
      ),
    ).toBe(ErrorCode.FORBIDDEN)
    expect(h.repo.state.settings[0]?.missionBlurb).not.toBe("x")
    // Reads and the platform/operator paths still work.
    expect((await h.service.status(ORG_ID)).organizationId).toBe(ORG_ID)
    expect((await h.service.settings(ORG_ID)).organizationId).toBe(ORG_ID)
    const bare = harness({ orgs: [orgRow({ suspended: true })] })
    expect(await bare.service.syncAccount(ORG_ID)).toBe("not_started")
    expect(
      await h.service.setDonationsEnabledByOperator({
        organizationId: ORG_ID,
        enabled: false,
        reasonText: "under review",
        actorUserId: USER_ID,
      }),
    ).toBe(false)
  })

  it("refuses a reconnect on a suspended org before touching Stripe", async () => {
    const h = harness({
      orgs: [orgRow({ suspended: true })],
      accounts: [accountRow({ deauthorizedAt: NOW })],
    })
    expect(await codeOf(() => h.service.createAccount(ORG_ID, USER_ID))).toBe(ErrorCode.FORBIDDEN)
    expect(h.repo.state.accounts[0]?.deauthorizedAt).toEqual(NOW)
  })
})

describe("account sync effects", () => {
  it("switches donations off with a stripe_blocked reason when the account blocks", async () => {
    const h = harness()
    const status = await h.service.createAccount(ORG_ID, USER_ID)
    const accountId = status.stripeAccountId as string
    h.payments.settleAccount(accountId, { chargesEnabled: false, disabledReason: "rejected.fraud" })

    expect(await h.service.syncAccount(ORG_ID)).toBe("blocked")
    expect(h.repo.state.settings[0]?.enabled).toBe(false)
    expect(h.repo.state.settings[0]?.disabledReason).toBe("stripe_blocked")
  })

  it("switches donations off with a deauthorized reason on deauthorization", async () => {
    const h = harness()
    const status = await h.service.createAccount(ORG_ID, USER_ID)
    const organizationId = await h.service.handleDeauthorization(status.stripeAccountId as string)

    expect(organizationId).toBe(ORG_ID)
    expect(h.repo.state.accounts[0]?.deauthorizedAt).not.toBeNull()
    expect(h.repo.state.accounts[0]?.onboardingState).toBe("blocked")
    expect(h.repo.state.settings[0]?.enabled).toBe(false)
    expect(h.repo.state.settings[0]?.disabledReason).toBe("deauthorized")
  })

  it("relinks a deauthorized organization to a NEW connected account on reconnect", async () => {
    const h = harness()
    const first = await h.service.createAccount(ORG_ID, USER_ID)
    const originalAccountId = first.stripeAccountId as string
    await h.service.handleDeauthorization(originalAccountId)

    const reconnected = await h.service.createAccount(ORG_ID, USER_ID)
    expect(reconnected.stripeAccountId).not.toBe(originalAccountId)
    expect(h.repo.state.accounts).toHaveLength(1)
    expect(h.repo.state.accounts[0]?.deauthorizedAt).toBeNull()
    expect(h.repo.state.accounts[0]?.reconnectAttempts).toBe(1)
    expect(h.repo.state.accounts[0]?.previousStripeAccountIds).toEqual([originalAccountId])
    expect(h.repo.state.settings[0]?.disabledReason).toBe("deauthorized")
  })

  it("clears the deauthorized disable only once the reconnected account can charge", async () => {
    const h = harness()
    const first = await h.service.createAccount(ORG_ID, USER_ID)
    await h.service.handleDeauthorization(first.stripeAccountId as string)
    const reconnected = await h.service.createAccount(ORG_ID, USER_ID)
    expect(h.repo.state.settings[0]?.enabled).toBe(false)

    h.payments.settleAccount(reconnected.stripeAccountId as string)
    expect(await h.service.syncAccount(ORG_ID)).toBe("ready")
    expect(h.repo.state.settings[0]?.enabled).toBe(true)
    expect(h.repo.state.settings[0]?.disabledReason).toBeNull()
  })

  it("keeps the original account when the organization re-authorized it at Stripe", async () => {
    const h = harness()
    const first = await h.service.createAccount(ORG_ID, USER_ID)
    const accountId = first.stripeAccountId as string
    h.payments.settleAccount(accountId)
    await h.service.handleDeauthorization(accountId)

    const reconnected = await h.service.createAccount(ORG_ID, USER_ID)
    expect(reconnected.stripeAccountId).toBe(accountId)
    expect(h.repo.state.accounts[0]?.deauthorizedAt).toBeNull()
    expect(h.repo.state.accounts[0]?.reconnectAttempts).toBe(0)
    expect(h.repo.state.settings[0]?.enabled).toBe(true)
    expect(h.repo.state.settings[0]?.disabledReason).toBeNull()
  })

  it("mints one new account per reconnect attempt", async () => {
    const h = harness()
    const first = await h.service.createAccount(ORG_ID, USER_ID)
    await h.service.handleDeauthorization(first.stripeAccountId as string)
    const second = await h.service.createAccount(ORG_ID, USER_ID)
    await h.service.handleDeauthorization(second.stripeAccountId as string)
    const third = await h.service.createAccount(ORG_ID, USER_ID)

    expect(new Set([first.stripeAccountId, second.stripeAccountId, third.stripeAccountId]).size).toBe(3)
    expect(h.repo.state.accounts[0]?.reconnectAttempts).toBe(2)
  })

  it("registers the payment method domains once charges turn on, and does not repeat itself", async () => {
    const h = harness({}, { domains: ["civfix.org"] })
    const status = await h.service.createAccount(ORG_ID, USER_ID)
    h.payments.settleAccount(status.stripeAccountId as string)
    expect(await h.service.syncAccount(ORG_ID)).toBe("ready")

    await h.service.registerPaymentMethodDomains(ORG_ID)
    expect(h.repo.state.accounts[0]?.paymentMethodDomains).toHaveLength(1)
    expect(h.repo.state.accounts[0]?.paymentMethodDomains[0]?.domain).toBe("civfix.org")
    expect(h.repo.state.accounts[0]?.paymentMethodDomains[0]?.enabled).toBe(true)

    await h.service.registerPaymentMethodDomains(ORG_ID)
    expect(h.repo.state.accounts[0]?.paymentMethodDomains).toHaveLength(1)
  })

  it("does not register domains while charges are still off", async () => {
    const h = harness(
      { accounts: [accountRow({ chargesEnabled: false, onboardingState: "onboarding" })] },
      { domains: ["civfix.org"] },
    )
    await h.service.registerPaymentMethodDomains(ORG_ID)
    expect(h.repo.state.accounts[0]?.paymentMethodDomains).toHaveLength(0)
  })
})

describe("settings and agreement", () => {
  it("refuses to enable donations until the gate is actually open", async () => {
    const h = harness({ accounts: [accountRow({ onboardingState: "blocked" })] })
    expect(
      await codeOf(() =>
        h.service.updateSettings({ organizationId: ORG_ID, userId: USER_ID, enabled: true }),
      ),
    ).toBe(ErrorCode.PAYMENT_UNAVAILABLE)
  })

  it("refuses to let an organization re-enable what the platform disabled", async () => {
    for (const disabledReason of ["operator", "eligibility", "stripe_blocked", "deauthorized"] as const) {
      const h = harness({
        accounts: [accountRow()],
        settings: [settingsRow({ enabled: false, disabledReason })],
      })
      expect(
        await codeOf(() =>
          h.service.updateSettings({ organizationId: ORG_ID, userId: USER_ID, enabled: true }),
        ),
      ).toBe(ErrorCode.FORBIDDEN)
      expect(h.repo.state.settings[0]?.enabled).toBe(false)
      expect(h.repo.state.settings[0]?.disabledReason).toBe(disabledReason)
    }
  })

  it("still refuses to let an organization turn a platform disable back off", async () => {
    const h = harness({
      accounts: [accountRow()],
      settings: [settingsRow({ enabled: false, disabledReason: "operator" })],
    })
    expect(
      await codeOf(() =>
        h.service.updateSettings({ organizationId: ORG_ID, userId: USER_ID, enabled: false }),
      ),
    ).toBe(ErrorCode.FORBIDDEN)
  })

  it("lets an organization re-enable what it switched off itself", async () => {
    const h = harness({
      accounts: [accountRow()],
      settings: [settingsRow({ enabled: false, disabledReason: "org" })],
    })
    const settings = await h.service.updateSettings({
      organizationId: ORG_ID,
      userId: USER_ID,
      enabled: true,
    })
    expect(settings.enabled).toBe(true)
  })

  it("turns donations back on once the payout account stops being blocked", async () => {
    const h = harness({
      accounts: [accountRow({ chargesEnabled: true, onboardingState: "at_risk" })],
      settings: [settingsRow({ enabled: false, disabledReason: "stripe_blocked" })],
    })
    const created = await h.payments.createConnectedAccount({
      orgId: ORG_ID,
      legalName: "REACH OUT LOS ANGELES INC",
      idempotencyKey: `acct:${ORG_ID}:v1`,
    })
    h.payments.settleAccount(created.accountId)
    h.repo.state.accounts[0] = accountRow({ stripeAccountId: created.accountId })
    await h.service.syncAccount(ORG_ID)
    expect(h.repo.state.settings[0]?.enabled).toBe(true)
    expect(h.repo.state.settings[0]?.disabledReason).toBeNull()
  })

  it("bounds the amounts against the platform limits and against each other", async () => {
    const h = harness({ accounts: [accountRow()] })
    expect(
      await codeOf(() =>
        h.service.updateSettings({ organizationId: ORG_ID, userId: USER_ID, minAmountMinor: 100 }),
      ),
    ).toBe(ErrorCode.VALIDATION)
    expect(
      await codeOf(() =>
        h.service.updateSettings({
          organizationId: ORG_ID,
          userId: USER_ID,
          maxAmountMinor: 5_000_000,
        }),
      ),
    ).toBe(ErrorCode.VALIDATION)
    expect(
      await codeOf(() =>
        h.service.updateSettings({
          organizationId: ORG_ID,
          userId: USER_ID,
          minAmountMinor: 10_000,
          maxAmountMinor: 5_000,
        }),
      ),
    ).toBe(ErrorCode.VALIDATION)
  })

  it("refuses a suggested amount outside the organization's own range", async () => {
    const h = harness({ accounts: [accountRow()] })
    expect(
      await codeOf(() =>
        h.service.updateSettings({
          organizationId: ORG_ID,
          userId: USER_ID,
          suggestedAmountsMinor: [100],
        }),
      ),
    ).toBe(ErrorCode.VALIDATION)
  })

  it("records the current agreement version and reports it as current", async () => {
    const h = harness({
      accounts: [accountRow()],
      settings: [settingsRow({ consentAgreementVersion: null, consentAcceptedAt: null })],
    })
    const agreement = await h.service.acceptAgreement({
      organizationId: ORG_ID,
      userId: USER_ID,
      version: currentVersion("org_donation_agreement"),
      surface: "web_org_settings",
    })
    expect(agreement.current).toBe(true)
    expect(agreement.version).toBe(currentVersion("org_donation_agreement"))
  })

  it("refuses an acceptance of a stale agreement version", async () => {
    const h = harness({ accounts: [accountRow()] })
    expect(
      await codeOf(() =>
        h.service.acceptAgreement({
          organizationId: ORG_ID,
          userId: USER_ID,
          version: "1900-01-01",
          surface: "web_org_settings",
        }),
      ),
    ).toBe(ErrorCode.CONFLICT)
  })

  it("refuses an acceptance whose displayed hash no longer matches the published text", async () => {
    const h = harness({ accounts: [accountRow()] })
    expect(
      await codeOf(() =>
        h.service.acceptAgreement({
          organizationId: ORG_ID,
          userId: USER_ID,
          version: currentVersion("org_donation_agreement"),
          documentSha256: "0".repeat(64),
          surface: "web_org_settings",
        }),
      ),
    ).toBe(ErrorCode.CONFLICT)
  })

  it("never exposes more than the last four EIN digits", () => {
    expect(einLast4("954327245")).toBe("7245")
    expect(einLast4("95-4327245")).toBe("7245")
    expect(einLast4(null)).toBeNull()
    expect(einLast4("12")).toBeNull()
  })

  it("reports wallets only once a domain registration is enabled", () => {
    expect(walletsFromDomains([])).toEqual([])
    expect(
      walletsFromDomains([{ domain: "civfix.org", id: "pmd_1", enabled: false, registeredAt: null }]),
    ).toEqual([])
    expect(
      walletsFromDomains([{ domain: "civfix.org", id: "pmd_1", enabled: true, registeredAt: null }])
        .length,
    ).toBeGreaterThan(0)
  })
})

describe("operator disable", () => {
  it("records the operator reason and blocks the org from undoing it", async () => {
    const h = harness({ accounts: [accountRow()] })
    const enabled = await h.service.setDonationsEnabledByOperator({
      organizationId: ORG_ID,
      enabled: false,
      reasonText: "pending compliance review",
      actorUserId: USER_ID,
    })
    expect(enabled).toBe(false)
    expect(h.repo.state.settings[0]?.disabledReason).toBe("operator")
    expect(h.repo.state.settings[0]?.disabledReasonText).toBe("pending compliance review")
  })
})

describe("§314(d): a host may not publish a 100%-to-charity claim", () => {
  it("rejects the claim in the host-authored refund policy, naming the field", () => {
    for (const text of [
      "100% of your donation goes to us",
      "we pass on 100 percent of every gift",
      "100  PERCENT to the cause",
      "One hundred percent? 100%.",
    ]) {
      let caught: unknown
      try {
        assertRefundPolicyClaimAllowed(text)
      } catch (err) {
        caught = err
      }
      expect(caught, text).toBeInstanceOf(AppError)
      expect((caught as AppError).code, text).toBe(ErrorCode.VALIDATION)
      expect((caught as AppError).fields, text).toHaveProperty("refundPolicyText")
    }
  })

  it("refuses the claim through updateOrgDonationSettings, before anything is stored", async () => {
    const h = harness({ accounts: [accountRow()] })
    expect(
      await codeOf(() =>
        h.service.updateSettings({
          organizationId: ORG_ID,
          userId: USER_ID,
          refundPolicyText: "100% of your donation goes straight to the shelter.",
        }),
      ),
    ).toBe(ErrorCode.VALIDATION)
    const after = await h.service.settings(ORG_ID)
    expect(after.refundPolicyText ?? null).toBeNull()
  })

  it("stores an honest refund policy through the same path", async () => {
    const h = harness({ accounts: [accountRow()] })
    await h.service.updateSettings({
      organizationId: ORG_ID,
      userId: USER_ID,
      refundPolicyText: "Refunds within 30 days, less processing fees.",
    })
    const after = await h.service.settings(ORG_ID)
    expect(after.refundPolicyText).toBe("Refunds within 30 days, less processing fees.")
  })

  it("leaves an honest refund policy alone", () => {
    for (const text of [
      null,
      undefined,
      "Refunds within 30 days, less processing fees.",
      "We refund 90% of the gift on request.",
      "Donations are non-refundable after 10 days.",
    ]) {
      expect(() => assertRefundPolicyClaimAllowed(text)).not.toThrow()
    }
  })
})
