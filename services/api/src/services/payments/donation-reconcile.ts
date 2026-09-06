import type {
  ApplicationFeeRecord,
  BalanceTransactionRecord,
  Payments,
} from "@civfix/shared/interfaces"
import type { Sql } from "../../db/client.js"
import type { DonationRecord, DonationRepository } from "./donation-repository.drizzle.js"
import type { OrgPaymentsRepository } from "./org-payments-repository.drizzle.js"

export const RECONCILE_ORG_PAGE = 50

export const RECONCILE_DONATION_PAGE = 500

export const RECONCILE_MAX_DONATION_PAGES = 40

export const RECONCILE_STRIPE_PAGE = 100

export const RECONCILE_MAX_STRIPE_PAGES = 200

export const RECONCILE_MAX_STRIPE_ITEMS = 20_000

export const RECONCILE_MAX_LOOKBACK_MS = 90 * 86400_000

export const RECONCILE_SETTLE_LAG_MS = 3600_000

export const RECONCILE_MAX_APPLICATION_FEE_PAGES = 200

export interface ReconciliationDivergence {
  donationId: string
  reference: string
  kind:
    | "missing_charge_id"
    | "missing_application_fee"
    | "fee_mismatch"
    | "amount_mismatch"
    | "unsettled_processor_fee"
    | "charge_not_at_stripe"
    | "processor_fee_mismatch"
    | "platform_fee_mismatch"
    | "refunded_fee_mismatch"
  expectedMinor: number | null
  observedMinor: number | null
}

export interface ReconciliationRunResult {
  organizationId: string
  donationsChecked: number
  balanceTransactionsChecked: number
  applicationFeesChecked: number
  divergences: ReconciliationDivergence[]
  grossMinor: number
  platformFeeMinor: number
  windowStart: Date
  windowEnd: Date
  comparedThrough: Date
  stripeListingComplete: boolean
}

export interface ReconcileDeps {
  sql: Sql
  donations: DonationRepository
  orgs: OrgPaymentsRepository
  payments: Payments
  now?: () => Date
  logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
}

export function findDivergences(
  donations: readonly {
    id: string
    reference: string
    amountMinor: number
    feePlatformMinor: number
    feeRefundedMinor: number
    feeStripeMinor: number | null
    netMinor: number | null
    stripeChargeId: string | null
    stripeApplicationFeeId: string | null
  }[],
): ReconciliationDivergence[] {
  const out: ReconciliationDivergence[] = []
  for (const donation of donations) {
    if (donation.stripeChargeId === null) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "missing_charge_id",
        expectedMinor: donation.amountMinor,
        observedMinor: null,
      })
      continue
    }
    if (donation.feePlatformMinor > 0 && donation.stripeApplicationFeeId === null) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "missing_application_fee",
        expectedMinor: donation.feePlatformMinor,
        observedMinor: null,
      })
    }
    if (donation.feeStripeMinor === null) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "unsettled_processor_fee",
        expectedMinor: null,
        observedMinor: null,
      })
      continue
    }
    if (donation.feeRefundedMinor > donation.feePlatformMinor) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "fee_mismatch",
        expectedMinor: donation.feePlatformMinor,
        observedMinor: donation.feeRefundedMinor,
      })
    }
    const expectedNet = donation.amountMinor - donation.feePlatformMinor - donation.feeStripeMinor
    if (donation.netMinor !== null && donation.netMinor !== expectedNet) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "amount_mismatch",
        expectedMinor: expectedNet,
        observedMinor: donation.netMinor,
      })
    }
  }
  return out
}

export function compareAgainstStripe(input: {
  donations: readonly DonationRecord[]
  transactions: readonly BalanceTransactionRecord[]
  applicationFees: ReadonlyMap<string, ApplicationFeeRecord>
  stripeListingComplete?: boolean
}): {
  divergences: ReconciliationDivergence[]
  applicationFeesChecked: number
  applicationFeesMissing: number
  chargesNotCompared: number
} {
  const byCharge = new Map<string, DonationRecord>()
  for (const donation of input.donations) {
    if (donation.stripeChargeId !== null) byCharge.set(donation.stripeChargeId, donation)
  }
  const seenCharges = new Set<string>()
  const out: ReconciliationDivergence[] = []

  for (const transaction of input.transactions) {
    if (transaction.sourceId === null) continue
    const donation = byCharge.get(transaction.sourceId)
    if (donation === undefined) continue
    seenCharges.add(transaction.sourceId)

    if (transaction.amountMinor !== donation.amountMinor) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "amount_mismatch",
        expectedMinor: donation.amountMinor,
        observedMinor: transaction.amountMinor,
      })
    }
    if (donation.feeStripeMinor !== null && transaction.stripeFeeMinor !== donation.feeStripeMinor) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "processor_fee_mismatch",
        expectedMinor: donation.feeStripeMinor,
        observedMinor: transaction.stripeFeeMinor,
      })
    }
    if (transaction.applicationFeeMinor !== donation.feePlatformMinor) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "platform_fee_mismatch",
        expectedMinor: donation.feePlatformMinor,
        observedMinor: transaction.applicationFeeMinor,
      })
    }
  }

  const listingComplete = input.stripeListingComplete ?? true
  let chargesNotCompared = 0
  for (const donation of input.donations) {
    if (donation.stripeChargeId === null || seenCharges.has(donation.stripeChargeId)) continue
    if (!listingComplete) {
      chargesNotCompared += 1
      continue
    }
    out.push({
      donationId: donation.id,
      reference: donation.reference,
      kind: "charge_not_at_stripe",
      expectedMinor: donation.amountMinor,
      observedMinor: null,
    })
  }

  let applicationFeesChecked = 0
  let applicationFeesMissing = 0
  for (const donation of input.donations) {
    if (donation.stripeApplicationFeeId === null) continue
    const fee = input.applicationFees.get(donation.stripeApplicationFeeId)
    if (fee === undefined) {
      applicationFeesMissing += 1
      continue
    }
    applicationFeesChecked += 1
    if (fee.amountMinor !== donation.feePlatformMinor) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "platform_fee_mismatch",
        expectedMinor: donation.feePlatformMinor,
        observedMinor: fee.amountMinor,
      })
    }
    if (fee.amountRefundedMinor !== donation.feeRefundedMinor) {
      out.push({
        donationId: donation.id,
        reference: donation.reference,
        kind: "refunded_fee_mismatch",
        expectedMinor: donation.feeRefundedMinor,
        observedMinor: fee.amountRefundedMinor,
      })
    }
  }

  return { divergences: out, applicationFeesChecked, applicationFeesMissing, chargesNotCompared }
}

export interface CollectedBalanceTransactions {
  items: BalanceTransactionRecord[]
  complete: boolean
}

export async function collectBalanceTransactions(
  payments: Payments,
  accountId: string,
  sinceSec: number | null,
): Promise<CollectedBalanceTransactions> {
  const items: BalanceTransactionRecord[] = []
  let cursor: string | null = null
  for (let page = 0; page < RECONCILE_MAX_STRIPE_PAGES; page += 1) {
    const result = await payments.listBalanceTransactions(accountId, {
      since: sinceSec,
      cursor,
      limit: RECONCILE_STRIPE_PAGE,
    })
    items.push(...result.items)
    cursor = result.nextCursor
    if (cursor === null) return { items, complete: true }
    if (items.length >= RECONCILE_MAX_STRIPE_ITEMS) break
  }
  return { items, complete: false }
}

export async function collectApplicationFees(
  payments: Payments,
  sinceSec: number | null,
): Promise<{ fees: Map<string, ApplicationFeeRecord>; complete: boolean }> {
  const byId = new Map<string, ApplicationFeeRecord>()
  let cursor: string | null = null
  for (let page = 0; page < RECONCILE_MAX_APPLICATION_FEE_PAGES; page += 1) {
    const result = await payments.listApplicationFees({
      since: sinceSec,
      cursor,
      limit: RECONCILE_STRIPE_PAGE,
    })
    for (const fee of result.items) byId.set(fee.id, fee)
    cursor = result.nextCursor
    if (cursor === null) return { fees: byId, complete: true }
  }
  return { fees: byId, complete: false }
}

export async function loadLocalDonations(
  deps: ReconcileDeps,
  input: { organizationId: string; since: Date | null; until: Date },
): Promise<{ donations: DonationRecord[]; exhausted: boolean }> {
  const donations: DonationRecord[] = []
  let after: { chargedAt: Date; id: string } | null = null
  for (let page = 0; page < RECONCILE_MAX_DONATION_PAGES; page += 1) {
    const rows = await deps.donations.succeededSince({
      organizationId: input.organizationId,
      since: input.since,
      until: input.until,
      limit: RECONCILE_DONATION_PAGE,
      after,
    })
    donations.push(...rows)
    if (rows.length < RECONCILE_DONATION_PAGE) return { donations, exhausted: true }
    const last = rows[rows.length - 1]
    if (last === undefined || last.chargedAt === null) return { donations, exhausted: true }
    after = { chargedAt: last.chargedAt, id: last.id }
  }
  return { donations, exhausted: false }
}

export async function reconcileOrganization(
  deps: ReconcileDeps,
  input: {
    organizationId: string
    stripeAccountId: string
    since: Date | null
    until: Date
    applicationFees: ReadonlyMap<string, ApplicationFeeRecord>
  },
): Promise<ReconciliationRunResult> {
  const local = await loadLocalDonations(deps, {
    organizationId: input.organizationId,
    since: input.since,
    until: input.until,
  })
  const donations = local.donations

  const sinceSec = input.since === null ? null : Math.floor(input.since.getTime() / 1000)
  const collected = await collectBalanceTransactions(deps.payments, input.stripeAccountId, sinceSec)
  const lastLocal = donations[donations.length - 1]?.chargedAt ?? null
  const boundaryMs = local.exhausted ? null : (lastLocal?.getTime() ?? 0)
  const transactions =
    boundaryMs === null
      ? collected.items
      : collected.items.filter((transaction) => transaction.createdSec * 1000 <= boundaryMs)
  const stripeSide = compareAgainstStripe({
    donations,
    transactions,
    applicationFees: input.applicationFees,
    stripeListingComplete: collected.complete,
  })

  if (!collected.complete) {
    deps.logger?.warn(
      {
        organizationId: input.organizationId,
        balanceTransactionsLoaded: collected.items.length,
        chargesNotCompared: stripeSide.chargesNotCompared,
      },
      "payments reconciliation: balance transaction listing hit its page bound, charge presence was not compared and the mark was not advanced",
    )
  }

  if (stripeSide.applicationFeesMissing > 0) {
    deps.logger?.warn(
      {
        organizationId: input.organizationId,
        applicationFeesMissing: stripeSide.applicationFeesMissing,
      },
      "payments reconciliation: application fees were not in the fetched window, their refund totals were not compared",
    )
  }

  const divergences = [...findDivergences(donations), ...stripeSide.divergences]
  const grossMinor = donations.reduce((sum, donation) => sum + donation.amountMinor, 0)
  const platformFeeMinor = donations.reduce(
    (sum, donation) => sum + donation.feePlatformMinor - donation.feeRefundedMinor,
    0,
  )

  const lastComparedSec = transactions.reduce(
    (latest, transaction) => Math.max(latest, transaction.createdSec),
    0,
  )
  const comparedThrough = !collected.complete
    ? (input.since ?? new Date(0))
    : local.exhausted
      ? input.until
      : new Date(
          Math.min(
            input.until.getTime(),
            Math.max(
              lastComparedSec * 1000,
              lastLocal?.getTime() ?? 0,
              input.since?.getTime() ?? 0,
            ),
          ),
        )

  return {
    organizationId: input.organizationId,
    donationsChecked: donations.length,
    balanceTransactionsChecked: transactions.length,
    applicationFeesChecked: stripeSide.applicationFeesChecked,
    divergences,
    grossMinor,
    platformFeeMinor,
    windowStart: input.since ?? new Date(0),
    windowEnd: input.until,
    comparedThrough,
    stripeListingComplete: collected.complete,
  }
}

export async function recordReconciliationRun(
  sql: Sql,
  result: ReconciliationRunResult,
  status: "ok" | "diverged" | "failed",
  error: string | null,
): Promise<void> {
  await sql`
    INSERT INTO donation_reconciliation_runs (
      organization_id, window_start, window_end, donations_checked, balance_transactions,
      application_fees, divergences, divergence_detail, gross_minor, platform_fee_minor, status, error
    ) VALUES (
      ${result.organizationId}, ${result.windowStart}, ${result.windowEnd},
      ${result.donationsChecked}, ${result.balanceTransactionsChecked},
      ${result.applicationFeesChecked}, ${result.divergences.length},
      ${sql.json(result.divergences as unknown as Parameters<typeof sql.json>[0])},
      ${result.grossMinor}, ${result.platformFeeMinor}, ${status}, ${error}
    )`
}

export async function advanceReconciledThrough(
  sql: Sql,
  organizationId: string,
  through: Date,
): Promise<void> {
  await sql`
    UPDATE org_stripe_accounts
       SET reconciled_through = GREATEST(COALESCE(reconciled_through, to_timestamp(0)), ${through}),
           updated_at = now()
     WHERE organization_id = ${organizationId}`
}

export async function runPaymentsReconciliation(deps: ReconcileDeps): Promise<{
  organizations: number
  divergences: number
}> {
  const now = deps.now ?? (() => new Date())
  const until = new Date(now().getTime() - RECONCILE_SETTLE_LAG_MS)
  const oldest = new Date(until.getTime() - RECONCILE_MAX_LOOKBACK_MS)
  const collectedFees = await collectApplicationFees(
    deps.payments,
    Math.floor(oldest.getTime() / 1000),
  )
  const applicationFees = collectedFees.fees
  if (!collectedFees.complete) {
    deps.logger?.warn(
      { applicationFeesLoaded: applicationFees.size },
      "payments reconciliation: application fee listing hit its page bound, older fees are not compared this run",
    )
  }
  let after: string | null = null
  let organizations = 0
  let divergences = 0

  for (;;) {
    const page = await deps.orgs.listOnboardedAccounts(RECONCILE_ORG_PAGE, after)
    if (page.length === 0) break

    for (const account of page) {
      organizations++
      const since =
        account.reconciledThrough === null
          ? oldest
          : new Date(Math.max(account.reconciledThrough.getTime(), oldest.getTime()))
      try {
        const result = await reconcileOrganization(deps, {
          organizationId: account.organizationId,
          stripeAccountId: account.stripeAccountId,
          since,
          until,
          applicationFees,
        })
        divergences += result.divergences.length
        await recordReconciliationRun(
          deps.sql,
          result,
          result.divergences.length > 0 ? "diverged" : "ok",
          null,
        )
        if (result.divergences.length === 0 && result.stripeListingComplete) {
          await advanceReconciledThrough(
            deps.sql,
            account.organizationId,
            result.comparedThrough,
          )
        } else {
          deps.logger?.error(
            {
              organizationId: account.organizationId,
              divergences: result.divergences.length,
              kinds: [...new Set(result.divergences.map((entry) => entry.kind))],
            },
            "payments reconciliation divergence",
          )
        }
      } catch (err) {
        deps.logger?.error(
          { err, organizationId: account.organizationId },
          "payments reconciliation failed for organization",
        )
        await recordReconciliationRun(
          deps.sql,
          {
            organizationId: account.organizationId,
            donationsChecked: 0,
            balanceTransactionsChecked: 0,
            applicationFeesChecked: 0,
            divergences: [],
            grossMinor: 0,
            platformFeeMinor: 0,
            windowStart: since,
            windowEnd: until,
            comparedThrough: since,
            stripeListingComplete: false,
          },
          "failed",
          err instanceof Error ? err.message.slice(0, 500) : "unknown error",
        )
      }
    }

    const last = page[page.length - 1]
    if (last === undefined || page.length < RECONCILE_ORG_PAGE) break
    after = last.organizationId
  }

  return { organizations, divergences }
}
