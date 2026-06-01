/**
 * Postgres-backed implementations of the anonymous-reporting persistence seams.
 *
 * Three repositories share this file because they all touch the same tables (reports, media_assets,
 * report_timeline, anon_tokens, abuse_flags, idempotency_keys) and the same PostGIS geometry handling:
 *
 *   makeDrizzleAnonReportRepository  -> AnonReportRepository (held-create tx + status + anon_tokens store)
 *   makeDrizzleAnonHoldReleaseRepo   -> AnonHoldReleaseRepo  (the worker's release gate)
 *   makeDrizzleClaimRepository       -> ClaimRepository      (claim-by-code linking + nudge lookup)
 *
 * Like report-repository.drizzle.ts, everything runs against the raw postgres-js tag (`Sql`) rather than
 * the Drizzle query builder, because every report row carries PostGIS geometry
 * (ST_SetSRID(ST_MakePoint(lng,lat),4326) on write) which Drizzle does not model, and because the
 * held-create flow must run as a SINGLE transaction (sql.begin) to guarantee the no-duplicate +
 * no-orphan + quota-consistency contract.
 *
 * HELD-CREATE TRANSACTION (createAnonReportTx):
 *   1. INSERT the report (reporter_user_id NULL, anon_session_id = token id, status 'held',
 *      visibility 'public', published_at NULL, geom from the point, h3_cell precomputed).
 *   2. Attach each media_asset by setting report_id, but only when unattached or already ours (never
 *      steal a foreign asset; unknown ids no-op) - identical safety to the authed path.
 *   3. INSERT the initial timeline rows: 'submitted' then 'held'.
 *   4. UPDATE anon_tokens: report_count = report_count + 1, claim_code = <new code> for this token.
 *   5. INSERT the AnonReportResponse snapshot into idempotency_keys.response_snapshot.
 *   All five happen atomically. A UNIQUE(idempotency_key) (or PK) race rolls the tx back; we then read
 *   and return the winner's stored snapshot as a "replayed" result.
 */

import type { Sql } from "../db/client.js"
import type {
  AnonReportRepository,
  AnonReportStatusRow,
  CreateAnonReportTxArgs,
  CreateAnonReportTxResult,
} from "./anon-service.js"
import { ANON_REPORT_CREATE_SCOPE } from "./anon-service.js"
import type { AnonTokenRecord } from "../abuse/anon-token.js"
import type { ClaimRepository, PendingAnonReport } from "./claim-service.js"
import type { AnonReportResponse, ReportStatus } from "@civfix/shared"

/** Postgres unique-violation SQLSTATE; surfaced on the idempotency-key race. */
const PG_UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

/** Project an anon_tokens row select to the AnonTokenRecord shape. */
interface AnonTokenRowSelect {
  id: string
  created_at: Date
  expires_at: Date
  report_count: number
  flagged: boolean
  claim_code: string | null
}

function toTokenRecord(r: AnonTokenRowSelect): AnonTokenRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    reportCount: r.report_count,
    flagged: r.flagged,
    claimCode: r.claim_code,
  }
}

// ---------------------------------------------------------------------------
// AnonReportRepository
// ---------------------------------------------------------------------------

export function makeDrizzleAnonReportRepository(sql: Sql): AnonReportRepository {
  async function readSnapshot(
    key: string,
    scope: string,
  ): Promise<AnonReportResponse | null> {
    const rows = await sql<{ response_snapshot: AnonReportResponse }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${key} AND scope = ${scope}
      LIMIT 1
    `
    return rows[0]?.response_snapshot ?? null
  }

  return {
    // --- AnonTokenStore ---
    async insert(row: AnonTokenRecord): Promise<void> {
      await sql`
        INSERT INTO anon_tokens (id, created_at, expires_at, report_count, flagged, claim_code)
        VALUES (${row.id}, ${row.createdAt}, ${row.expiresAt}, ${row.reportCount}, ${row.flagged}, ${row.claimCode})
      `
    },

    async findById(id: string): Promise<AnonTokenRecord | null> {
      const rows = await sql<AnonTokenRowSelect[]>`
        SELECT id, created_at, expires_at, report_count, flagged, claim_code
        FROM anon_tokens WHERE id = ${id} LIMIT 1
      `
      return rows[0] ? toTokenRecord(rows[0]) : null
    },

    // --- idempotency ---
    async findIdempotentSnapshot(
      key: string,
      scope: string,
    ): Promise<AnonReportResponse | null> {
      return readSnapshot(key, scope)
    },

    // --- held-create transaction ---
    async createAnonReportTx(
      args: CreateAnonReportTxArgs,
    ): Promise<CreateAnonReportTxResult> {
      try {
        const snapshot = await sql.begin(async (tx) => {
          // 1) Insert the report HELD (anon: reporter_user_id NULL, anon_session_id = token id).
          await tx`
            INSERT INTO reports (
              id, reporter_user_id, anon_session_id, idempotency_key, geom, geom_source,
              jurisdiction_geoid, category, description, status, visibility, h3_cell, published_at
            ) VALUES (
              ${args.reportId},
              ${null},
              ${args.anonSessionId},
              ${args.idempotencyKey},
              ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
              ${args.geomSource},
              ${args.jurisdictionGeoid},
              ${args.category},
              ${args.description},
              ${"held"},
              ${"public"},
              ${args.h3Cell},
              ${null}
            )
          `

          // 2) Attach media (set report_id only when unattached or already ours; never steal a foreign).
          for (const uploadId of args.mediaUploadIds) {
            await tx`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id = ${uploadId}
                AND (report_id IS NULL OR report_id = ${args.reportId})
            `
          }

          // 3) Initial timeline: submitted, then held (the anon flow records both transitions).
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES
              (${args.reportId}, ${"submitted"}, ${null}, ${null}),
              (${args.reportId}, ${"held"}, ${"Awaiting automated review"}, ${null})
          `

          // 4) Bump the anon token's report_count and stamp the single-use claim code for this report.
          await tx`
            UPDATE anon_tokens
            SET report_count = report_count + 1, claim_code = ${args.claimCode}
            WHERE id = ${args.anonSessionId}
          `

          // 5) Persist the AnonReportResponse snapshot under the idempotency key (same tx).
          await tx`
            INSERT INTO idempotency_keys (key, scope, user_or_anon, response_snapshot)
            VALUES (
              ${args.idempotencyKey},
              ${ANON_REPORT_CREATE_SCOPE},
              ${args.anonSessionId},
              ${sql.json(args.responseSnapshot as Parameters<typeof sql.json>[0])}
            )
          `
          return args.responseSnapshot
        })
        return { kind: "created", snapshot }
      } catch (err) {
        if (isUniqueViolation(err)) {
          const stored = await readSnapshot(args.idempotencyKey, ANON_REPORT_CREATE_SCOPE)
          if (stored) return { kind: "replayed", snapshot: stored }
        }
        throw err
      }
    },

    // --- status lookup ---
    async findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null> {
      // Join the report to its anon_tokens row (by anon_session_id) to read the stamped claim code.
      const rows = await sql<
        {
          id: string
          status: ReportStatus
          published_at: Date | null
          claim_code: string | null
        }[]
      >`
        SELECT r.id, r.status, r.published_at, t.claim_code
        FROM reports r
        LEFT JOIN anon_tokens t ON t.id = r.anon_session_id
        WHERE r.id = ${reportId} AND r.deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      return {
        reportId: row.id,
        status: row.status,
        publishedAt: row.published_at,
        claimCode: row.claim_code,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// ClaimRepository
// ---------------------------------------------------------------------------

export function makeDrizzleClaimRepository(sql: Sql): ClaimRepository {
  return {
    // --- AnonTokenStore (resolveAnonToken needs findById; insert is unused on this path) ---
    async insert(row: AnonTokenRecord): Promise<void> {
      await sql`
        INSERT INTO anon_tokens (id, created_at, expires_at, report_count, flagged, claim_code)
        VALUES (${row.id}, ${row.createdAt}, ${row.expiresAt}, ${row.reportCount}, ${row.flagged}, ${row.claimCode})
      `
    },

    async findById(id: string): Promise<AnonTokenRecord | null> {
      const rows = await sql<AnonTokenRowSelect[]>`
        SELECT id, created_at, expires_at, report_count, flagged, claim_code
        FROM anon_tokens WHERE id = ${id} LIMIT 1
      `
      return rows[0] ? toTokenRecord(rows[0]) : null
    },

    async findPendingByTokenId(tokenId: string): Promise<PendingAnonReport | null> {
      // The token stamps the claim code; the matching not-deleted, not-yet-claimed report is the
      // pending one. (reporter_user_id IS NULL = not yet claimed.)
      const rows = await sql<{ id: string; claim_code: string }[]>`
        SELECT r.id, t.claim_code
        FROM anon_tokens t
        JOIN reports r ON r.anon_session_id = t.id AND r.reporter_user_id IS NULL AND r.deleted_at IS NULL
        WHERE t.id = ${tokenId} AND t.claim_code IS NOT NULL
        ORDER BY r.created_at DESC
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      return { reportId: row.id, claimCode: row.claim_code }
    },

    async claimByCode(
      claimCode: string,
      userId: string,
    ): Promise<{ reportId: string } | null> {
      return sql.begin(async (tx) => {
        // Find the token holding this (still-present) claim code, locking it so two concurrent claims
        // cannot both succeed. A consumed code has claim_code cleared, so it will not match.
        const tokens = await tx<{ id: string }[]>`
          SELECT id FROM anon_tokens WHERE claim_code = ${claimCode} FOR UPDATE
        `
        const token = tokens[0]
        if (!token) return null

        // Link the (unclaimed, not-deleted) report tied to that token to the user.
        const updated = await tx<{ id: string }[]>`
          UPDATE reports
          SET reporter_user_id = ${userId}
          WHERE anon_session_id = ${token.id}
            AND reporter_user_id IS NULL
            AND deleted_at IS NULL
          RETURNING id
        `
        const report = updated[0]
        if (!report) return null

        // Consume the code (single-use): clear it so it cannot be replayed. anon_session_id is KEPT as
        // an audit trail (documented choice in claim-service).
        await tx`UPDATE anon_tokens SET claim_code = ${null} WHERE id = ${token.id}`
        return { reportId: report.id }
      })
    },
  }
}
