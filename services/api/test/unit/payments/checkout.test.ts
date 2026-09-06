import { describe, expect, it } from "vitest"
import { AppError, ErrorCode } from "@civfix/shared"
import { FakePayments } from "@civfix/shared/fakes"
import {
  DONATION_DISCLOSURE_IDS,
  platformFeePercent,
  renderDonationDisclosures,
} from "@civfix/shared/legal"
import {
  DONATION_ID,
  NOW,
  ORG_SLUG,
  accountRow,
  currentConsent,
  donationHarness,
  eligibilityRow,
  seedConnectedAccount,
  settingsRow,
  orgRow,
} from "./helpers.js"

async function readyHarness(seed: Parameters<typeof donationHarness>[0] = {}) {
  const payments = new FakePayments({ now: () => NOW.getTime() })
  const accountId = await seedConnectedAccount(payments)
  const harness = donationHarness(
    { accounts: [accountRow({ stripeAccountId: accountId })], ...seed },
    { payments },
  )
  return harness
}

function checkoutInput(patch: Record<string, unknown> = {}) {
  return {
    orgSlug: ORG_SLUG,
    amountMinor: 5000,
    email: "donor@example.org",
    shareIdentity: false,
    idempotencyKey: "idem-key-0001",
    userId: null,
    consent: currentConsent(),
    ...patch,
  } as Parameters<Awaited<ReturnType<typeof readyHarness>>["service"]["createCheckout"]>[0]
}

async function codeOf(run: () => Promise<unknown>): Promise<ErrorCode | "none"> {
  try {
    await run()
    return "none"
  } catch (err) {
    return err instanceof AppError ? err.code : "none"
  }
}

describe("donation checkout refusals, cheapest first", () => {
  it("503s when payments are disabled platform-wide, before any lookup", async () => {
    const h = donationHarness({}, { paymentsEnabled: false })
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
    expect(h.donations.rows).toHaveLength(0)
  })

  it("404s for an unknown organization", async () => {
    const h = await readyHarness()
    expect(await codeOf(() => h.service.createCheckout(checkoutInput({ orgSlug: "nope" })))).toBe(
      ErrorCode.NOT_FOUND,
    )
  })

  it("404s, never 403s, when donations are switched off", async () => {
    const h = await readyHarness({ settings: [settingsRow({ enabled: false })] })
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(ErrorCode.NOT_FOUND)
  })

  it("503s when the connected account is blocked", async () => {
    const h = await readyHarness({
      accounts: [accountRow({ onboardingState: "blocked", chargesEnabled: false })],
    })
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
    expect(h.donations.rows).toHaveLength(0)
  })

  it("503s when the organization is ineligible", async () => {
    const h = await readyHarness({ eligibility: [eligibilityRow({ verdict: "ineligible" })] })
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
  })

  it("503s when the eligibility evidence is stale beyond the grace window", async () => {
    const stale = new Date(NOW.getTime() - 73 * 3600_000)
    const h = await readyHarness({ eligibility: [eligibilityRow({ evaluatedAt: stale })] })
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
  })

  it("422s on an amount outside the organization's range", async () => {
    const h = await readyHarness()
    expect(await codeOf(() => h.service.createCheckout(checkoutInput({ amountMinor: 100 })))).toBe(
      ErrorCode.VALIDATION,
    )
    expect(
      await codeOf(() => h.service.createCheckout(checkoutInput({ amountMinor: 2_000_000 }))),
    ).toBe(ErrorCode.VALIDATION)
  })

  it("409s when a consent document version has moved on", async () => {
    const h = await readyHarness()
    const stale = { ...currentConsent(), termsVersion: "1900-01-01" }
    expect(await codeOf(() => h.service.createCheckout(checkoutInput({ consent: stale })))).toBe(
      ErrorCode.CONFLICT,
    )
    expect(h.donations.rows).toHaveLength(0)
  })
})

describe("donation checkout success path", () => {
  it("writes the donation row and its consent records BEFORE any Stripe call", async () => {
    const payments = new FakePayments({ now: () => NOW.getTime() })
    const accountId = await seedConnectedAccount(payments)
    const h = donationHarness({ accounts: [accountRow({ stripeAccountId: accountId })] }, { payments })

    let rowsAtStripeCall = -1
    const original = payments.createDonationCheckout.bind(payments)
    payments.createDonationCheckout = (input) => {
      rowsAtStripeCall = h.donations.rows.length
      return original(input)
    }

    await h.service.createCheckout(checkoutInput())
    expect(rowsAtStripeCall).toBe(1)
  })

  it("charges min(env, agreed) basis points and returns the itemized breakdown", async () => {
    const payments = new FakePayments({ now: () => NOW.getTime() })
    const accountId = await seedConnectedAccount(payments)
    const h = donationHarness(
      {
        accounts: [accountRow({ stripeAccountId: accountId })],
        settings: [settingsRow({ agreedFeeBps: 300 })],
      },
      { payments },
    )
    const result = await h.service.createCheckout(checkoutInput({ amountMinor: 10_000 }))
    expect(result.feeBreakdown.platformFeeBps).toBe(300)
    expect(result.feeBreakdown.platformFeeMinor).toBe(300)
    expect(h.donations.rows[0]?.feePlatformMinor).toBe(300)
  })

  it("never charges above the agreed rate even when the env value is raised", async () => {
    const payments = new FakePayments({ now: () => NOW.getTime() })
    const accountId = await seedConnectedAccount(payments)
    const h = donationHarness(
      {
        accounts: [accountRow({ stripeAccountId: accountId })],
        settings: [settingsRow({ agreedFeeBps: 200 })],
      },
      { payments },
    )
    const result = await h.service.createCheckout(checkoutInput({ amountMinor: 10_000 }))
    expect(result.feeBreakdown.platformFeeBps).toBe(200)
  })

  it("returns a status token and a return url carrying it", async () => {
    const h = await readyHarness()
    const result = await h.service.createCheckout(checkoutInput())
    expect(result.statusToken.startsWith("v1.")).toBe(true)
    expect(result.returnUrl).toContain(`donation=${DONATION_ID}`)
    expect(result.returnUrl).toContain(`t=${result.statusToken}`)
    expect(result.returnUrl).toContain("session_id={CHECKOUT_SESSION_ID}")
  })

  it("replays the same donation and the same client secret for a repeated idempotency key", async () => {
    const h = await readyHarness()
    const first = await h.service.createCheckout(checkoutInput())
    const second = await h.service.createCheckout(checkoutInput())
    expect(second.donationId).toBe(first.donationId)
    expect(second.clientSecret).toBe(first.clientSecret)
    expect(h.donations.rows).toHaveLength(1)
  })

  it("never mints a second checkout session for a donation that already has one", async () => {
    const h = await readyHarness()
    const first = await h.service.createCheckout(checkoutInput())
    let created = 0
    const create = h.payments.createDonationCheckout.bind(h.payments)
    h.payments.createDonationCheckout = (input) => {
      created += 1
      return create(input)
    }
    const second = await h.service.createCheckout(checkoutInput())
    expect(created).toBe(0)
    expect(second.clientSecret).toBe(first.clientSecret)
    expect(h.donations.rows).toHaveLength(1)
  })

  it("409s a replay whose checkout session has expired instead of opening a new one", async () => {
    const h = await readyHarness()
    await h.service.createCheckout(checkoutInput())
    const sessionId = h.donations.rows[0]?.stripeCheckoutSessionId as string
    h.payments.expireCheckout(sessionId)
    let created = 0
    h.payments.createDonationCheckout = () => {
      created += 1
      return Promise.reject(new Error("must not be called"))
    }
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(ErrorCode.CONFLICT)
    expect(created).toBe(0)
  })

  it("409s a replay of an idempotency key whose donation already succeeded", async () => {
    const h = await readyHarness()
    await h.service.createCheckout(checkoutInput())
    const row = h.donations.rows[0]
    if (row !== undefined) row.status = "succeeded"
    let created = 0
    h.payments.createDonationCheckout = () => {
      created += 1
      return Promise.reject(new Error("must not be called"))
    }
    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(ErrorCode.CONFLICT)
    expect(created).toBe(0)
    expect(h.donations.rows).toHaveLength(1)
  })

  it("keeps different donors' identical keys apart", async () => {
    const h = await readyHarness()
    let n = 0
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
    const withIds = donationHarness(
      { accounts: [accountRow({ stripeAccountId: "acct_fake_1" })] },
      { payments: h.payments, newId: () => ids[n++] as string },
    )
    await withIds.service.createCheckout(checkoutInput({ email: "a@example.org" }))
    await withIds.service.createCheckout(checkoutInput({ email: "b@example.org" }))
    expect(withIds.donations.rows).toHaveLength(2)
  })

  it("leaves the row pending and surfaces PAYMENT_UNAVAILABLE when Stripe is down", async () => {
    const payments = new FakePayments({ now: () => NOW.getTime() })
    const accountId = await seedConnectedAccount(payments)
    const h = donationHarness({ accounts: [accountRow({ stripeAccountId: accountId })] }, { payments })
    payments.createDonationCheckout = () =>
      Promise.reject(AppError.paymentUnavailable("Payments are temporarily unavailable"))

    expect(await codeOf(() => h.service.createCheckout(checkoutInput()))).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
    expect(h.donations.rows).toHaveLength(1)
    expect(h.donations.rows[0]?.status).toBe("pending")
    expect(h.donations.rows[0]?.stripeCheckoutSessionId).toBeNull()
  })
})

describe("donation checkout event attribution and session expiry", () => {
  const EVENT_ID = "eeeeeeee-7777-4777-8777-eeeeeeeeeeee"

  it("422s when the event id belongs to another organization", async () => {
    const h = await readyHarness({
      events: {
        [EVENT_ID]: {
          id: EVENT_ID,
          title: "Someone else's cleanup",
          startsAt: NOW.toISOString(),
          organizationId: "ffffffff-8888-4888-8888-ffffffffffff",
        },
      },
    })
    expect(await codeOf(() => h.service.createCheckout(checkoutInput({ eventId: EVENT_ID })))).toBe(
      ErrorCode.VALIDATION,
    )
    expect(h.donations.rows).toHaveLength(0)
  })

  it("attributes a donation to an event the organization owns", async () => {
    const h = await readyHarness({
      events: {
        [EVENT_ID]: { id: EVENT_ID, title: "Beach cleanup", startsAt: NOW.toISOString() },
      },
    })
    await h.service.createCheckout(checkoutInput({ eventId: EVENT_ID }))
    expect(h.donations.rows[0]?.eventId).toBe(EVENT_ID)
  })

  it("asks Stripe for an expiry above the 30-minute floor Stripe enforces", async () => {
    const h = await readyHarness()
    const result = await h.service.createCheckout(checkoutInput())
    const ttlSec = (new Date(result.expiresAt).getTime() - NOW.getTime()) / 1000
    expect(ttlSec).toBeGreaterThanOrEqual(30 * 60)
    expect(h.donations.rows[0]?.sessionExpiresAt?.toISOString()).toBe(result.expiresAt)
  })

  it("runs the human and quota checks only after the cheap refusals", async () => {
    const h = await readyHarness({ settings: [settingsRow({ enabled: false })] })
    let called = 0
    expect(
      await codeOf(() =>
        h.service.createCheckout(
          checkoutInput({
            beforeAuthorize: () => {
              called += 1
              return Promise.resolve()
            },
          }),
        ),
      ),
    ).toBe(ErrorCode.NOT_FOUND)
    expect(called).toBe(0)
  })

  it("does not burn the quota again when a donor replays their idempotency key", async () => {
    const h = await readyHarness()
    let called = 0
    const input = checkoutInput({
      beforeAuthorize: () => {
        called += 1
        return Promise.resolve()
      },
    })
    await h.service.createCheckout(input)
    await h.service.createCheckout(input)
    expect(called).toBe(1)
  })
})

describe("public donate page", () => {
  it("404s rather than 403s when the organization cannot take donations", async () => {
    const h = await readyHarness({ settings: [settingsRow({ enabled: false })] })
    expect(await codeOf(() => h.service.publicPage(ORG_SLUG))).toBe(ErrorCode.NOT_FOUND)
  })

  it("serves server-authored disclosures, the legal versions and the registration number", async () => {
    const h = await readyHarness()
    const page = await h.service.publicPage(ORG_SLUG)
    expect(page.donateState).toBe("READY")
    expect(page.registrationNumber).toBe("CFP-123456")
    expect(page.disclosureVersion.length).toBeGreaterThan(0)
    expect(page.legalVersions.length).toBeGreaterThan(0)
    expect(page.org.legalName).toBe("REACH OUT LOS ANGELES INC")
    expect(page.org.einLast4).toBe("7245")
    expect(page.donorSharing.defaultOn).toBe(false)
    expect(page.disclosures.recipient).toContain("REACH OUT LOS ANGELES INC")
    expect(page.disclosures.feePointer).toContain("5.00%")
    expect(page.disclosures.mayNotReceiveReasons.length).toBeGreaterThan(0)
  })

  it("renders every disclosure from the shared statutory template so the hashed text cannot drift", async () => {
    const h = await readyHarness()
    const page = await h.service.publicPage(ORG_SLUG)
    const expected = renderDonationDisclosures(
      {
        orgLegalName: "REACH OUT LOS ANGELES INC",
        platformFeePercent: platformFeePercent(page.platformFeeBps),
        webOrigin: "https://civfix.org",
      },
      { deductible: true, refundPolicyText: null },
    )
    expect(page.disclosures).toEqual({ ...expected, deductibilityCheckedAt: NOW.toISOString() })
    for (const id of DONATION_DISCLOSURE_IDS) {
      expect(page.disclosures[id].length).toBeGreaterThan(0)
    }
    expect(DONATION_DISCLOSURE_IDS).toHaveLength(7)
  })

  it("renders the not-deductible sentence and a host-authored refund policy from the same template", async () => {
    const h = await readyHarness({
      eligibility: [eligibilityRow({ contributionsDeductible: false })],
      settings: [settingsRow({ refundPolicyText: "We refund within 14 days." })],
    })
    const page = await h.service.publicPage(ORG_SLUG)
    const expected = renderDonationDisclosures(
      {
        orgLegalName: "REACH OUT LOS ANGELES INC",
        platformFeePercent: platformFeePercent(page.platformFeeBps),
        webOrigin: "https://civfix.org",
      },
      { deductible: false, refundPolicyText: "We refund within 14 days." },
    )
    expect(page.disclosures.deductibility).toBe(expected.deductibility)
    expect(page.disclosures.refundPolicy).toBe("We refund within 14 days.")
  })

  it("never claims that 100% of a donation reaches the organization", async () => {
    const h = await readyHarness()
    const page = await h.service.publicPage(ORG_SLUG)
    expect(JSON.stringify(page)).not.toContain("100%")
  })

  it("reports AT_RISK while the account still needs information", async () => {
    const h = await readyHarness({
      accounts: [accountRow({ onboardingState: "at_risk", currentlyDue: ["company.tax_id"] })],
    })
    expect((await h.service.publicPage(ORG_SLUG)).donateState).toBe("AT_RISK")
  })

  it("exposes wallets only once a payment method domain is registered", async () => {
    const withoutDomains = await readyHarness()
    expect((await withoutDomains.service.publicPage(ORG_SLUG)).walletsAvailable).toEqual([])

    const withDomains = await readyHarness({
      accounts: [
        accountRow({
          paymentMethodDomains: [
            { domain: "civfix.org", id: "pmd_1", enabled: true, registeredAt: NOW.toISOString() },
          ],
        }),
      ],
    })
    expect((await withDomains.service.publicPage(ORG_SLUG)).walletsAvailable.length).toBeGreaterThan(0)
  })

  it("404s rather than publishing a negative compliance judgement about a named charity", async () => {
    const ineligible = await readyHarness({
      eligibility: [eligibilityRow({ verdict: "ineligible" })],
      settings: [settingsRow()],
      orgs: [orgRow()],
    })
    expect(await codeOf(() => ineligible.service.publicPage(ORG_SLUG))).toBe(ErrorCode.NOT_FOUND)

    const underReview = await readyHarness({
      eligibility: [eligibilityRow({ verdict: "review_required" })],
      settings: [settingsRow()],
      orgs: [orgRow()],
    })
    expect((await underReview.service.publicPage(ORG_SLUG)).donateState).toBe("AT_RISK")

    const blocked = await readyHarness({
      accounts: [accountRow({ onboardingState: "blocked", chargesEnabled: false })],
    })
    expect(await codeOf(() => blocked.service.publicPage(ORG_SLUG))).toBe(ErrorCode.NOT_FOUND)
  })
})
