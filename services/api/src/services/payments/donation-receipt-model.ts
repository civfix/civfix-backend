import type { DonationStatusValue } from "../../db/schema/types-payments.js"

export const RECEIPT_TIME_ZONE = "America/Los_Angeles"

export const CWA_THRESHOLD_MINOR = 25000

export const RECEIPT_DOCUMENT_VERSION = "2026-09-06"

export interface ReceiptDonee {
  legalName: string
  ein: string | null
  addressLine1: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  evidenceSource: string | null
  evidenceRevisionDate: string | null
}

export interface ReceiptDonor {
  name: string | null
  email: string
}

export interface ReceiptFees {
  grossMinor: number
  platformFeeMinor: number
  processorFeeMinor: number | null
  netMinor: number | null
  platformFeeBps: number
}

export interface DonationReceiptModel {
  documentVersion: string
  donationId: string
  reference: string
  status: DonationStatusValue
  donee: ReceiptDonee
  donor: ReceiptDonor
  amountMinor: number
  currency: "USD"
  contributionDate: Date
  fees: ReceiptFees
  deductible: boolean
  deductiblePercentage: number | null
  requiresCwa: boolean
  refundedTotalMinor: number
  orgContactEmail: string | null
  registrationNumber: string | null
  platformLegalName: string
}

export interface BuildReceiptModelInput {
  donationId: string
  reference: string
  status: DonationStatusValue
  amountMinor: number
  refundedTotalMinor: number
  chargedAt: Date
  donorEmail: string
  donorName: string | null
  feeBps: number
  feePlatformMinor: number
  feeStripeMinor: number | null
  netMinor: number | null
  deductible: boolean
  deductiblePercentage: number | null
  donee: ReceiptDonee
  orgContactEmail: string | null
  registrationNumber: string | null
  platformLegalName: string
}

export function buildDonationReceiptModel(input: BuildReceiptModelInput): DonationReceiptModel {
  return {
    documentVersion: RECEIPT_DOCUMENT_VERSION,
    donationId: input.donationId,
    reference: input.reference,
    status: input.status,
    donee: input.donee,
    donor: { name: input.donorName, email: input.donorEmail },
    amountMinor: input.amountMinor,
    currency: "USD",
    contributionDate: input.chargedAt,
    fees: {
      grossMinor: input.amountMinor,
      platformFeeMinor: input.feePlatformMinor,
      processorFeeMinor: input.feeStripeMinor,
      netMinor: input.netMinor,
      platformFeeBps: input.feeBps,
    },
    deductible: input.deductible,
    deductiblePercentage: input.deductible ? (input.deductiblePercentage ?? 100) : null,
    requiresCwa: input.amountMinor >= CWA_THRESHOLD_MINOR,
    refundedTotalMinor: input.refundedTotalMinor,
    orgContactEmail: input.orgContactEmail,
    registrationNumber: input.registrationNumber,
    platformLegalName: input.platformLegalName,
  }
}

export function formatMoney(amountMinor: number): string {
  const sign = amountMinor < 0 ? "-" : ""
  const absolute = Math.abs(amountMinor)
  return `${sign}$${Math.floor(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`
}

export function formatReceiptDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: RECEIPT_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date)
}

export function maskEin(ein: string | null): string | null {
  if (ein === null) return null
  const digits = ein.replace(/\D/g, "")
  if (digits.length !== 9) return null
  return `${digits.slice(0, 2)}-${digits.slice(2)}`
}

export function receiptStatements(model: DonationReceiptModel): {
  noGoodsOrServices: string
  deductibility: string
  agent: string
  cwa: string | null
  refunded: string | null
} {
  return {
    noGoodsOrServices:
      "No goods or services were provided by the organization in exchange for this contribution.",
    deductibility: model.deductible
      ? `This contribution is tax deductible to the extent allowed by law. ${model.deductiblePercentage ?? 100}% of the amount shown is deductible. civfix does not provide tax advice.`
      : "This contribution is NOT tax deductible. civfix does not provide tax advice.",
    agent: `This receipt was issued by ${model.platformLegalName} as the authorized agent of ${model.donee.legalName}.`,
    cwa: model.requiresCwa
      ? "Keep this acknowledgment. For a contribution of $250 or more the IRS requires a contemporaneous written acknowledgment from the donee organization in order to claim a deduction."
      : null,
    refunded:
      model.refundedTotalMinor > 0
        ? `${formatMoney(model.refundedTotalMinor)} of this contribution has been refunded. Only the net amount may be deductible.`
        : null,
  }
}
