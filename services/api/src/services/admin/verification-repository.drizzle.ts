/**
 * Postgres-backed AdminVerificationRepository (the operator review of document-verification).
 *
 * Written against the raw postgres-js tag (`Sql`) like the other admin repos. The queue is keyed by user
 * id (the user_verification PK); list pages keyset by (applied_at DESC, user_id DESC). approve/reject run
 * in ONE transaction that performs the status transition AND writes the audit row, so "did + recorded"
 * is atomic (mirrors the gov-claims repo). Approval changes NO role — verification is a trust signal.
 */

import type { Sql, Queryable } from "../../db/client.js"
import type { VerificationDocument } from "@civfix/shared"
import { decodeCursor, paginate } from "./pagination.js"
import { writeAudit } from "./audit.js"
import type {
  AdminVerificationRecord,
  AdminVerificationRepository,
  ListVerificationsArgs,
  StoredVerificationStatus,
} from "./verification-service.js"

/** A joined user_verification + users row as selected back. */
interface VerificationRowSelect {
  user_id: string
  status: StoredVerificationStatus
  note: string | null
  documents: VerificationDocument[] | null
  rejection_reason: string | null
  reviewed_by: string | null
  applied_at: Date
  reviewed_at: Date | null
  display_name: string
  handle: string | null
}

function toRecord(r: VerificationRowSelect): AdminVerificationRecord {
  return {
    userId: r.user_id,
    userName: r.display_name,
    handle: r.handle,
    status: r.status,
    note: r.note,
    documents: Array.isArray(r.documents) ? r.documents : [],
    rejectionReason: r.rejection_reason,
    reviewedBy: r.reviewed_by,
    appliedAt: r.applied_at,
    reviewedAt: r.reviewed_at,
  }
}

/** Escape an ILIKE term so %, _ and \ are literal inside the %...% wrapper. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** Load one joined verification record by user id (shared by get + the post-transition re-read). */
async function fetchOne(q: Queryable, userId: string): Promise<AdminVerificationRecord | null> {
  const rows = await q<VerificationRowSelect[]>`
    SELECT uv.user_id, uv.status, uv.note, uv.documents, uv.rejection_reason, uv.reviewed_by,
           uv.applied_at, uv.reviewed_at, u.display_name, u.handle
    FROM user_verification uv
    JOIN users u ON u.id = uv.user_id
    WHERE uv.user_id = ${userId}
    LIMIT 1
  `
  return rows[0] ? toRecord(rows[0]) : null
}

export function makeDrizzleAdminVerificationRepository(sql: Sql): AdminVerificationRepository {
  return {
    async list(
      args: ListVerificationsArgs,
    ): Promise<{ records: AdminVerificationRecord[]; nextCursor: string | null }> {
      const anchor = decodeCursor(args.cursor, true)
      const statusFilter =
        args.filter === "all" ? sql`` : sql`AND uv.status = ${args.filter}`
      const searchFilter =
        args.q !== null
          ? sql`AND (u.display_name ILIKE ${"%" + escapeLike(args.q) + "%"} ESCAPE '\\' OR (u.handle::text) ILIKE ${"%" + escapeLike(args.q) + "%"} ESCAPE '\\')`
          : sql``
      const cursorFilter =
        anchor !== null
          ? sql`AND (uv.applied_at, uv.user_id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``

      const rows = await sql<VerificationRowSelect[]>`
        SELECT uv.user_id, uv.status, uv.note, uv.documents, uv.rejection_reason, uv.reviewed_by,
               uv.applied_at, uv.reviewed_at, u.display_name, u.handle
        FROM user_verification uv
        JOIN users u ON u.id = uv.user_id
        WHERE TRUE
          ${statusFilter}
          ${searchFilter}
          ${cursorFilter}
        ORDER BY uv.applied_at DESC, uv.user_id DESC
        LIMIT ${args.limit + 1}
      `
      const { items, nextCursor } = paginate(rows.map(toRecord), args.limit, (r) => ({
        createdAt: r.appliedAt,
        id: r.userId,
      }))
      return { records: items, nextCursor }
    },

    async get(userId: string): Promise<AdminVerificationRecord | null> {
      return fetchOne(sql, userId)
    },

    async approve(
      userId: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<AdminVerificationRecord | null> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ user_id: string }[]>`
          UPDATE user_verification
          SET status = 'verified', reviewed_by = ${input.actorId}, reviewed_at = now(),
              rejection_reason = NULL, updated_at = now()
          WHERE user_id = ${userId}
          RETURNING user_id
        `
        if (!updated[0]) return null
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "verification.approved",
          target: `user:${userId}`,
          ...(input.note ? { meta: { note: input.note } } : {}),
        })
        return fetchOne(tx, userId)
      })
    },

    async reject(
      userId: string,
      input: { actorId: string | null; reason: string },
    ): Promise<AdminVerificationRecord | null> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ user_id: string }[]>`
          UPDATE user_verification
          SET status = 'rejected', rejection_reason = ${input.reason},
              reviewed_by = ${input.actorId}, reviewed_at = now(), updated_at = now()
          WHERE user_id = ${userId}
          RETURNING user_id
        `
        if (!updated[0]) return null
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "verification.rejected",
          target: `user:${userId}`,
          meta: { reason: input.reason },
        })
        return fetchOne(tx, userId)
      })
    },

    async getDocumentKey(userId: string, mediaId: string): Promise<string | null> {
      const rows = await sql<{ r2_key: string }[]>`
        SELECT m.r2_key
        FROM user_verification uv
        JOIN media_assets m ON m.id = ${mediaId}::uuid
        WHERE uv.user_id = ${userId}
          AND m.purpose = 'verification'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(uv.documents) d
            WHERE (d->>'mediaId')::uuid = ${mediaId}::uuid
          )
        LIMIT 1
      `
      return rows[0]?.r2_key ?? null
    },
  }
}
