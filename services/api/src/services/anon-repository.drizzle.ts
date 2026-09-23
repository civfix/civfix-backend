/**
 * Postgres implementations of the anonymous-reporting seams: AnonReportRepository (held create, status,
 * the anon_tokens store), AnonHoldReleaseRepo (the worker's release gate) and ClaimRepository
 * (claim-by-code linking and the nudge lookup).
 *
 * Raw postgres-js rather than the Drizzle query builder, because every report row carries PostGIS geometry
 * that Drizzle does not model and the held create must run as a single transaction.
 *
 * The claim code is per report and rests only as its SHA-256 on reports.claim_code_hash, never in
 * plaintext and never on the shared anon_tokens row: the plaintext exists only in the one-time response to
 * the submitter. Storing the digest per report, not on the token row a later submit would overwrite, is
 * what keeps each of a token's reports independently status-queryable and claimable.
 *
 * A UNIQUE(idempotency_key) race rolls the held-create transaction back and answers the retryable 409: the
 * winner's claim code is not at rest to hand back, and rotating it here would kill the code the winner's
 * response is carrying at that moment.
 *
 * Replay: the idempotency snapshot holds only { reportId, status }, so a replay mints a fresh claim code
 * and rotates that report's claim_code_hash onto it (the first response's code stops working). That keeps
 * the plaintext out of idempotency_keys and its backups while the replayed response still carries a
 * working code, and keeps exactly one live code per report. A replay is only ever a request that arrived
 * after the winner committed, which is a client that lost the first response.
 */

import type { Sql, TransactionSql } from "../db/client.js"
import { generateToken, sha256Hex } from "../auth/crypto.js"
import type {
  AnonAbuseReason,
  AnonReportRepository,
  AnonReportStatusRow,
  CreateAnonReportTxArgs,
  CreateAnonReportTxResult,
} from "./anon-service.js"
import { ANON_REPORT_CREATE_SCOPE } from "./anon-service.js"
import { allocateReportReferenceCode } from "../db/reference-code.js"
import {
  ANON_REPORT_CAP_MESSAGE,
  type AnonTokenRecord,
  type AnonTokenStore,
} from "../abuse/anon-token.js"
import type { ClaimRepository, PendingAnonReport } from "./claim-service.js"
import { AppError } from "@civfix/shared"
import type { AnonReportResponse, ReportStatus } from "@civfix/shared"
import { insertModerationItem } from "./admin/moderation-repository.drizzle.js"
import { claimableAsReportMedia, lockUploadsForClaim } from "./media-bindings.js"
import { isUniqueViolation } from "../db/pg-errors.js"

const HELD_REVIEW_NOTE = "Awaiting automated review"

const HELD_REPORT_FLAG = "Held report"

const HELD_AUTO_ACTION = "Hidden pending review"

const ANON_REPORTER_LABEL = "Anonymous"

const MEDIA_UNAVAILABLE_MESSAGE = "One or more media uploads are unavailable."

const KEY_RACE_MESSAGE = "Report submit is still settling; retry"

const REPLAY_UNCLAIMABLE_MESSAGE = "This report was already submitted and can no longer be claimed."

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

function anonTokenStore(sql: Sql): AnonTokenStore {
  return {
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
  }
}

type StoredAnonSnapshot = Omit<AnonReportResponse, "claimCode">

export interface DrizzleAnonReportRepositoryOptions {
  newClaimCode?: () => string
}

export interface DrizzleAnonReportRepository extends AnonReportRepository {
  raiseAbuseFlag(
    subjectType: "report" | "anon_token",
    subjectId: string,
    reason: AnonAbuseReason,
  ): Promise<void>
}

export function makeDrizzleAnonReportRepository(
  sql: Sql,
  opts: DrizzleAnonReportRepositoryOptions = {},
): DrizzleAnonReportRepository {
  const tokens = anonTokenStore(sql)
  const newClaimCode = opts.newClaimCode ?? (() => generateToken())

  async function replaySnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<AnonReportResponse | null> {
    const rows = await sql<{ response_snapshot: StoredAnonSnapshot }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${key}
        AND scope = ${scope}
        AND user_or_anon IS NOT DISTINCT FROM ${userOrAnon}
      LIMIT 1
    `
    const stored = rows[0]?.response_snapshot
    if (!stored) return null
    const claimCode = newClaimCode()
    const rotated = await sql<{ id: string }[]>`
      UPDATE reports
      SET claim_code_hash = ${await sha256Hex(claimCode)}, claim_code = ${null}
      WHERE id = ${stored.reportId}
        AND anon_session_id = ${userOrAnon}
        AND reporter_user_id IS NULL
        AND deleted_at IS NULL
        AND claim_code_hash IS NOT NULL
      RETURNING id
    `
    // A claimed (or removed) report has no live code to hand back, and the contract has no response
    // without one; answering a code that can never claim would be worse than saying so.
    if (rotated.length === 0) throw AppError.conflict(REPLAY_UNCLAIMABLE_MESSAGE)
    return { reportId: stored.reportId, status: stored.status, claimCode }
  }

  return {
    ...tokens,

    async findIdempotentSnapshot(
      key: string,
      scope: string,
      userOrAnon: string | null,
    ): Promise<AnonReportResponse | null> {
      return replaySnapshot(key, scope, userOrAnon)
    },

    async createAnonReportTx(args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult> {
      try {
        const snapshot = await sql.begin(async (tx) => {
          // The reference_counters upsert must be the first write in every create transaction, so each
          // path takes the counter-row lock before any report or token row lock; that consistent order rules
          // out an ABBA deadlock. Anon reports still get a code; they simply never auto-forward.
          const referenceCode = await allocateReportReferenceCode(tx, args.type, args.jurCode)
          await consumeTokenQuota(tx, args)
          await insertHeldReport(tx, args, referenceCode)
          await attachReportMedia(tx, args)
          await insertInitialTimeline(tx, args.reportId)
          // Every anon report is held pending automated review, so the operator moderation queue surfaces it
          // immediately. The same transaction keeps the item and the held report atomic; signals and user
          // are enriched later by the media worker or abuse detection.
          await insertModerationItem(tx, {
            kind: "image",
            subjectType: "report",
            subjectId: args.reportId,
            flag: HELD_REPORT_FLAG,
            reason: HELD_REVIEW_NOTE,
            category: args.category,
            autoAction: HELD_AUTO_ACTION,
            reporter: ANON_REPORTER_LABEL,
            desc: args.description ?? "",
          })
          await persistIdempotencySnapshot(sql, tx, args)
          return args.responseSnapshot
        })
        return { kind: "created", snapshot }
      } catch (err) {
        if (isUniqueViolation(err)) {
          // The winner of the key race is still in flight to its client with the only live claim code,
          // so this request must not rotate it, and the plaintext is not at rest to replay. A retry of
          // the same key reaches findIdempotentSnapshot, which rotates for a client that lost that
          // response. A key held by a different anon session lands here too (reports.idempotency_key is
          // globally unique) and gets the same answer, never that session's report.
          throw AppError.conflict(KEY_RACE_MESSAGE)
        }
        // A cap-reached AppError (or any other) propagates unchanged: the tx already rolled back, so no
        // report row, timeline, media-attach, or quota bump persisted.
        throw err
      }
    },

    async findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null> {
      // Read off the report row, not through anon_tokens, which held only the latest submit's code and
      // broke older reports. The caller hashes the presented code and compares digests, so no secret is
      // read back here.
      const rows = await sql<
        {
          id: string
          status: ReportStatus
          published_at: Date | null
          claim_code_hash: string | null
        }[]
      >`
        SELECT r.id, r.status, r.published_at, r.claim_code_hash
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
        claimCodeHash: row.claim_code_hash,
      }
    },

    async raiseAbuseFlag(subjectType, subjectId, reason): Promise<void> {
      await sql`
        INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
        SELECT ${subjectType}, ${subjectId}, ${reason}, 'api'
        WHERE NOT EXISTS (
          SELECT 1 FROM abuse_flags
          WHERE subject_type = ${subjectType} AND subject_id = ${subjectId}
            AND reason = ${reason} AND source = 'api' AND resolved_at IS NULL
        )
      `
    },
  }
}

// Folding the cap into the WHERE makes check-and-consume a single statement, so concurrent submits on one
// token cannot all pass a stale read and overshoot. Zero rows means the cap is reached, and the throw rolls
// the whole transaction back.
async function consumeTokenQuota(tx: TransactionSql, args: CreateAnonReportTxArgs): Promise<void> {
  const bumped = await tx<{ report_count: number }[]>`
            UPDATE anon_tokens
            SET report_count = report_count + 1
            WHERE id = ${args.anonSessionId} AND report_count < ${args.reportCap}
            RETURNING report_count
          `
  if (bumped.length === 0) {
    throw AppError.rateLimited(ANON_REPORT_CAP_MESSAGE)
  }
}

// The plaintext claim_code column is written NULL: the code never rests in the database, so a dump, backup
// or replica leak cannot bind anyone else's anonymous report to an account, and the column's deferred DROP
// changes nothing here.
async function insertHeldReport(
  tx: TransactionSql,
  args: CreateAnonReportTxArgs,
  referenceCode: string,
): Promise<void> {
  await tx`
            INSERT INTO reports (
              id, reporter_user_id, anon_session_id, idempotency_key, geom, geom_source,
              jurisdiction_geoid, category, type, title, description, addr, addr_source, addr_precision,
              status, visibility, h3_cell,
              claim_code, claim_code_hash, reference_code, published_at
            ) VALUES (
              ${args.reportId},
              ${null},
              ${args.anonSessionId},
              ${args.idempotencyKey},
              ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
              ${args.geomSource},
              ${args.jurisdictionGeoid},
              ${args.category},
              ${args.type},
              ${args.title},
              ${args.description},
              ${args.addr},
              ${args.addrSource},
              ${args.addrPrecision},
              ${"held"},
              ${"public"},
              ${args.h3Cell},
              ${null},
              ${args.claimCodeHash},
              ${referenceCode},
              ${null}
            )
          `
}

// An asset bound to a post, a chat or DM message or any other owner is never re-bindable to a report, or
// the holder of an uploadId could cross-publish private media into a public report gallery. One set-based
// UPDATE rather than a per-id loop, so N photos don't lengthen the transaction while it holds the report and
// token row locks; skipped with no ids because `IN ()` is invalid SQL.
async function attachReportMedia(tx: TransactionSql, args: CreateAnonReportTxArgs): Promise<void> {
  if (args.mediaUploadIds.length === 0) return
  await lockUploadsForClaim(tx, args.mediaUploadIds)
  const claimed = await tx<{ upload_id: string }[]>`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id IN ${tx(args.mediaUploadIds)}
                AND (report_id IS NULL OR report_id = ${args.reportId})
                AND post_id IS NULL AND chat_message_id IS NULL
                AND ${claimableAsReportMedia(tx, args.mediaUploaders)}
                AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
              RETURNING upload_id
            `
  // Reject the whole submit when any id is unclaimable (unknown, rejected, or already bound elsewhere)
  // rather than commit a report with the photo silently missing, the same rule the authed create path and
  // post-repository.createPost enforce. The throw also rolls back the token quota bump.
  if (claimed.length !== new Set(args.mediaUploadIds).size) {
    throw AppError.validation({ mediaUploadIds: MEDIA_UNAVAILABLE_MESSAGE })
  }
}

// Both rows would share now() (constant within a transaction) and report_timeline.id is a random uuid, so
// ORDER BY created_at, id has no stable tiebreaker; held is stamped 1ms later so every reader sees
// submitted first.
async function insertInitialTimeline(tx: TransactionSql, reportId: string): Promise<void> {
  await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id, created_at)
            VALUES
              (${reportId}, ${"submitted"}, ${null}, ${null}, now()),
              (${reportId}, ${"held"}, ${HELD_REVIEW_NOTE}, ${null}, now() + interval '1 millisecond')
          `
}

// Stored without the plaintext claim code: a replay mints a fresh one instead.
async function persistIdempotencySnapshot(
  sql: Sql,
  tx: TransactionSql,
  args: CreateAnonReportTxArgs,
): Promise<void> {
  const storedSnapshot: StoredAnonSnapshot = {
    reportId: args.responseSnapshot.reportId,
    status: args.responseSnapshot.status,
  }
  await tx`
            INSERT INTO idempotency_keys (key, scope, user_or_anon, response_snapshot)
            VALUES (
              ${args.idempotencyKey},
              ${ANON_REPORT_CREATE_SCOPE},
              ${args.anonSessionId},
              ${sql.json(storedSnapshot as Parameters<typeof sql.json>[0])}
            )
          `
}

export function makeDrizzleClaimRepository(sql: Sql): ClaimRepository {
  return {
    // ClaimRepository extends AnonTokenStore; the claim path only reads (findById), but the store carries
    // insert too. Composing the shared store keeps the two anon repos byte-identical here.
    ...anonTokenStore(sql),

    async rotatePendingClaimCode(
      tokenId: string,
      claimCodeHash: string,
    ): Promise<PendingAnonReport | null> {
      // Only the digest of a claim code is stored, so the nudge cannot read a code back: it stamps the
      // caller's freshly minted code onto the token's most recent unclaimed report (reporter_user_id IS
      // NULL) whose code is not yet consumed (claim_code_hash IS NOT NULL), superseding that report's old
      // code. Still one live single-use code per report; older reports stay claimable via /claim/report by
      // their own code. FOR UPDATE serializes two concurrent nudges on one token.
      const rows = await sql<{ id: string }[]>`
        UPDATE reports
        SET claim_code_hash = ${claimCodeHash}, claim_code = ${null}
        WHERE id = (
          SELECT id FROM reports
          WHERE anon_session_id = ${tokenId}
            AND reporter_user_id IS NULL
            AND deleted_at IS NULL
            AND claim_code_hash IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        )
        RETURNING id
      `
      const row = rows[0]
      if (!row) return null
      return { reportId: row.id }
    },

    async claimByCode(claimCodeHash: string, userId: string): Promise<{ reportId: string } | null> {
      return sql.begin(async (tx) => {
        // Lock, link and clear in one statement. The caller hashes the presented code, so the lookup is an
        // index probe on the partial-unique reports_claim_code_hash_key: exactly one report, and no timing
        // oracle on the secret. Clearing both columns makes the code single-use and leaves no legacy
        // plaintext behind. reporter_user_id IS NULL guards against double-claim; anon_session_id is kept
        // as an audit trail (documented in claim-service).
        const updated = await tx<{ id: string }[]>`
          UPDATE reports
          SET reporter_user_id = ${userId}, claim_code = ${null}, claim_code_hash = ${null}
          WHERE id = (
            SELECT id FROM reports
            WHERE claim_code_hash = ${claimCodeHash}
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
