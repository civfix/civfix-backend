// Each transition writes the claim row and its audit row in one transaction. User provisioning and the
// role grant stay in the service (UserProvisioner seam), out of this raw-SQL repository. The approved
// claim row IS the user<->jurisdiction binding (it carries jurisdiction_geoid); there is no separate
// membership table.

import type { Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import {
  decodeCursor,
  clampLimit,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
} from "./pagination.js"
import { ilikeAnyOf } from "./sql-fragments.js"
import {
  type GovCheckRecord,
  type GovClaimRecord,
  type GovClaimsRepository,
  type ListGovClaimsArgs,
} from "./gov-claims-service.js"
import type { GovCheckStatus, GovMethod, GovVerificationCheck } from "@civfix/shared"

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

const CHECK_KEYS: readonly string[] = ["linkedin", "directory", "callback"]

const CHECK_STATUSES: readonly GovCheckStatus[] = ["verified", "pending"]

function parseChecks(raw: unknown): Partial<Record<GovVerificationCheck, GovCheckRecord>> {
  const out: Partial<Record<GovVerificationCheck, GovCheckRecord>> = {}
  if (!raw || typeof raw !== "object") return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CHECK_KEYS.includes(key) || !value || typeof value !== "object") continue
    const v = value as Record<string, unknown>
    // Checked against the real union, not "verified else pending", so an unrecognized status can never
    // read back as verified.
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
  const cols = sql`id, user_id, name, title, org, jurisdiction_geoid, method, contact_email, status,
    checks, reject_reason, created_at`

  return {
    async list(
      args: ListGovClaimsArgs,
    ): Promise<{ records: GovClaimRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)
      const newestFirst = args.sort === "newest"

      const facet = args.filter === "all" ? sql`` : sql`AND status = ${args.filter}`
      const search =
        args.q !== null
          ? sql`AND ${ilikeAnyOf(sql, [sql`name`, sql`COALESCE(org, '')`], args.q)}`
          : sql``
      const keyset = !anchor
        ? sql``
        : sql`AND ${keysetPredicate(sql, sql`created_at`, sql`id`, anchor, {
            direction: newestFirst ? "desc" : "asc",
          })}`
      const order = newestFirst
        ? sql`ORDER BY created_at DESC, id DESC`
        : sql`ORDER BY created_at ASC, id ASC`

      const rows = await sql<(GovClaimRow & { cursor_at: string })[]>`
        SELECT ${cols}, ${keysetInstant(sql, sql`created_at`)} AS cursor_at
        FROM gov_claims
        WHERE true
        ${facet}
        ${search}
        ${keyset}
        ${order}
        LIMIT ${limit + 1}
      `

      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
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
        const checkValue = {
          status: input.status,
          evidence: input.evidence,
          note: input.note,
          at: new Date().toISOString(),
        }
        // A decided claim's checks are immutable, which also keeps a spurious gov_claim.verified audit out.
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
