import type {
  DonationDisputeStateValue,
  DonationStatusValue,
} from "../../db/schema/types-payments.js"
import type {
  AdminDonationOrgTotalsRow,
  CreateDonationInput,
  CreateDonationOutcome,
  DonationListRow,
  DonationRepository,
  DonationSummary,
  FulfillDonationInput,
  RecordDisputeInput,
  RecordRefundInput,
  StripeEventRepository,
} from "./donation-repository.drizzle.js"
import { decodeDonationCursor } from "./donation-repository.drizzle.js"

const EMPTY_SUMMARY: DonationSummary = {
  donationCount: 0,
  grossMinor: 0,
  platformFeeMinor: 0,
  processorFeeMinor: 0,
  netMinor: 0,
  refundedMinor: 0,
  disputedCount: 0,
}

interface MemoryRefund {
  refundId: string
  donationId: string
  amountMinor: number
  status: string
  appFeeRefundState: string
}

type MemoryDonationRow = DonationListRow & { idempotencyOwnerKey?: string }

export interface MemoryDonationSeed {
  donations?: MemoryDonationRow[]
  orgNameOf?: (organizationId: string) => string
}

export function makeMemoryDonationRepository(
  seed: MemoryDonationSeed = {},
): DonationRepository & { rows: MemoryDonationRow[]; refunds: MemoryRefund[] } {
  const rows: MemoryDonationRow[] = seed.donations ?? []
  const refunds: MemoryRefund[] = []
  const disputes: RecordDisputeInput[] = []
  const orgNameOf = seed.orgNameOf ?? (() => "Test Organization")

  function find(id: string): MemoryDonationRow | undefined {
    return rows.find((row) => row.id === id)
  }

  function sortDesc(list: MemoryDonationRow[]): MemoryDonationRow[] {
    return [...list].sort((a, b) => {
      const at = b.createdAt.getTime() - a.createdAt.getTime()
      return at !== 0 ? at : b.id.localeCompare(a.id)
    })
  }

  function page(list: MemoryDonationRow[], cursor: string | undefined, limit: number): MemoryDonationRow[] {
    const decoded = decodeDonationCursor(cursor)
    const sorted = sortDesc(list)
    const start =
      decoded === null ? 0 : sorted.findIndex((row) => row.id === decoded.id) + 1
    return sorted.slice(start, start + limit)
  }

  return {
    rows,
    refunds,

    create(input: CreateDonationInput): Promise<CreateDonationOutcome> {
      const existing = rows.find(
        (row) =>
          row.idempotencyOwnerKey === `${input.idempotencyOwner}|${input.idempotencyKey}`,
      )
      if (existing !== undefined) return Promise.resolve({ kind: "replayed", donation: existing })
      const record: MemoryDonationRow = {
        id: input.id,
        reference: input.reference,
        donorKey: input.donorKey,
        organizationId: input.organizationId,
        eventId: input.eventId,
        userId: input.userId,
        donorEmail: input.donorEmail,
        donorName: input.donorName,
        shareIdentityWithOrg: input.shareIdentityWithOrg,
        amountMinor: input.amountMinor,
        currency: "USD",
        feeBps: input.feeBps,
        feePlatformMinor: input.feePlatformMinor,
        feeStripeMinor: null,
        netMinor: null,
        status: "pending",
        failureReason: null,
        disputeState: "none",
        refundedTotalMinor: 0,
        feeRefundedMinor: 0,
        stripeAccountId: input.stripeAccountId,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        stripeChargeId: null,
        stripeApplicationFeeId: null,
        cardBrand: null,
        cardLast4: null,
        livemode: input.livemode,
        chargedAt: null,
        sessionExpiresAt: input.sessionExpiresAt,
        receiptSentAt: null,
        receiptKey: null,
        receiptDocumentVersion: null,
        consentTermsVersion: input.consentTermsVersion,
        consentDisclosureVersion: input.consentDisclosureVersion,
        createdAt: input.now,
        lastPolledAt: null,
        orgName: orgNameOf(input.organizationId),
        orgSlug: "org",
        eventTitle: null,
        idempotencyOwnerKey: `${input.idempotencyOwner}|${input.idempotencyKey}`,
      }
      rows.push(record)
      return Promise.resolve({ kind: "created", donation: record })
    },

    findByIdempotency(owner, key) {
      return Promise.resolve(
        rows.find((row) => row.idempotencyOwnerKey === `${owner}|${key}`) ?? null,
      )
    },

    findById(id) {
      return Promise.resolve(find(id) ?? null)
    },

    findByIdForUser(id, userId) {
      const row = find(id)
      return Promise.resolve(row !== undefined && row.userId === userId ? row : null)
    },

    findBySessionId(sessionId) {
      return Promise.resolve(rows.find((row) => row.stripeCheckoutSessionId === sessionId) ?? null)
    },

    findByPaymentIntentId(paymentIntentId) {
      return Promise.resolve(rows.find((row) => row.stripePaymentIntentId === paymentIntentId) ?? null)
    },

    findByChargeId(chargeId) {
      return Promise.resolve(rows.find((row) => row.stripeChargeId === chargeId) ?? null)
    },

    attachCheckoutSession({ donationId, sessionId, paymentIntentId, expiresAt }) {
      const row = find(donationId)
      if (row !== undefined && row.stripeCheckoutSessionId === null) {
        row.stripeCheckoutSessionId = sessionId
        row.stripePaymentIntentId = paymentIntentId
        row.sessionExpiresAt = expiresAt
      }
      return Promise.resolve()
    },

    fulfill(input: FulfillDonationInput) {
      const row = find(input.donationId)
      if (row === undefined || row.status !== "pending") return Promise.resolve(false)
      row.status = "succeeded"
      row.stripeChargeId = input.chargeId ?? row.stripeChargeId
      row.stripeApplicationFeeId = input.applicationFeeId ?? row.stripeApplicationFeeId
      row.feeStripeMinor = input.stripeFeeMinor ?? row.feeStripeMinor
      row.netMinor = input.netMinor ?? row.netMinor
      row.cardBrand = input.cardBrand ?? row.cardBrand
      row.cardLast4 = input.cardLast4 ?? row.cardLast4
      row.chargedAt = row.chargedAt ?? input.chargedAt
      return Promise.resolve(true)
    },

    markFailed(donationId, reason) {
      const row = find(donationId)
      if (row === undefined || row.status !== "pending") return Promise.resolve(false)
      row.status = "failed"
      row.failureReason = reason
      return Promise.resolve(true)
    },

    markExpired(donationId) {
      const row = find(donationId)
      if (row === undefined || row.status !== "pending") return Promise.resolve(false)
      row.status = "failed"
      row.failureReason = "session_expired"
      return Promise.resolve(true)
    },

    expirePending(now, limit) {
      return Promise.resolve(
        rows
          .filter(
            (row) =>
              row.status === "pending" &&
              row.sessionExpiresAt !== null &&
              row.sessionExpiresAt < now,
          )
          .slice(0, limit)
          .map((row) => row.id),
      )
    },

    touchPolled(donationId, now) {
      const row = find(donationId)
      if (row !== undefined) row.lastPolledAt = now
      return Promise.resolve()
    },

    recordRefund(input: RecordRefundInput) {
      const existing = refunds.find((refund) => refund.refundId === input.refundId)
      if (existing !== undefined) {
        existing.status = input.status
        return Promise.resolve(false)
      }
      refunds.push({
        refundId: input.refundId,
        donationId: input.donationId,
        amountMinor: input.amountMinor,
        status: input.status,
        appFeeRefundState: "pending",
      })
      return Promise.resolve(true)
    },

    refundedTotalOf(donationId) {
      return Promise.resolve(
        refunds
          .filter(
            (refund) =>
              refund.donationId === donationId &&
              refund.status !== "failed" &&
              refund.status !== "canceled",
          )
          .reduce((sum, refund) => sum + refund.amountMinor, 0),
      )
    },

    applyRefundTotals({ donationId, refundedTotalMinor, status }) {
      const row = find(donationId)
      if (row !== undefined) {
        row.refundedTotalMinor = refundedTotalMinor
        row.status = status as DonationStatusValue
      }
      return Promise.resolve()
    },

    pendingAppFeeRefunds(donationId) {
      return Promise.resolve(
        refunds
          .filter(
            (refund) =>
              refund.donationId === donationId &&
              refund.status !== "failed" &&
              refund.status !== "canceled" &&
              (refund.appFeeRefundState === "pending" || refund.appFeeRefundState === "failed"),
          )
          .map((refund) => ({
            refundId: refund.refundId,
            amountMinor: refund.amountMinor,
            appFeeRefundState: refund.appFeeRefundState,
          })),
      )
    },

    flagAppFeeRefundsAfterFailure(donationId) {
      const flagged = refunds.filter(
        (refund) =>
          refund.donationId === donationId &&
          (refund.status === "failed" || refund.status === "canceled") &&
          refund.appFeeRefundState === "done",
      )
      for (const refund of flagged) refund.appFeeRefundState = "failed_after"
      return Promise.resolve(flagged.map((refund) => refund.refundId))
    },

    recordAppFeeRefund({ refundId, donationId, amountMinor, state }) {
      const refund = refunds.find((entry) => entry.refundId === refundId)
      if (refund !== undefined) refund.appFeeRefundState = state
      const row = find(donationId)
      if (row !== undefined && state === "done") {
        row.feeRefundedMinor = Math.min(row.feePlatformMinor, row.feeRefundedMinor + amountMinor)
      }
      return Promise.resolve()
    },

    recordDispute(input: RecordDisputeInput) {
      disputes.push(input)
      return Promise.resolve()
    },

    setDisputeState(donationId, state: DonationDisputeStateValue) {
      const row = find(donationId)
      if (row !== undefined) row.disputeState = state
      return Promise.resolve()
    },

    claimReceipt(donationId, now, reclaimAfterMs) {
      void reclaimAfterMs
      const row = find(donationId)
      if (row === undefined || row.receiptSentAt !== null) return Promise.resolve(null)
      if (row.status === "pending" || row.status === "failed") return Promise.resolve(null)
      row.lastPolledAt = row.lastPolledAt ?? now
      return Promise.resolve(row)
    },

    markReceiptSent({ donationId, receiptKey, documentVersion, now }) {
      const row = find(donationId)
      if (row !== undefined) {
        row.receiptSentAt = now
        row.receiptKey = receiptKey
        row.receiptDocumentVersion = documentVersion
      }
      return Promise.resolve()
    },

    listForOrg(query) {
      const filtered = rows.filter(
        (row) =>
          row.organizationId === query.organizationId &&
          row.status !== "pending" &&
          (query.status === undefined || row.status === query.status),
      )
      return Promise.resolve(page(filtered, query.cursor, query.limit))
    },

    summaryForOrg({ organizationId }) {
      const settled = rows.filter(
        (row) => row.organizationId === organizationId && row.status !== "pending" && row.status !== "failed",
      )
      if (settled.length === 0) return Promise.resolve({ ...EMPTY_SUMMARY })
      return Promise.resolve({
        donationCount: settled.length,
        grossMinor: settled.reduce((sum, row) => sum + row.amountMinor, 0),
        platformFeeMinor: settled.reduce(
          (sum, row) => sum + row.feePlatformMinor - row.feeRefundedMinor,
          0,
        ),
        processorFeeMinor: settled.reduce((sum, row) => sum + (row.feeStripeMinor ?? 0), 0),
        netMinor: settled.reduce(
          (sum, row) =>
            sum + row.amountMinor - row.feePlatformMinor - (row.feeStripeMinor ?? 0) - row.refundedTotalMinor,
          0,
        ),
        refundedMinor: settled.reduce((sum, row) => sum + row.refundedTotalMinor, 0),
        disputedCount: settled.filter((row) => row.disputeState !== "none").length,
      })
    },

    listForUser({ userId, cursor, limit }) {
      const filtered = rows.filter((row) => row.userId === userId && row.status !== "pending")
      return Promise.resolve(page(filtered, cursor, limit))
    },

    listForAdmin(query) {
      const filtered = rows.filter(
        (row) =>
          row.livemode === query.livemode &&
          (query.organizationId === undefined || row.organizationId === query.organizationId) &&
          (query.status === undefined || row.status === query.status),
      )
      return Promise.resolve(page(filtered, query.cursor, query.limit))
    },

    adminTotals(query) {
      const settled = rows.filter(
        (row) =>
          row.livemode === query.livemode && row.status !== "pending" && row.status !== "failed",
      )
      return Promise.resolve({
        grossMinor: settled.reduce((sum, row) => sum + row.amountMinor, 0),
        platformFeeMinor: settled.reduce(
          (sum, row) => sum + row.feePlatformMinor - row.feeRefundedMinor,
          0,
        ),
        refundedMinor: settled.reduce((sum, row) => sum + row.refundedTotalMinor, 0),
        count: settled.length,
      })
    },

    adminTotalsByOrg(query) {
      const settled = rows.filter(
        (row) =>
          row.livemode === query.livemode &&
          row.status !== "pending" &&
          row.status !== "failed" &&
          row.chargedAt !== null &&
          row.chargedAt >= query.from &&
          row.chargedAt <= query.to &&
          (query.status === undefined || row.status === query.status),
      )
      const byOrg = new Map<string, AdminDonationOrgTotalsRow>()
      for (const row of settled) {
        const existing = byOrg.get(row.organizationId) ?? {
          organizationId: row.organizationId,
          orgName: orgNameOf(row.organizationId),
          orgSlug: row.organizationId,
          count: 0,
          grossMinor: 0,
          platformFeeMinor: 0,
          refundedMinor: 0,
          firstChargedAt: null,
          lastChargedAt: null,
        }
        existing.count += 1
        existing.grossMinor += row.amountMinor
        existing.platformFeeMinor += row.feePlatformMinor - row.feeRefundedMinor
        existing.refundedMinor += row.refundedTotalMinor
        if (row.chargedAt !== null) {
          if (existing.firstChargedAt === null || row.chargedAt < existing.firstChargedAt) {
            existing.firstChargedAt = row.chargedAt
          }
          if (existing.lastChargedAt === null || row.chargedAt > existing.lastChargedAt) {
            existing.lastChargedAt = row.chargedAt
          }
        }
        byOrg.set(row.organizationId, existing)
      }
      return Promise.resolve(
        [...byOrg.values()].sort((a, b) => b.grossMinor - a.grossMinor).slice(0, query.limit),
      )
    },

    lifetimeTotals(organizationId) {
      const settled = rows.filter(
        (row) => row.organizationId === organizationId && row.status !== "pending" && row.status !== "failed",
      )
      return Promise.resolve({
        grossMinor: settled.reduce((sum, row) => sum + row.amountMinor, 0),
        count: settled.length,
      })
    },

    succeededSince({ organizationId, since, until, limit, after }) {
      const eligible = rows
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            row.status !== "pending" &&
            row.status !== "failed" &&
            row.chargedAt !== null,
        )
        .filter((row) => {
          const at = (row.chargedAt as Date).getTime()
          return (since === null || at > since.getTime()) && at <= until.getTime()
        })
        .sort((a, b) => {
          const delta = (a.chargedAt as Date).getTime() - (b.chargedAt as Date).getTime()
          return delta !== 0 ? delta : a.id.localeCompare(b.id)
        })
      const anchor = after ?? null
      const page = (
        anchor === null
          ? eligible
          : eligible.filter((row) => {
              const at = (row.chargedAt as Date).getTime()
              const anchorAt = anchor.chargedAt.getTime()
              return at > anchorAt || (at === anchorAt && row.id.localeCompare(anchor.id) > 0)
            })
      ).slice(0, limit)
      return Promise.resolve(page)
    },

    unlinkUser(userId, now) {
      let count = 0
      for (const row of rows) {
        if (row.userId === userId) {
          row.userId = null
          void now
          count++
        }
      }
      return Promise.resolve(count)
    },

    sweepContactRetention(now, limit) {
      let count = 0
      for (const row of rows) {
        if (count >= limit) break
        if (row.donorEmail === null && row.donorName === null) continue
        if (row.chargedAt === null) continue
        void now
        row.donorEmail = null
        row.donorName = null
        count++
      }
      return Promise.resolve(count)
    },
  }
}

export function makeMemoryStripeEventRepository(): StripeEventRepository & {
  rows: Map<string, { processedAt: Date | null; error: string | null }>
} {
  const stored = new Map<
    string,
    {
      id: string
      scope: "connect" | "platform"
      type: string
      accountId: string | null
      livemode: boolean
      payload: Record<string, unknown>
      processedAt: Date | null
      error: string | null
      attempts: number
      receivedAt: Date
      retentionUntil: Date
    }
  >()

  return {
    rows: stored as unknown as Map<string, { processedAt: Date | null; error: string | null }>,

    insert(input) {
      if (stored.has(input.id)) return Promise.resolve(false)
      stored.set(input.id, {
        id: input.id,
        scope: input.scope,
        type: input.type,
        accountId: input.accountId,
        livemode: input.livemode,
        payload: input.payload,
        processedAt: null,
        error: null,
        attempts: 0,
        receivedAt: new Date(),
        retentionUntil: input.retentionUntil,
      })
      return Promise.resolve(true)
    },

    find(id) {
      const row = stored.get(id)
      return Promise.resolve(
        row === undefined
          ? null
          : {
              id: row.id,
              scope: row.scope,
              type: row.type,
              accountId: row.accountId,
              livemode: row.livemode,
              payload: row.payload,
              processedAt: row.processedAt,
            },
      )
    },

    markProcessed(id, now) {
      const row = stored.get(id)
      if (row !== undefined) {
        row.processedAt = now
        row.error = null
        row.attempts += 1
      }
      return Promise.resolve()
    },

    markFailed(id, error) {
      const row = stored.get(id)
      if (row !== undefined) {
        row.error = error
        row.processedAt = null
        row.attempts += 1
      }
      return Promise.resolve()
    },

    listUnprocessed(olderThan, limit, maxAttempts) {
      return Promise.resolve(
        [...stored.values()]
          .filter(
            (row) =>
              row.processedAt === null && row.receivedAt < olderThan && row.attempts < maxAttempts,
          )
          .slice(0, limit)
          .map((row) => row.id),
      )
    },

    countDeadLettered(maxAttempts) {
      return Promise.resolve(
        [...stored.values()].filter(
          (row) => row.processedAt === null && row.attempts >= maxAttempts,
        ).length,
      )
    },

    deleteExpired(now, limit) {
      let count = 0
      for (const [id, row] of stored) {
        if (count >= limit) break
        if (row.retentionUntil <= now) {
          stored.delete(id)
          count++
        }
      }
      return Promise.resolve(count)
    },
  }
}
