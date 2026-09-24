/**
 * Service-hours transcript orchestration (P5 / DP §4.3): ledger read -> pure model -> fingerprint ->
 * render -> R2 -> row, plus the holder's list/revoke reads and the PUBLIC verification projection.
 *
 * This is the only impure half of the certificate stack. `certificate-model.ts` (the model +
 * fingerprint), `certificate-layout.ts` (pagination) and `certificate-pdf.ts` (the renderer) are pure;
 * everything below does I/O and throws `AppError`. Routes never build error bodies.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ DB T2 — THE MEDIA-WORKER ORPHAN SWEEP MUST NEVER REAP `certificates/`.
 *
 * These PDFs live in the MEDIA bucket (B41b: `container.storage`, no new env var) under the
 * `certificates/service-hours/…` prefix, but they are deliberately NOT `media_assets` rows: creating one
 * would drag in the byte quota, the NSFW check and the orphan sweep, and would widen `MediaPurposeSchema`
 * for something that is not user media.
 *
 * Today that is safe, because the media-worker's orphan reaper is ROW-DRIVEN — it walks
 * `media_reap_tombstones` / `media_assets` and deletes the keys those rows name; it never lists the
 * bucket by prefix. A certificate object has no row there, so nothing can reach it.
 *
 * IF ANYONE EVER ADDS A PREFIX-LISTING REAPER TO THE MEDIA BUCKET, IT MUST SKIP `certificates/`.
 * Every object under this prefix is referenced by a `service_hours_certificates` row and is the durable
 * cache behind a document a volunteer has already handed to a school or a court. A prefix sweep that does
 * not know about this table would silently break every issued transcript.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomUUID } from "node:crypto"
import {
  AppError,
  CERTIFICATE_GET_URL_TTL_SEC,
  MAX_CERTIFICATE_ENTRIES,
  formatCertificateCode,
} from "@civfix/shared"
import type {
  IssueServiceHoursCertificateResponse,
  ListMyCertificatesResponse,
  RevokeCertificateResponse,
  ServiceHoursCertificateDTO,
  VerifyCertificateResponse,
} from "@civfix/shared"
import type { StorageHead, StoragePutMeta } from "@civfix/shared/interfaces"
import { resolveLocale } from "../i18n/locales.js"
import { CERTIFICATE_CODE_MINT_ATTEMPTS, generateCertificateCode } from "./certificate-code.js"
import {
  buildTranscriptModel,
  certificateTranslator,
  ledgerFingerprint,
  type TranscriptLedgerRow,
  type TranscriptModel,
} from "./certificate-model.js"
import { buildServiceHoursPdf } from "./certificate-pdf.js"
import type {
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
} from "./volunteer-hours-service.js"

// ---- storage seam -------------------------------------------------------------------------------

/**
 * Structural slice of the storage adapter, declared locally exactly as `services/media-presign.ts:9-15`
 * does — and for the same reason (H9):
 *
 * the shared `Storage` interface declares `presignGet(key, ttlSec)` with only TWO parameters. The third
 * `opts` argument is honoured by `R2Storage` but is not on the interface, so a slice that declares it
 * keeps `FakeStorage` (two params, method-bivariant) assignable while making `{ forceSigned: true }`
 * expressible at every call site.
 *
 * `forceSigned` is NOT optional in practice here: `R2_PUBLIC_BASE` is set in production, and without it
 * `R2Storage.presignGet` returns an UNSIGNED, PERMANENT CDN URL — which would publish every volunteer's
 * itemised service record forever, with no expiry and no revocation path. Always
 * `presignGet(key, CERTIFICATE_GET_URL_TTL_SEC, { forceSigned: true })`.
 *
 * `makePrivateMediaPresigner` is deliberately not reused: it returns a `{ url, thumbUrl? }` media pair.
 */
export interface CertificateStorage {
  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string>
  head(key: string): Promise<StorageHead | null>
  put(key: string, body: Uint8Array, meta?: StoragePutMeta): Promise<void>
  delete(key: string): Promise<void>
}

// ---- repository contract ------------------------------------------------------------------------

/** The holder identity frozen onto the document, read from `users`. */
export interface CertificateHolder {
  userId: string
  displayName: string
  handle: string | null
  /** `users.locale`; the default when the request does not pin one. */
  locale: string
}

/**
 * One certificate row as every read path projects it.
 *
 * `snapshot` is DELIBERATELY ABSENT. At 1000 entries the jsonb is ~200 KB and lives out of line in TOAST;
 * a read path that selects it detoasts on every list and every public verification. Every repo query
 * therefore names its columns explicitly (never `SELECT *`) and none of them names `snapshot` —
 * `service-hours-certificates-pg.test.ts` greps the repo source to keep it that way.
 */
export interface CertificateRow {
  id: string
  userId: string
  code: string
  locale: string
  holderName: string
  holderHandle: string | null
  holderVerified: boolean
  totalHours: number
  entryCount: number
  periodStart: Date | null
  periodEnd: Date | null
  ledgerFingerprint: string
  r2Key: string
  documentSha256: string
  byteSize: number
  issuedAt: Date
  regeneratedAt: Date | null
  revokedAt: Date | null
  revokedReason: string | null
}

/**
 * The verification read. `holderDeleted` mirrors `users.deleted_at IS NOT NULL` from the join: the
 * projection cannot simply filter tombstoned holders out, because "no such code" and "that account was
 * closed" are materially different answers for the person holding the paper (DP §5.3).
 */
export interface CertificateVerifyRow extends CertificateRow {
  holderDeleted: boolean
}

export interface CertificateInsert {
  id: string
  userId: string
  code: string
  locale: string
  holderName: string
  holderHandle: string | null
  holderVerified: boolean
  totalHours: number
  entryCount: number
  periodStart: Date | null
  periodEnd: Date | null
  ledgerFingerprint: string
  /** The exact rendered model, stored so the object is re-renderable. Written once, never read back. */
  snapshot: TranscriptModel
  r2Key: string
  documentSha256: string
  byteSize: number
  issuedAt: Date
}

/** Which unique index an `insert` lost to. The two have completely different recoveries. */
export type CertificateConflictKind = "code" | "fingerprint"

/**
 * Raised by `insert` instead of leaking a driver error, so the service can branch without knowing about
 * postgres error codes and so the in-memory twin can reproduce both races exactly.
 */
export class CertificateConflictError extends Error {
  constructor(readonly kind: CertificateConflictKind) {
    super(`service_hours_certificates ${kind} conflict`)
    this.name = "CertificateConflictError"
  }
}

export interface CertificateRepository {
  /**
   * @throws CertificateConflictError("code") on `service_hours_certificates_code_uidx`
   * @throws CertificateConflictError("fingerprint") on the partial
   *         `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL` index
   */
  insert(row: CertificateInsert): Promise<CertificateRow>
  findLiveByFingerprint(userId: string, fingerprint: string): Promise<CertificateRow | null>
  listFor(userId: string): Promise<CertificateRow[]>
  /** Joins `users` so a tombstoned holder is DISTINGUISHABLE from an unknown code. */
  findByCode(code: string): Promise<CertificateVerifyRow | null>
  /**
   * Idempotent: returns the row whether or not it was already revoked, and null only when the code does
   * not exist OR does not belong to `userId` — the service turns that null into a 404, never a 403, so
   * the endpoint is not an existence oracle over someone else's codes.
   */
  revoke(userId: string, code: string, reason: string, at: Date): Promise<CertificateRow | null>
  /** The DP §4.4 operator-error path: the row survived, its object did not, and it was re-rendered. */
  markRegenerated(args: {
    id: string
    documentSha256: string
    byteSize: number
    at: Date
  }): Promise<void>
  findHolder(userId: string): Promise<CertificateHolder | null>
}

// ---- service ------------------------------------------------------------------------------------

export interface CertificateServiceDeps {
  repo: CertificateRepository
  /** The ledger read lives on the volunteer-hours repo; this service owns only the certificate rows. */
  hours: Pick<VolunteerHoursRepository, "entriesForCertificate">
  storage: CertificateStorage
  /** Printed and QR-encoded on every document; the deployment's own web origin, so staging never points at production. */
  verifyBaseUrl?: string
  now?: () => Date
  newId?: () => string
  /** Injected in tests to force the code-collision retry. */
  mintCode?: () => string
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface CertificateService {
  issue(userId: string, locale?: string): Promise<IssueServiceHoursCertificateResponse>
  list(userId: string): Promise<ListMyCertificatesResponse>
  revoke(userId: string, code: string): Promise<RevokeCertificateResponse>
  verify(code: string): Promise<VerifyCertificateResponse>
}

/**
 * `certificates/service-hours/{YYYY}/{MM}/{id}.pdf` (C16), in the EXISTING media bucket (B41b — no new
 * env var, which is DL R13's rule). The `{id}` segment is the row's `gen_random_uuid()` and is NEVER
 * disclosed by the public verify endpoint, so even `<R2_PUBLIC_BASE>/<key>` is unguessable — the same
 * defence-in-depth posture as `buildR2Key(uploadId, now)` in media-intake-service.ts.
 */
export function certificateObjectKey(id: string, issuedAt: Date): string {
  const year = issuedAt.getUTCFullYear().toString().padStart(4, "0")
  const month = (issuedAt.getUTCMonth() + 1).toString().padStart(2, "0")
  return `certificates/service-hours/${year}/${month}/${id}.pdf`
}

/**
 * `inline`, NOT `attachment` (C17). On web the holder opens the URL in a new tab: `attachment` fires a
 * download and leaves an empty orphan tab behind, while `inline` renders in the browser's own PDF viewer,
 * which already offers Download and Print. On mobile it is what makes Safari/Chrome show the document
 * with a Share affordance.
 */
export function certificateContentDisposition(code: string): string {
  return `inline; filename="civfix-service-hours-${formatCertificateCode(code)}.pdf"`
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** The ledger row shape the pure model consumes, from the repo's join-hydrated view. */
function toLedgerRow(view: VolunteerHoursEntryView): TranscriptLedgerRow {
  return {
    id: view.id,
    source: view.source,
    hours: view.hours,
    occurredAt: view.occurredAt,
    eventTitle: view.cleanupTitle,
    eventReferenceCode: view.cleanupReferenceCode,
    // The ledger read does not join `reports` — a public list of every report a user filed is a privacy
    // leak, and the transcript deliberately names no report (certificate-model.activityLabel prints the
    // localized "Verified report" label, whose {{ref}} is simply empty here).
    reportReferenceCode: null,
    jurisdictionName: view.jurisdictionName,
    creditedByName: view.creditedBy?.name ?? null,
  }
}

export function makeCertificateService(deps: CertificateServiceDeps): CertificateService {
  const { repo, hours, storage } = deps
  const now = (): Date => deps.now?.() ?? new Date()
  const newId = (): string => deps.newId?.() ?? randomUUID()
  const mintCode = (): string => deps.mintCode?.() ?? generateCertificateCode()

  function presign(key: string): Promise<string> {
    // H9: `forceSigned` is load-bearing, not decoration. See the CertificateStorage doc comment.
    return storage.presignGet(key, CERTIFICATE_GET_URL_TTL_SEC, { forceSigned: true })
  }

  /**
   * Object deletion is always best-effort: an orphaned 40 KB PDF is a rounding error, while a throw here
   * would fail a request whose DB write already succeeded (revoke) or already lost a race (the loser of
   * two simultaneous issues).
   */
  async function bestEffortDelete(key: string, context: string): Promise<void> {
    try {
      await storage.delete(key)
    } catch (err) {
      deps.logger?.warn({ err, key, context }, "certificate object delete failed")
    }
  }

  function toCertificateDTO(
    row: CertificateRow,
    url: string | null,
    at: Date,
  ): ServiceHoursCertificateDTO {
    return {
      code: row.code,
      status: row.revokedAt !== null ? "revoked" : "valid",
      locale: row.locale,
      issuedAt: row.issuedAt.toISOString(),
      totalHours: row.totalHours,
      entryCount: row.entryCount,
      periodStart: row.periodStart?.toISOString() ?? null,
      periodEnd: row.periodEnd?.toISOString() ?? null,
      documentSha256: row.documentSha256,
      byteSize: row.byteSize,
      url,
      urlExpiresAt:
        url !== null
          ? new Date(at.getTime() + CERTIFICATE_GET_URL_TTL_SEC * 1000).toISOString()
          : null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    }
  }

  async function issue(
    userId: string,
    requestedLocale?: string,
  ): Promise<IssueServiceHoursCertificateResponse> {
    const at = now()
    const holder = await repo.findHolder(userId)
    // Only reachable for a session whose user row is gone/tombstoned; 404 rather than 500.
    if (holder === null) throw AppError.notFound()

    const locale = resolveLocale(requestedLocale ?? holder.locale)

    // v1 issues over the WHOLE ledger: no geoid / from / to filters (C2). `entryCount` is the full
    // matching count; `totalHours` is the sum of the RETURNED rows (B40b — a printed total that does not
    // equal the sum of the printed lines is a self-contradicting document).
    const page = await hours.entriesForCertificate({
      userId,
      geoid: null,
      from: null,
      to: null,
      limit: MAX_CERTIFICATE_ENTRIES,
    })
    if (page.items.length === 0) {
      // Refuse to mint an empty official-looking document. 409, not 422: the request is well-formed and
      // becomes valid the moment the holder has any credited hours.
      throw AppError.conflict(certificateTranslator(locale)("certificate.error.no_hours"))
    }

    const model = buildTranscriptModel({
      holder: {
        userId,
        displayName: holder.displayName,
        handle: holder.handle,
      },
      rows: page.items.map(toLedgerRow),
      totals: { entryCount: page.entryCount, totalHours: page.totalHours },
      locale,
    })
    const fingerprint = ledgerFingerprint(model)

    const existing = await repo.findLiveByFingerprint(userId, fingerprint)
    if (existing !== null) {
      const head = await storage.head(existing.r2Key)
      if (head !== null) {
        // The common repeat call renders NOTHING: a row lookup, a HEAD and a presign (DP §4.1).
        return {
          certificate: toCertificateDTO(existing, await presign(existing.r2Key), at),
          reused: true,
        }
      }
      // DP §4.4, expected to be exercised approximately never (operator error / a bucket incident). The
      // row is the record of truth, so re-render THIS document — same code, same issue date, same key —
      // rather than minting a second certificate over the same ledger, which the partial unique index
      // would reject anyway. The model rebuilt above has the same fingerprint as the stored snapshot, so
      // it is used directly instead of detoasting `snapshot` on a path that is otherwise free.
      const bytes = await buildServiceHoursPdf({
        model,
        code: existing.code,
        issuedAt: existing.issuedAt,
        fingerprint,
        ...(deps.verifyBaseUrl !== undefined ? { verifyBaseUrl: deps.verifyBaseUrl } : {}),
      })
      const documentSha256 = sha256Hex(bytes)
      await storage.put(existing.r2Key, bytes, {
        contentType: "application/pdf",
        contentDisposition: certificateContentDisposition(existing.code),
      })
      await repo.markRegenerated({
        id: existing.id,
        documentSha256,
        byteSize: bytes.byteLength,
        at,
      })
      deps.logger?.warn(
        { certificateId: existing.id, r2Key: existing.r2Key },
        "certificate object missing for a live row; re-rendered from the ledger",
      )
      return {
        certificate: toCertificateDTO(
          { ...existing, documentSha256, byteSize: bytes.byteLength, regeneratedAt: at },
          await presign(existing.r2Key),
          at,
        ),
        reused: true,
      }
    }

    const id = newId()
    const r2Key = certificateObjectKey(id, at)

    for (let attempt = 0; attempt < CERTIFICATE_CODE_MINT_ATTEMPTS; attempt++) {
      // The code is PRINTED on the document, so a re-mint must re-render. The key is derived from the
      // row id, which does not change across attempts, so the re-put overwrites rather than orphaning.
      const code = mintCode()
      const bytes = await buildServiceHoursPdf({
        model,
        code,
        issuedAt: at,
        fingerprint,
        ...(deps.verifyBaseUrl !== undefined ? { verifyBaseUrl: deps.verifyBaseUrl } : {}),
      })
      const documentSha256 = sha256Hex(bytes)
      await storage.put(r2Key, bytes, {
        contentType: "application/pdf",
        contentDisposition: certificateContentDisposition(code),
      })

      try {
        const row = await repo.insert({
          id,
          userId,
          code,
          locale,
          holderName: holder.displayName,
          holderHandle: holder.handle,
          holderVerified: false,
          totalHours: model.totalHours,
          entryCount: model.entryCount,
          periodStart: model.periodStart !== null ? new Date(model.periodStart) : null,
          periodEnd: model.periodEnd !== null ? new Date(model.periodEnd) : null,
          ledgerFingerprint: fingerprint,
          snapshot: model,
          r2Key,
          documentSha256,
          byteSize: bytes.byteLength,
          issuedAt: at,
        })
        return { certificate: toCertificateDTO(row, await presign(r2Key), at), reused: false }
      } catch (err) {
        if (err instanceof CertificateConflictError && err.kind === "code") continue

        if (err instanceof CertificateConflictError && err.kind === "fingerprint") {
          // Two simultaneous taps. This branch is what makes them safe WITHOUT a lock, on the house
          // "let the unique index arbitrate, then re-read" idiom: re-read the winner, drop the loser's
          // object, and hand back the winner's document so both taps see one certificate with one code.
          const winner = await repo.findLiveByFingerprint(userId, fingerprint)
          await bestEffortDelete(r2Key, "issue-race-loser")
          if (winner === null) throw err
          return {
            certificate: toCertificateDTO(winner, await presign(winner.r2Key), at),
            reused: true,
          }
        }

        await bestEffortDelete(r2Key, "issue-failed")
        throw err
      }
    }

    await bestEffortDelete(r2Key, "code-mint-exhausted")
    // Unreachable at 2^60 unless the RNG is broken, which is exactly what this says.
    throw AppError.internal("Could not mint a unique certificate code")
  }

  async function list(userId: string): Promise<ListMyCertificatesResponse> {
    const at = now()
    const rows = await repo.listFor(userId)
    // No `url` here, deliberately: presigning every row would fan out N signings on a list read, and the
    // URL is short-lived anyway. The holder gets a fresh one by POSTing again, which the fingerprint
    // reuse path answers without rendering.
    return { certificates: rows.map((row) => toCertificateDTO(row, null, at)) }
  }

  async function revoke(userId: string, code: string): Promise<RevokeCertificateResponse> {
    const at = now()
    const row = await repo.revoke(userId, code, "holder", at)
    // Someone else's code is 404, NOT 403 — a 403 would confirm that the code exists (the existence-oracle
    // rule documented in media.routes.ts).
    if (row === null) throw AppError.notFound()
    await bestEffortDelete(row.r2Key, "revoke")
    return { certificate: toCertificateDTO(row, null, at) }
  }

  async function verify(code: string): Promise<VerifyCertificateResponse> {
    const row = await repo.findByCode(code)
    if (row === null) throw AppError.notFound()

    /**
     * Everything below is already printed on the document the verifier is holding.
     *
     * NEVER add `userId`, an email, `r2Key`, a URL of any kind, the per-entry rows or `snapshot`. Anyone
     * with the code already has the document; turning the code into a download link would make a leaked
     * code far more damaging than a leaked page.
     *
     * `jurisdictionNames` is deliberately OMITTED even though the contract allows it: the only source is
     * the ~200 KB TOASTed `snapshot`, and no verification read may detoast that (DP §4.5). The field is
     * `.optional()`, so an absent value parses cleanly on every client.
     *
     * `showVolunteerHours` does NOT gate this (C2/DB B32c). That flag governs the public PROFILE
     * projection — a surface the holder never explicitly shared. A certificate is a document the holder
     * deliberately handed to a verifier, and conflating the two would break every already-issued
     * transcript the moment someone toggled a profile switch. Revocation is the control, and it exists.
     */
    const facts = {
      code: row.code,
      issuedAt: row.issuedAt.toISOString(),
      totalHours: row.totalHours,
      entryCount: row.entryCount,
      periodStart: row.periodStart?.toISOString() ?? null,
      periodEnd: row.periodEnd?.toISOString() ?? null,
      documentSha256: row.documentSha256,
    }

    if (row.holderDeleted) {
      // A tombstoned holder (docs/erasure-behavior.md). The document stops being good, and the identity
      // fields are omitted entirely rather than echoing a name the account has erased — which is now
      // belt-and-braces, because erasure also BLANKS `holder_name`/`holder_handle`/`snapshot` on the row
      // (softDeleteAndAnonymize) and deletes the object.
      return {
        ...facts,
        status: "revoked",
        // Erasure stamps `revoked_at` (reason `account_closed`), so this is normally the closure time —
        // or the holder's own earlier revocation, which COALESCE preserves. It stays NULLABLE for rows
        // tombstoned before that scrub existed: this projection does not read `users.deleted_at`'s
        // timestamp, and inventing one (e.g. echoing issuedAt) would put a false date in front of a
        // verifier.
        revokedAt: row.revokedAt?.toISOString() ?? null,
        // Hardcoded rather than echoing `row.revokedReason`: the tombstone is the authoritative answer
        // even for a row the holder had already revoked for their own reason.
        revokedReason: "account_closed",
      }
    }

    const identity = {
      holderName: row.holderName,
      holderHandle: row.holderHandle,
      verifiedHolder: row.holderVerified,
    }

    if (row.revokedAt !== null) {
      // Revoked keeps holderName + issuedAt on purpose: the person holding the paper learns WHY it is not
      // good. That is a mild oracle over a 60-bit secret and is worth the clarity (DP §5.3).
      return {
        ...facts,
        ...identity,
        status: "revoked",
        revokedAt: row.revokedAt.toISOString(),
        revokedReason: row.revokedReason,
      }
    }

    return { ...facts, ...identity, status: "valid" }
  }

  return { issue, list, revoke, verify }
}
