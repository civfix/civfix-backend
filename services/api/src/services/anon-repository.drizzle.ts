/**
 * Postgres-backed implementations of the anonymous-reporting persistence seams.
 *
 * Three repositories share this file because they all touch the same tables (reports, media_assets,
 * report_timeline, anon_tokens, abuse_flags, idempotency_keys) and the same PostGIS geometry handling:
 *
 *   makeDrizzleAnonReportRepository  -> AnonReportRepository (held-create tx + status + the anon_tokens
 *                                       resolve/issue store; the claim code is per-report and rests
 *                                       ONLY as its SHA-256 on reports.claim_code_hash (0091), never
 *                                       in plaintext and never on the anon_tokens row)
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
 *      SHA-256 of the per-report single-use claim code). The plaintext code is NEVER persisted
 *      (F150): it exists only in the one-time response to the submitter, and every read path hashes
 *      the presented code to match reports.claim_code_hash (0091). Storing the digest PER REPORT
 *      (not on the shared anon_tokens row, which a later submit would overwrite) is what makes each
 *      of a token's up-to-5 reports independently status-queryable + claimable (0005).
 *   3. Attach each media_asset by setting report_id, but only when unattached or already ours (never
 *      steal a foreign asset; unknown ids no-op) - identical safety to the authed path.
 *   4. INSERT the initial timeline rows: 'submitted' then 'held'.
 *   5. INSERT the AnonReportResponse snapshot into idempotency_keys.response_snapshot, owner-scoped
 *      by user_or_anon = the anon token id (0078/0079).
 *   All five happen atomically. A UNIQUE(idempotency_key) (or unique-index) race rolls the tx back; we
 *   then read and return the winner's stored snapshot as a "replayed" result - but only when the
 *   winner is the SAME anon session (F028), so a key squatted by a stranger never replays their
 *   snapshot (and with it their claim code) to somebody else.
 */

import type { Sql } from "../db/client.js"
import type {
  AnonReportRepository,
  AnonReportStatusRow,
  CreateAnonReportTxArgs,
  CreateAnonReportTxResult,
} from "./anon-service.js"
import { ANON_REPORT_CREATE_SCOPE } from "./anon-service.js"
import { allocateReportReferenceCode } from "../db/reference-code.js"
import type { AnonTokenRecord, AnonTokenStore } from "../abuse/anon-token.js"
import type { ClaimRepository, PendingAnonReport } from "./claim-service.js"
import { AppError } from "@civfix/shared"
import type { AnonReportResponse, ReportStatus } from "@civfix/shared"
import { insertModerationItem } from "./admin/moderation-repository.drizzle.js"

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

/** The shared AnonTokenStore over anon_tokens (both anon repos compose it). */
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

export function makeDrizzleAnonReportRepository(sql: Sql): AnonReportRepository {
  const tokens = anonTokenStore(sql)
  async function readSnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<AnonReportResponse | null> {
    const rows = await sql<{ response_snapshot: AnonReportResponse }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${key}
        AND scope = ${scope}
        AND user_or_anon IS NOT DISTINCT FROM ${userOrAnon}
      LIMIT 1
    `
    return rows[0]?.response_snapshot ?? null
  }

  return {
    ...tokens,

    async findIdempotentSnapshot(
      key: string,
      scope: string,
      userOrAnon: string | null,
    ): Promise<AnonReportResponse | null> {
      return readSnapshot(key, scope, userOrAnon)
    },

    async createAnonReportTx(args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult> {
      try {
        const snapshot = await sql.begin(async (tx) => {
          // 0) D4 LOCK ORDER: allocate the reference code FIRST — the reference_counters upsert must be the
          // FIRST write in EVERY create tx so each path takes the counter-row lock before any report/token
          // row lock (a consistent acquisition order that rules out an ABBA deadlock). jurCode is resolved
          // pre-tx (0 = unknown bucket when no jurisdiction, D5). Anon reports still get a code (#56 / M3);
          // they simply never auto-forward.
          const referenceCode = await allocateReportReferenceCode(tx, args.type, args.jurCode)

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

          // 2) Insert the report HELD (anon: reporter_user_id NULL, anon_session_id = token id) with the
          // SHA-256 of its own single-use claim code (0005 + 0091). The plaintext column is written NULL:
          // the code never rests in the database (F150), so a dump/backup/replica leak cannot bind anyone
          // else's anonymous report to an account, and the deferred DROP of reports.claim_code is a no-op
          // for every write and read here.
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

          // 3) Attach media (set report_id only when unattached or already ours; never steal a foreign).
          // Set-based UPDATE over all upload ids in ONE round-trip (postgres-js array binding) instead of
          // a per-id loop, so attaching N photos doesn't lengthen the held-create tx by N statements while
          // it holds the report + token row locks. Skipped when there are no ids, since `IN ()` is invalid
          // SQL. Semantics are unchanged: each row's report_id is set only when unattached or already ours,
          // foreign assets stay untouched, and unknown ids no-op.
          if (args.mediaUploadIds.length > 0) {
            const claimed = await tx<{ upload_id: string }[]>`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id IN ${tx(args.mediaUploadIds)}
                AND (report_id IS NULL OR report_id = ${args.reportId})
                -- L18: see the same guard on the authenticated create path. An asset already bound to a post
                -- or a chat/DM message is never re-bindable to a report, so an uploadId cannot be used to
                -- cross-publish private media into a public report gallery.
                AND post_id IS NULL AND chat_message_id IS NULL
                AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
              RETURNING upload_id
            `
            // M-media-claim: reject the whole submit when any id is unclaimable (unknown, rejected, or
            // already bound elsewhere) instead of committing a report with the photo silently missing —
            // the same rule the authed create path and post-repository.createPost enforce. The throw rolls
            // the tx back, so the token quota bump does not persist either.
            if (claimed.length !== new Set(args.mediaUploadIds).size) {
              throw AppError.validation({
                mediaUploadIds: "One or more media uploads are unavailable.",
              })
            }
          }

          // 4) Initial timeline: submitted, then held (the anon flow records both transitions). Both
          // rows share now() (constant within a transaction) and report_timeline.id is a random uuid, so
          // ORDER BY created_at, id had NO stable tiebreaker — a reader could get held-before-submitted.
          // Stamp held 1ms after submitted so the chronological order is deterministic for every reader.
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id, created_at)
            VALUES
              (${args.reportId}, ${"submitted"}, ${null}, ${null}, now()),
              (${args.reportId}, ${"held"}, ${"Awaiting automated review"}, ${null}, now() + interval '1 millisecond')
          `

          // 4b) Enqueue the moderation_items row for this held report (Phase 2 producer hook). The anon
          // hold-then-publish path holds EVERY anon report pending automated review, so the operator
          // moderation queue surfaces it immediately. Done inside the SAME tx as the report insert so the
          // item and the held report are atomic (never an item without its report, or vice versa). Kept
          // lean: kind 'image', subject the report, the dominant category + description carried for the
          // detail; signals/user are enriched later by the media-worker / abuse detection if applicable.
          await insertModerationItem(tx, {
            kind: "image",
            subjectType: "report",
            subjectId: args.reportId,
            flag: "Held report",
            reason: "Awaiting automated review",
            category: args.category,
            autoAction: "Hidden pending review",
            reporter: "Anonymous",
            desc: args.description ?? "",
          })

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
          const stored = await readSnapshot(
            args.idempotencyKey,
            ANON_REPORT_CREATE_SCOPE,
            args.anonSessionId,
          )
          if (stored) return { kind: "replayed", snapshot: stored }
          // Nothing of OURS to replay: either the winner of the idempotency race has taken the key but
          // not yet committed its snapshot, or the key belongs to a DIFFERENT anon session (reports'
          // idempotency_key is globally unique, so a squatted key collides here). Both answer the
          // retryable 409 the authenticated path answers (report-repository.createReportTx) instead of
          // leaking the raw postgres error as a 500 - and, critically, instead of handing a stranger's
          // snapshot + claim code to this caller (F028).
          throw AppError.conflict("Report submit is still settling; retry")
        }
        // A cap-reached AppError (or any other) propagates unchanged: the tx already rolled back, so no
        // report row, timeline, media-attach, or quota bump persisted.
        throw err
      }
    },

    async findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null> {
      // The claim code DIGEST is stored PER REPORT (0005 + 0091), so read it straight off the report row
      // - no anon_tokens join (which used to return the LATEST submit's code, breaking older reports).
      // The caller hashes the presented code and compares digests, so no secret is read back here.
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
  }
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
      // Only the DIGEST of a claim code is stored (0091), so the nudge cannot read a code back: it
      // stamps the caller's freshly minted code onto the token's most recent not-deleted, not-yet-claimed
      // report (reporter_user_id IS NULL = not yet claimed; claim_code_hash IS NOT NULL = not yet
      // consumed), which supersedes whatever code that report carried. Still exactly one live code per
      // report, still single-use, and older reports stay claimable directly via /claim/report by their
      // own code. Selecting FOR UPDATE serializes two concurrent nudges on one token.
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
        // Atomically claim THE report whose stored digest matches: lock + link + clear in one statement.
        // The caller hashes the presented code, so the lookup is an index probe on the partial-unique
        // reports_claim_code_hash_key (0091) - exactly one report, and no timing oracle on the secret.
        // Backfilled pre-0091 rows already carry their digest, so old reports stay claimable. A consumed
        // code is cleared (both columns, so a legacy plaintext row cannot linger), so it no longer matches
        // (single-use). reporter_user_id IS NULL guards against double-claim; anon_session_id is KEPT as
        // an audit trail (documented in claim-service).
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
