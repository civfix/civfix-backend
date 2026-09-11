import type { PayoutStatusValue } from "../../db/schema/types-payments.js"

export interface OrgPayoutRecord {
  id: string
  organizationId: string
  stripeAccountId: string
  stripePayoutId: string | null
  amountMinor: number
  currency: "USD"
  status: PayoutStatusValue
  arrivalDate: Date | null
  failureMessage: string | null
  requestedBy: string | null
  idempotencyKey: string | null
  createdAt: Date
  updatedAt: Date
}

export interface InsertPendingPayoutInput {
  organizationId: string
  stripeAccountId: string
  amountMinor: number
  requestedBy: string
  idempotencyKey: string
  now: Date
}

export interface InsertPendingPayoutResult {
  record: OrgPayoutRecord
  replayed: boolean
}

export interface MarkPayoutSubmittedInput {
  id: string
  organizationId: string
  stripePayoutId: string
  status: PayoutStatusValue
  arrivalDate: Date | null
  failureMessage: string | null
  now: Date
}

export interface MarkPayoutFailedInput {
  id: string
  failureMessage: string
  now: Date
}

export interface UpsertProviderPayoutInput {
  organizationId: string
  stripeAccountId: string
  stripePayoutId: string
  amountMinor: number
  status: PayoutStatusValue
  arrivalDate: Date | null
  failureMessage: string | null
  createdAt: Date
  now: Date
}

export interface ListOrgPayoutsQuery {
  organizationId: string
  cursor?: string
  limit: number
}

export interface OrgPayoutsRepository {
  insertPending(input: InsertPendingPayoutInput): Promise<InsertPendingPayoutResult>
  findUnconfirmed(organizationId: string): Promise<OrgPayoutRecord | null>
  markSubmitted(input: MarkPayoutSubmittedInput): Promise<OrgPayoutRecord | null>
  markFailed(input: MarkPayoutFailedInput): Promise<OrgPayoutRecord | null>
  upsertFromProvider(input: UpsertProviderPayoutInput): Promise<void>
  listForOrg(query: ListOrgPayoutsQuery): Promise<OrgPayoutRecord[]>
}
