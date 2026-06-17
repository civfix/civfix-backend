/**
 * Verification service: the citizen half of document-verification ("verified neighbor").
 *
 * A signed-in user applies by uploading free-form supporting document images (via the existing media
 * presign/finalize pipeline) + an optional note; the application upserts a `user_verification` row to
 * 'pending'. An operator approves/rejects it in the admin user section (see admin/verification-service).
 * Verification is a cosmetic trust signal: approval changes NO role.
 *
 * All DB access sits behind the VerificationRepository seam (Drizzle impl in
 * verification-repository.drizzle.ts), mirroring the social/cleanups pattern so the service is
 * unit-testable with no database. The document images are tagged purpose='verification' on apply so the
 * public GET /media/:id path refuses them (media-intake-service guard); the bytes are reachable only via
 * the owner / admin signed-URL routes.
 */

import type { MyVerificationDTO, VerificationDocument } from "@civfix/shared"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** The stored (post-application) verification states. 'unverified' is the ABSENCE of a record. */
export type VerificationStoredStatus = "pending" | "verified" | "rejected"

/** A user_verification row projected into the service record (documents parsed from jsonb). */
export interface VerificationRecord {
  status: VerificationStoredStatus
  note: string | null
  documents: VerificationDocument[]
  rejectionReason: string | null
  appliedAt: Date | null
  reviewedAt: Date | null
}

export interface VerificationRepository {
  /** The user's verification record, or null when they have never applied (= "unverified"). */
  getByUserId(userId: string): Promise<VerificationRecord | null>
  /**
   * Apply: resolve the finalized upload ids to image media rows, tag them purpose='verification', and
   * upsert the user_verification row to 'pending' with the documents + note (replacing any prior
   * application — a re-apply after rejection). Returns the new record. Throws VALIDATION when an upload id
   * is unknown / not an image.
   */
  apply(userId: string, uploadIds: string[], note: string | null): Promise<VerificationRecord>
  /**
   * The r2 object key for ONE of this user's own verification documents, or null when the media is not
   * theirs / not a verification document. Used to mint an owner-scoped signed GET URL.
   */
  getDocumentKey(userId: string, mediaId: string): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

/** Project a stored record (or its absence) into the wire MyVerificationDTO. */
export function toMyVerificationDTO(record: VerificationRecord | null): MyVerificationDTO {
  if (!record) return { status: "unverified", documents: [] }
  return {
    status: record.status,
    note: record.note,
    documents: record.documents,
    appliedAt: record.appliedAt ? record.appliedAt.toISOString() : null,
    reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    rejectionReason: record.rejectionReason,
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface VerificationServiceDeps {
  repo: VerificationRepository
  /** Presign an object key into a short-lived GET URL (wraps the Storage seam). */
  presignGet: (r2Key: string) => Promise<string>
}

export interface VerificationService {
  getMine(userId: string): Promise<MyVerificationDTO>
  apply(userId: string, uploadIds: string[], note: string | null): Promise<MyVerificationDTO>
  /** A short-lived signed GET URL for one of the user's OWN verification documents (404 when not theirs). */
  documentUrl(userId: string, mediaId: string): Promise<string | null>
}

export function makeVerificationService(deps: VerificationServiceDeps): VerificationService {
  return {
    async getMine(userId: string): Promise<MyVerificationDTO> {
      return toMyVerificationDTO(await deps.repo.getByUserId(userId))
    },

    async apply(
      userId: string,
      uploadIds: string[],
      note: string | null,
    ): Promise<MyVerificationDTO> {
      return toMyVerificationDTO(await deps.repo.apply(userId, uploadIds, note))
    },

    async documentUrl(userId: string, mediaId: string): Promise<string | null> {
      const key = await deps.repo.getDocumentKey(userId, mediaId)
      if (key === null) return null
      return deps.presignGet(key)
    },
  }
}
