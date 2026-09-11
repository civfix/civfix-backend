import { AppError } from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import { parseTimeCursor } from "../../db/cursor-helpers.js"
import type { PayoutStatusValue } from "../../db/schema/types-payments.js"
import type {
  InsertPendingPayoutResult,
  OrgPayoutRecord,
  OrgPayoutsRepository,
} from "./org-payouts-repository.types.js"

interface OrgPayoutRowSelect {
  id: string
  organization_id: string
  stripe_account_id: string
  stripe_payout_id: string | null
  amount_minor: string | number
  status: PayoutStatusValue
  arrival_date: Date | null
  failure_message: string | null
  requested_by: string | null
  idempotency_key: string | null
  created_at: Date
  updated_at: Date
}

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatusValue[] = ["paid", "failed", "canceled"]

export function encodePayoutCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url")
}

export function decodePayoutCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (cursor === undefined || cursor.length === 0) return null
  const parsed = parseTimeCursor(Buffer.from(cursor, "base64url").toString("utf8"))
  if (parsed === null) throw AppError.validation({ cursor: "is not a valid page cursor" })
  return { at: parsed.at.toISOString(), id: parsed.id }
}

function toPayout(row: OrgPayoutRowSelect): OrgPayoutRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    stripeAccountId: row.stripe_account_id,
    stripePayoutId: row.stripe_payout_id,
    amountMinor: typeof row.amount_minor === "number" ? row.amount_minor : Number(row.amount_minor),
    currency: "USD",
    status: row.status,
    arrivalDate: row.arrival_date,
    failureMessage: row.failure_message,
    requestedBy: row.requested_by,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function makeDrizzleOrgPayoutsRepository(sql: Sql): OrgPayoutsRepository {
  return {
    async insertPending(input): Promise<InsertPendingPayoutResult> {
      const inserted = await sql<OrgPayoutRowSelect[]>`
        INSERT INTO org_payouts (organization_id, stripe_account_id, amount_minor, status,
                                 requested_by, idempotency_key, created_at, updated_at)
        VALUES (${input.organizationId}, ${input.stripeAccountId}, ${input.amountMinor}, 'pending',
                ${input.requestedBy}, ${input.idempotencyKey}, ${input.now}, ${input.now})
        ON CONFLICT DO NOTHING
        RETURNING id, organization_id, stripe_account_id, stripe_payout_id, amount_minor, status,
                  arrival_date, failure_message, requested_by, idempotency_key, created_at, updated_at`
      const fresh = inserted[0]
      if (fresh !== undefined) return { record: toPayout(fresh), replayed: false }

      const existing = await sql<OrgPayoutRowSelect[]>`
        SELECT id, organization_id, stripe_account_id, stripe_payout_id, amount_minor, status,
               arrival_date, failure_message, requested_by, idempotency_key, created_at, updated_at
          FROM org_payouts
         WHERE organization_id = ${input.organizationId}
           AND idempotency_key = ${input.idempotencyKey}
         LIMIT 1`
      const row = existing[0]
      if (row === undefined) {
        throw AppError.conflict("This payout is already being processed; please try again shortly.")
      }
      return { record: toPayout(row), replayed: true }
    },

    async findUnconfirmed(organizationId): Promise<OrgPayoutRecord | null> {
      const rows = await sql<OrgPayoutRowSelect[]>`
        SELECT id, organization_id, stripe_account_id, stripe_payout_id, amount_minor, status,
               arrival_date, failure_message, requested_by, idempotency_key, created_at, updated_at
          FROM org_payouts
         WHERE organization_id = ${organizationId}
           AND stripe_payout_id IS NULL
           AND status = 'pending'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      const row = rows[0]
      return row === undefined ? null : toPayout(row)
    },

    async markSubmitted(input): Promise<OrgPayoutRecord | null> {
      await sql`
        DELETE FROM org_payouts
         WHERE stripe_payout_id = ${input.stripePayoutId}
           AND organization_id = ${input.organizationId}
           AND id <> ${input.id}`
      const rows = await sql<OrgPayoutRowSelect[]>`
        UPDATE org_payouts
           SET stripe_payout_id = ${input.stripePayoutId},
               status = ${input.status},
               arrival_date = ${input.arrivalDate},
               failure_message = ${input.failureMessage},
               updated_at = ${input.now}
         WHERE id = ${input.id}
        RETURNING id, organization_id, stripe_account_id, stripe_payout_id, amount_minor, status,
                  arrival_date, failure_message, requested_by, idempotency_key, created_at, updated_at`
      const row = rows[0]
      return row === undefined ? null : toPayout(row)
    },

    async markFailed(input): Promise<OrgPayoutRecord | null> {
      const rows = await sql<OrgPayoutRowSelect[]>`
        UPDATE org_payouts
           SET status = 'failed',
               failure_message = ${input.failureMessage},
               updated_at = ${input.now}
         WHERE id = ${input.id}
        RETURNING id, organization_id, stripe_account_id, stripe_payout_id, amount_minor, status,
                  arrival_date, failure_message, requested_by, idempotency_key, created_at, updated_at`
      const row = rows[0]
      return row === undefined ? null : toPayout(row)
    },

    async upsertFromProvider(input): Promise<void> {
      await sql`
        INSERT INTO org_payouts (organization_id, stripe_account_id, stripe_payout_id, amount_minor,
                                 status, arrival_date, failure_message, created_at, updated_at)
        VALUES (${input.organizationId}, ${input.stripeAccountId}, ${input.stripePayoutId},
                ${input.amountMinor}, ${input.status}, ${input.arrivalDate}, ${input.failureMessage},
                ${input.createdAt}, ${input.now})
        ON CONFLICT (stripe_payout_id) WHERE stripe_payout_id IS NOT NULL
        DO UPDATE SET status = EXCLUDED.status,
                      arrival_date = EXCLUDED.arrival_date,
                      failure_message = COALESCE(EXCLUDED.failure_message, org_payouts.failure_message),
                      updated_at = EXCLUDED.updated_at
              WHERE org_payouts.organization_id = EXCLUDED.organization_id
                AND org_payouts.status <> EXCLUDED.status
                AND (org_payouts.status NOT IN ('paid','failed','canceled')
                     OR EXCLUDED.status IN ('paid','failed','canceled'))`
    },

    async listForOrg({ organizationId, cursor, limit }): Promise<OrgPayoutRecord[]> {
      const decoded = decodePayoutCursor(cursor)
      const rows = await sql<OrgPayoutRowSelect[]>`
        SELECT id, organization_id, stripe_account_id, stripe_payout_id, amount_minor, status,
               arrival_date, failure_message, requested_by, idempotency_key, created_at, updated_at
          FROM org_payouts
         WHERE organization_id = ${organizationId}
           AND stripe_payout_id IS NOT NULL
           AND (
             ${decoded === null}
             OR (created_at, id) < (${decoded?.at ?? null}::timestamptz, ${decoded?.id ?? null}::uuid)
           )
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}`
      return rows.map(toPayout)
    },
  }
}
