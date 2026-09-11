import { randomUUID } from "node:crypto"
import { decodePayoutCursor, TERMINAL_PAYOUT_STATUSES } from "./org-payouts-repository.drizzle.js"
import type {
  InsertPendingPayoutResult,
  OrgPayoutRecord,
  OrgPayoutsRepository,
} from "./org-payouts-repository.types.js"

export interface MemoryOrgPayoutsSeed {
  payouts?: OrgPayoutRecord[]
  newId?: () => string
}

export function makeMemoryOrgPayoutsRepository(
  seed: MemoryOrgPayoutsSeed = {},
): OrgPayoutsRepository & { rows: OrgPayoutRecord[] } {
  const rows: OrgPayoutRecord[] = [...(seed.payouts ?? [])]
  const newId = seed.newId ?? (() => randomUUID())

  function byId(id: string): OrgPayoutRecord | undefined {
    return rows.find((row) => row.id === id)
  }

  return {
    rows,

    insertPending(input): Promise<InsertPendingPayoutResult> {
      const existing = rows.find(
        (row) =>
          row.organizationId === input.organizationId &&
          row.idempotencyKey === input.idempotencyKey,
      )
      if (existing !== undefined) return Promise.resolve({ record: { ...existing }, replayed: true })
      const record: OrgPayoutRecord = {
        id: newId(),
        organizationId: input.organizationId,
        stripeAccountId: input.stripeAccountId,
        stripePayoutId: null,
        amountMinor: input.amountMinor,
        currency: "USD",
        status: "pending",
        arrivalDate: null,
        failureMessage: null,
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
        createdAt: input.now,
        updatedAt: input.now,
      }
      rows.push(record)
      return Promise.resolve({ record: { ...record }, replayed: false })
    },

    markSubmitted(input): Promise<OrgPayoutRecord | null> {
      const record = byId(input.id)
      if (record === undefined) return Promise.resolve(null)
      record.stripePayoutId = input.stripePayoutId
      record.status = input.status
      record.arrivalDate = input.arrivalDate
      record.failureMessage = input.failureMessage
      record.updatedAt = input.now
      return Promise.resolve({ ...record })
    },

    markFailed(input): Promise<OrgPayoutRecord | null> {
      const record = byId(input.id)
      if (record === undefined) return Promise.resolve(null)
      record.status = "failed"
      record.failureMessage = input.failureMessage
      record.updatedAt = input.now
      return Promise.resolve({ ...record })
    },

    upsertFromProvider(input): Promise<void> {
      const existing = rows.find((row) => row.stripePayoutId === input.stripePayoutId)
      if (existing === undefined) {
        rows.push({
          id: newId(),
          organizationId: input.organizationId,
          stripeAccountId: input.stripeAccountId,
          stripePayoutId: input.stripePayoutId,
          amountMinor: input.amountMinor,
          currency: "USD",
          status: input.status,
          arrivalDate: input.arrivalDate,
          failureMessage: input.failureMessage,
          requestedBy: null,
          idempotencyKey: null,
          createdAt: input.createdAt,
          updatedAt: input.now,
        })
        return Promise.resolve()
      }
      if (existing.status === input.status) return Promise.resolve()
      if (
        TERMINAL_PAYOUT_STATUSES.includes(existing.status) &&
        !TERMINAL_PAYOUT_STATUSES.includes(input.status)
      ) {
        return Promise.resolve()
      }
      existing.status = input.status
      existing.arrivalDate = input.arrivalDate
      existing.failureMessage = input.failureMessage ?? existing.failureMessage
      existing.updatedAt = input.now
      return Promise.resolve()
    },

    listForOrg({ organizationId, cursor, limit }): Promise<OrgPayoutRecord[]> {
      const decoded = decodePayoutCursor(cursor)
      const ordered = rows
        .filter((row) => row.organizationId === organizationId && row.stripePayoutId !== null)
        .sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime()
          return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
        })
      const after =
        decoded === null
          ? ordered
          : ordered.filter((row) => {
              const at = row.createdAt.toISOString()
              return at < decoded.at || (at === decoded.at && row.id < decoded.id)
            })
      return Promise.resolve(after.slice(0, limit).map((row) => ({ ...row })))
    },
  }
}
