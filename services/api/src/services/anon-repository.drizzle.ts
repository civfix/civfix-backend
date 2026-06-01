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
 *   1. ATOMIC per-token cap: UPDATE anon_tokens SET report_count = report_count + 1
 *      WHERE id = token AND report_count < cap. 0 rows -> cap reached -> rollback. (The cap is a TOKEN
 *      property; the claim code is NOT stamped here anymore - it lives on the report row, see step 2.)
 *   2. INSERT the report (reporter_user_id NULL, anon_session_id = token id, status 'held',
 *      visibility 'public', published_at NULL, geom from the point, h3_cell precomputed, AND the
 *      per-report single-use claim_code). Storing the code PER REPORT (not on the shared anon_tokens
 *      row, which a later submit would overwrite) is what makes each of a token's up-to-5 reports
 *      independently status-queryable + claimable (0005).
 *   3. Attach each media_asset by setting report_id, but only when unattached or already ours (never
 *      steal a foreign asset; unknown ids no-op) - identical safety to the authed path.
 *   4. INSERT the initial timeline rows: 'submitted' then 'held'.
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
import { AppError } from "@civfix/shared"
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
          // 1) ATOMIC per-token cap (bugs P0-1): bump report_count ONLY while the token is still under
          // the cap. Folding the cap into the WHERE makes the check-and-consume a single statement, so N
          // concurrent submits on one token cannot all pass a stale read and overshoot. 0 rows updated
          // means the cap is reached: throw, which rolls the whole tx back. NOTE: the claim code is NOT
          // stamped here - it is a PER-REPORT secret stored on the report row in step 2 (0005), so each
          // of the token's reports keeps its own code instead of the latest submit overwriting the rest.
          const bumped = await tx<{ report_count: number }[]>`
            UPDATE anon_tokens
            SET report_count = report_count + 1
            WHERE id = ${args.anonSessionId} AND report_count < ${args.reportCap}
            RETURNING report_count
          `
          if (bumped.length === 0) {
            throw AppError.rateLimited(
              "This anonymous session has reached its report limit. Sign in to continue.",
            )
          }

          // 2) Insert the report HELD (anon: reporter_user_id NULL, anon_session_id = token id) with its
          // own single-use claim_code (0005).
          await tx`
            INSERT INTO reports (
              id, reporter_user_id, anon_session_id, idempotency_key, geom, geom_source,
              jurisdiction_geoid, category, description, status, visibility, h3_cell, claim_code,
              published_at
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
              ${args.claimCode},
              ${null}
            )
          `

          // 3) Attach media (set report_id only when unattached or already ours; never steal a foreign).
          for (const uploadId of args.mediaUploadIds) {
            await tx`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id = ${uploadId}
                AND (report_id IS NULL OR report_id = ${args.reportId})
            `
          }

          // 4) Initial timeline: submitted, then held (the anon flow records both transitions).
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES
              (${args.reportId}, ${"submitted"}, ${null}, ${null}),
              (${args.reportId}, ${"held"}, ${"Awaiting automated review"}, ${null})
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
        // A cap-reached AppError (or any other) propagates unchanged: the tx already rolled back, so no
        // report row, timeline, media-attach, or quota bump persisted.
        throw err
      }
    },

    // --- status lookup ---
    async findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null> {
      // The claim code is stored PER REPORT (0005), so read it straight off the report row - no
      // anon_tokens join (which used to return the LATEST submit's code, breaking older reports).
      const rows = await sql<
        {
          id: string
          status: ReportStatus
          published_at: Date | null
          claim_code: string | null
        }[]
      >`
        SELECT r.id, r.status, r.published_at, r.claim_code
        FROM reports r
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
      // The claim code now lives on the report row (0005). The nudge surfaces the most recent
      // not-deleted, not-yet-claimed report that still has a code. (reporter_user_id IS NULL = not yet
      // claimed; claim_code IS NOT NULL = not yet consumed.) Each of the token's reports has its own
      // code, so older reports remain claimable directly via /claim/report even though the nudge shows
      // the newest.
      const rows = await sql<{ id: string; claim_code: string }[]>`
        SELECT r.id, r.claim_code
        FROM reports r
        WHERE r.anon_session_id = ${tokenId}
          AND r.reporter_user_id IS NULL
          AND r.deleted_at IS NULL
          AND r.claim_code IS NOT NULL
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
        // Atomically claim THE report carrying this code: lock + link + clear in one statement. The
        // code is per-report (0005) and partial-unique, so it identifies exactly one report. A consumed
        // code is cleared, so it no longer matches (single-use). reporter_user_id IS NULL guards against
        // double-claim; anon_session_id is KEPT as an audit trail (documented in claim-service).
        const updated = await tx<{ id: string }[]>`
          UPDATE reports
          SET reporter_user_id = ${userId}, claim_code = ${null}
          WHERE id = (
            SELECT id FROM reports
            WHERE claim_code = ${claimCode}
              AND reporter_user_id IS NULL
              AND deleted_at IS NULL
            FOR UPDATE
          )
          RETURNING id
        `
        const report = updated[0]
        if (!report) return null
        return { reportId: report.id }
      })
    },
  }
}
