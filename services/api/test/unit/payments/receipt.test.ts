import { describe, expect, it } from "vitest"
import { FakeMailer, FakePayments, FakeStorage } from "@civfix/shared/fakes"
import type { OutboundEmail } from "@civfix/shared/interfaces"
import {
  buildDonationReceiptModel,
  formatMoney,
  formatReceiptDate,
  maskEin,
  receiptStatements,
} from "../../../src/services/payments/donation-receipt-model.js"
import { buildDonationReceiptPdf } from "../../../src/services/payments/donation-receipt-pdf.js"
import { sendDonationReceipt, type PaymentsRuntime } from "../../../src/services/payments/payments-jobs.js"
import {
  makeMemoryDonationRepository,
  makeMemoryStripeEventRepository,
} from "../../../src/services/payments/donation-repository.memory.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { makeMemoryOrgPayoutsRepository } from "../../../src/services/payments/org-payouts-repository.memory.js"
import { loadPaymentsEnv } from "../../../src/env/payments-env.js"
import { NOW, ORG_ID, accountRow, eligibilityRow, orgRow, settingsRow } from "./helpers.js"

const CHARGED_AT = new Date("2026-05-20T03:00:00.000Z")
const DONATION_ID = "ffffffff-6666-4666-8666-ffffffffffff"

function model(patch: Partial<Parameters<typeof buildDonationReceiptModel>[0]> = {}) {
  return buildDonationReceiptModel({
    donationId: DONATION_ID,
    reference: "CFD-ABC123",
    status: "succeeded",
    amountMinor: 5000,
    refundedTotalMinor: 0,
    chargedAt: CHARGED_AT,
    donorEmail: "donor@example.org",
    donorName: "Alex Donor",
    feeBps: 500,
    feePlatformMinor: 250,
    feeStripeMinor: 175,
    netMinor: 4575,
    deductible: true,
    deductiblePercentage: 100,
    donee: {
      legalName: "REACH OUT LOS ANGELES INC",
      ein: "954327245",
      addressLine1: "1 Civic Way",
      city: "Los Angeles",
      state: "CA",
      postalCode: "90012",
      evidenceSource: "irs",
      evidenceRevisionDate: "2026-05-01",
    },
    orgContactEmail: null,
    registrationNumber: "CFP-123456",
    platformLegalName: "Reach Out Los Angeles",
    ...patch,
  })
}

describe("receipt model", () => {
  it("uses the charge date as the contribution date", () => {
    expect(model().contributionDate).toBe(CHARGED_AT)
    expect(formatReceiptDate(CHARGED_AT)).toContain("2026")
  })

  it("flags the contemporaneous written acknowledgment at $250 and above", () => {
    expect(model({ amountMinor: 24_999 }).requiresCwa).toBe(false)
    expect(model({ amountMinor: 25_000 }).requiresCwa).toBe(true)
    expect(receiptStatements(model({ amountMinor: 24_999 })).cwa).toBeNull()
    expect(receiptStatements(model({ amountMinor: 25_000 })).cwa).toContain("$250 or more")
  })

  it("states the deductible percentage, or says plainly that it is not deductible", () => {
    expect(receiptStatements(model()).deductibility).toContain("100%")
    const nonDeductible = receiptStatements(model({ deductible: false, deductiblePercentage: null }))
    expect(nonDeductible.deductibility).toContain("NOT tax deductible")
    expect(nonDeductible.deductibility).not.toContain("100%")
  })

  it("always carries the no-goods-or-services statement and the agent authorization", () => {
    const statements = receiptStatements(model())
    expect(statements.noGoodsOrServices).toContain("No goods or services")
    expect(statements.agent).toContain("authorized agent")
    expect(statements.agent).toContain("REACH OUT LOS ANGELES INC")
  })

  it("discloses a partial refund so a donor does not deduct money they got back", () => {
    expect(receiptStatements(model()).refunded).toBeNull()
    expect(receiptStatements(model({ refundedTotalMinor: 2000 })).refunded).toContain("$20.00")
  })

  it("formats money in whole cents and masks the EIN into its published form", () => {
    expect(formatMoney(5000)).toBe("$50.00")
    expect(formatMoney(123_456_789)).toBe("$1,234,567.89")
    expect(formatMoney(5)).toBe("$0.05")
    expect(maskEin("954327245")).toBe("95-4327245")
    expect(maskEin("12345")).toBeNull()
    expect(maskEin(null)).toBeNull()
  })
})

describe("receipt PDF", () => {
  it("renders a PDF whose bytes start with the PDF magic", async () => {
    const bytes = await buildDonationReceiptPdf(model())
    expect(bytes.byteLength).toBeGreaterThan(1000)
    expect(Buffer.from(bytes.subarray(0, 5)).toString("utf8")).toBe("%PDF-")
  })
})

interface ReceiptHarness {
  runtime: PaymentsRuntime
  mailer: FakeMailer
  storage: FakeStorage
  donations: ReturnType<typeof makeMemoryDonationRepository>
  sent: OutboundEmail[]
}

async function receiptHarness(): Promise<ReceiptHarness> {
  const donations = makeMemoryDonationRepository({ orgNameOf: () => "Reach Out LA" })
  await donations.create({
    id: DONATION_ID,
    reference: "CFD-ABC123",
    donorKey: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
    organizationId: ORG_ID,
    eventId: null,
    userId: null,
    donorEmail: "donor@example.org",
    donorName: "Alex Donor",
    shareIdentityWithOrg: false,
    amountMinor: 5000,
    feeBps: 500,
    feePlatformMinor: 250,
    stripeAccountId: "acct_fake_1",
    sessionExpiresAt: new Date(NOW.getTime() + 1800_000),
    consentTermsVersion: "2026-09-06",
    consentDisclosureVersion: "2026-09-06",
    eligibilitySnapshot: {},
    idempotencyOwner: "donor:test",
    idempotencyKey: "idem-1",
    livemode: false,
    consents: [],
    consentSurface: "web_donate",
    consentScreenRoute: null,
    consentUiTemplateVersion: null,
    now: NOW,
  })
  const row = donations.rows[0]
  if (row !== undefined) {
    row.status = "succeeded"
    row.chargedAt = CHARGED_AT
    row.feeStripeMinor = 175
    row.netMinor = 4575
  }

  const mailer = new FakeMailer()
  const sent: OutboundEmail[] = []
  const originalSend = mailer.sendOutbound.bind(mailer)
  mailer.sendOutbound = (email) => {
    sent.push(email)
    return originalSend(email)
  }
  const storage = new FakeStorage()

  const runtime: PaymentsRuntime = {
    sql: null as unknown as PaymentsRuntime["sql"],
    env: loadPaymentsEnv(
      { NODE_ENV: "test", PAYMENTS_ENABLED: "true", MAIL_FROM_RECEIPTS: "receipts@civfix.org" },
      [],
    ),
    jobs: {
      enqueue: () => Promise.resolve("job"),
      schedule: () => Promise.resolve(),
      work: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      fail: () => Promise.resolve(),
    },
    donations,
    events: makeMemoryStripeEventRepository(),
    orgs: makeMemoryOrgPaymentsRepository({
      orgs: [orgRow()],
      accounts: [accountRow()],
      settings: [settingsRow()],
      eligibility: [eligibilityRow()],
    }),
    payouts: makeMemoryOrgPayoutsRepository(),
    orgPayments: {} as PaymentsRuntime["orgPayments"],
    eligibility: {} as PaymentsRuntime["eligibility"],
    payments: new FakePayments({ now: () => NOW.getTime() }),
    mailer,
    storage,
    now: () => NOW,
  }

  return { runtime, mailer, storage, donations, sent }
}

describe("receipt delivery", () => {
  it("stores the PDF under a dated receipts key and marks the donation sent", async () => {
    const h = await receiptHarness()
    await sendDonationReceipt(h.runtime, DONATION_ID)

    const row = h.donations.rows[0]
    expect(row?.receiptSentAt).not.toBeNull()
    expect(row?.receiptKey).toBe(`receipts/donations/2026/05/${DONATION_ID}.pdf`)
    expect(await h.storage.head(row?.receiptKey as string)).not.toBeNull()
  })

  it("sends from the receipts mailbox with an attachment and the Auto-Submitted header", async () => {
    const h = await receiptHarness()
    await sendDonationReceipt(h.runtime, DONATION_ID)

    const email = h.sent[0]
    expect(email?.from).toBe("receipts@civfix.org")
    expect(email?.to).toBe("donor@example.org")
    expect(email?.attachments).toHaveLength(1)
    expect(email?.attachments?.[0]?.contentType).toBe("application/pdf")
    expect(email?.headers?.["Auto-Submitted"]).toBe("auto-generated")
  })

  it("carries NO List-Unsubscribe header and zero promotional content", async () => {
    const h = await receiptHarness()
    await sendDonationReceipt(h.runtime, DONATION_ID)

    const email = h.sent[0]
    const headerKeys = Object.keys(email?.headers ?? {}).map((key) => key.toLowerCase())
    expect(headerKeys).not.toContain("list-unsubscribe")
    expect(headerKeys).not.toContain("list-unsubscribe-post")
    const body = `${email?.subject ?? ""}\n${email?.text ?? ""}`.toLowerCase()
    for (const promo of ["unsubscribe", "donate again", "newsletter", "follow us", "share this"]) {
      expect(body).not.toContain(promo)
    }
  })

  it("is at-most-once: a second run after a successful send does nothing", async () => {
    const h = await receiptHarness()
    await sendDonationReceipt(h.runtime, DONATION_ID)
    await sendDonationReceipt(h.runtime, DONATION_ID)
    expect(h.sent).toHaveLength(1)
  })

  it("never sends for a donation that is still pending", async () => {
    const h = await receiptHarness()
    const row = h.donations.rows[0]
    if (row !== undefined) row.status = "pending"
    await sendDonationReceipt(h.runtime, DONATION_ID)
    expect(h.sent).toHaveLength(0)
  })
})
