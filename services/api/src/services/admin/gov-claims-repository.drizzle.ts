/**
 * Postgres-backed GovClaimsRepository (Phase 2): the production binding of the gov-provisioning seam.
 *
 * Written against the raw postgres-js tag (`Sql`) for the jsonb `checks` merge (jsonb_set / ||) and so
 * the approve/reject transitions write the claim row + the audit atomically in one transaction. Reads/
 * writes touch only gov_claims (owned) + audit_log (via writeAudit). The USER provisioning + role grant
 * are NOT here - they happen in the service via the UserProvisioner seam (the Phase 1 UserStore) before
 * approve() persists the claim transition + the user link, keeping the user-store concern out of this
 * raw-SQL repo.
 *
 * VERIFY (setCheck): merges one check object into the `checks` jsonb under its key, stamping `at` with
 * now(). Uses `checks || jsonb_build_object(key, value)` so the other checks are preserved.
 *
 * APPROVE: gov_claims.status='approved', user_id=<provisioned user>, decided_at/by, WHERE status='pending'
 * (0 rows when already decided -> null -> the service surfaces a conflict). The approved claim row IS the
 * user<->jurisdiction binding (the claim already carries jurisdiction_geoid); there is no separate
 * membership table. Audit gov_claim.approved.
 *
 * REJECT: gov_claims.status='rejected', reject_reason, decided_at/by, WHERE status='pending'. Audit
 * gov_claim.rejected.
 */

import type { Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import { decodeCursor, clampLimit, paginate } from "./pagination.js"
import { ilikeAnyOf } from "./sql-fragments.js"
import {
  type GovCheckRecord,
  type GovClaimRecord,
  type GovClaimsRepository,
  type ListGovClaimsArgs,
} from "./gov-claims-service.js"
import type { GovCheckStatus, GovMethod, GovVerificationCheck } from "@civfix/shared"

/** A gov_claims row (snake_case columns) as read from Postgres. */
interface GovClaimRow {
  id: string
  user_id: string | null
  name: string
  title: string | null
  org: string | null
  jurisdiction_geoid: string | null
  method: GovMethod
  contact_email: string | null
  status: GovClaimRecord["status"]
  checks: unknown
  reject_reason: string | null
  created_at: Date
}

/** The valid check keys, used to narrow the parsed jsonb keys to the typed union. */
const CHECK_KEYS: readonly string[] = ["linkedin", "directory", "callback"]

/** The valid check-status values; an unknown/widened status reads back as 'pending' (never coerced). */
const CHECK_STATUSES: readonly GovCheckStatus[] = ["verified", "pending"]

/** Parse the `checks` jsonb into the typed per-check map, dropping unknown keys / malformed entries. */
function parseChecks(raw: unknown): Partial<Record<GovVerificationCheck, GovCheckRecord>> {
  const out: Partial<Record<GovVerificationCheck, GovCheckRecord>> = {}
  if (!raw || typeof raw !== "object") return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CHECK_KEYS.includes(key) || !value || typeof value !== "object") continue
    const v = value as Record<string, unknown>
    // Validate against the real union (not "verified else pending") so a future widened status is not
    // silently downgraded to verified/pending on read; an unrecognized value defaults to 'pending'.
    const status: GovCheckStatus = CHECK_STATUSES.includes(v.status as GovCheckStatus)
      ? (v.status as GovCheckStatus)
      : "pending"
    out[key as GovVerificationCheck] = {
      status,
      evidence: typeof v.evidence === "string" ? v.evidence : null,
      note: typeof v.note === "string" ? v.note : null,
    }
  }
  return out
}

/** Project a row into the service record. */
function toRecord(row: GovClaimRow): GovClaimRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    title: row.title,
    org: row.org,
    jurisdictionGeoid: row.jurisdiction_geoid,
    method: row.method,
    contactEmail: row.contact_email,
    status: row.status,
    checks: parseChecks(row.checks),
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
  }
}

export function makeDrizzleGovClaimsRepository(sql: Sql): GovClaimsRepository {
  // The single 12-column projection shared by every SELECT/RETURNING (one source of truth for the row).
  const cols = sql`id, user_id, name, title, org, jurisdiction_geoid, method, contact_email, status,
    checks, reject_reason, created_at`

  return {
    async listPending(
      args: ListGovClaimsArgs,
    ): Promise<{ records: GovClaimRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)

      // The pending queue is status='pending'; the facet narrows further (a non-"all"/"pending" facet
      // yields nothing, which is correct for the pending-only queue).
      const facet =
        args.filter !== "all" && args.filter !== "pending"
          ? sql`AND status = ${args.filter}`
          : sql``
      const search =
        args.q !== null
          ? sql`AND ${ilikeAnyOf(sql, [sql`name`, sql`COALESCE(org, '')`], args.q)}`
          : sql``
      const keyset = anchor
        ? sql`AND (created_at, id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
        : sql``

      const rows = await sql<GovClaimRow[]>`
        SELECT ${cols}
        FROM gov_claims
        WHERE status = 'pending'
        ${facet}
        ${search}
        ${keyset}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `

      // paginate() owns the has-more split AND the cursor format; this site used to hand-concatenate
      // "<iso>|<id>" itself, so a change to the shared encoding would have silently skipped it.
      const { items, nextCursor } = paginate(rows, limit, (r) => ({
        createdAt: r.created_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async getClaim(id: string): Promise<GovClaimRecord | null> {
      const rows = await sql<GovClaimRow[]>`
        SELECT ${cols}
        FROM gov_claims WHERE id = ${id} LIMIT 1
      `
      const row = rows[0]
      return row ? toRecord(row) : null
    },

    async setCheck(
      id: string,
      input: {
        check: GovVerificationCheck
        status: GovCheckStatus
        evidence: string | null
        note: string | null
        actorId: string | null
      },
    ): Promise<GovClaimRecord | null> {
      return sql.begin(async (tx) => {
        // Merge one check into the checks jsonb (preserving the others) and stamp `at`.
        const checkValue = {
          status: input.status,
          evidence: input.evidence,
          note: input.note,
          at: new Date().toISOString(),
        }
        // WHERE status='pending' so an operator cannot mutate the checks of an already-decided claim (and
        // write a spurious gov_claim.verified audit); a non-pending claim returns 0 rows -> 404/no-op.
        const rows = await tx<GovClaimRow[]>`
          UPDATE gov_claims
          SET checks = COALESCE(checks, '{}'::jsonb) || jsonb_build_object(
            ${input.check}::text,
            ${tx.json(checkValue as Parameters<typeof tx.json>[0])}
          )
          WHERE id = ${id} AND status = 'pending'
          RETURNING ${cols}
        `
        const row = rows[0]
        if (!row) return null
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "gov_claim.verified",
          target: `gov_claim:${id}`,
          meta: { check: input.check, status: input.status, evidence: input.evidence },
        })
        return toRecord(row)
      })
    },

    async approve(
      id: string,
      input: { userId: string; actorId: string | null; note: string | null },
    ): Promise<GovClaimRecord | null> {
      return sql.begin(async (tx) => {
        const rows = await tx<GovClaimRow[]>`
          UPDATE gov_claims
          SET status = 'approved', user_id = ${input.userId}, decided_at = now(),
              decided_by = ${input.actorId}
          WHERE id = ${id} AND status = 'pending'
          RETURNING ${cols}
        `
        const row = rows[0]
        if (!row) return null
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "gov_claim.approved",
          target: `gov_claim:${id}`,
          meta: {
            userId: input.userId,
            jurisdictionGeoid: row.jurisdiction_geoid,
            note: input.note,
          },
        })
        return toRecord(row)
      })
    },

    async reject(
      id: string,
      input: { reason: string; actorId: string | null },
    ): Promise<GovClaimRecord | null> {
      return sql.begin(async (tx) => {
        const rows = await tx<GovClaimRow[]>`
          UPDATE gov_claims
          SET status = 'rejected', reject_reason = ${input.reason}, decided_at = now(),
              decided_by = ${input.actorId}
          WHERE id = ${id} AND status = 'pending'
          RETURNING ${cols}
        `
        const row = rows[0]
        if (!row) return null
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "gov_claim.rejected",
          target: `gov_claim:${id}`,
          meta: { reason: input.reason },
        })
        return toRecord(row)
      })
    },
  }
}
