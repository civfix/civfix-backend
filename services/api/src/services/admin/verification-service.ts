/**
 * Admin verification service (the operator half of document-verification).
 *
 * Mirrors the gov-claims review surface: an operator reviews the documents a user uploaded and either
 * APPROVES (sets the user's verification status to 'verified' — NO role change) or REJECTS (with a
 * reason). The queue is fed by `user_verification` rows (keyed by user id). All transitions are audited
 * via writeAudit inside the repo transaction (the "did + recorded" atomicity invariant).
 *
 * REPOSITORY SEAM: every read/write goes through AdminVerificationRepository (Drizzle impl in
 * verification-repository.drizzle.ts). The document images are served via short-lived signed URLs minted
 * from the storage seam; they are never exposed on the public media path.
 */

import { AppError } from "@civfix/shared"
import type {
  AdminVerificationDTO,
  AdminVerificationListQuery,
  AdminVerificationListResponse,
  VerificationDocument,
  VerificationStatus,
} from "@civfix/shared"
import { clampLimit } from "./pagination.js"

/** The stored (post-application) statuses. 'unverified' is the ABSENCE of a row and never appears here. */
export type StoredVerificationStatus = Exclude<VerificationStatus, "unverified">

/** Filter facet for the queue (mirrors the shared AdminVerificationListQuery filter). */
export type AdminVerificationFilter = "all" | StoredVerificationStatus

/** A user_verification row + the applicant's identity, projected into the service record. */
export interface AdminVerificationRecord {
  userId: string
  userName: string
  handle: string | null
  status: StoredVerificationStatus
  note: string | null
  documents: VerificationDocument[]
  rejectionReason: string | null
  reviewedBy: string | null
  appliedAt: Date
  reviewedAt: Date | null
}

/** Normalized list arguments the repo consumes. */
export interface ListVerificationsArgs {
  q: string | null
  filter: AdminVerificationFilter
  cursor: string | null
  limit: number
}

export interface AdminVerificationRepository {
  /** Page verification requests (search + status facet), keyset paged by (applied_at DESC, user_id DESC). */
  list(
    args: ListVerificationsArgs,
  ): Promise<{ records: AdminVerificationRecord[]; nextCursor: string | null }>
  /** Load one user's verification request, or null when they have never applied. */
  get(userId: string): Promise<AdminVerificationRecord | null>
  /** Approve: status='verified' + reviewer/time, audited. Returns the updated record (null if absent). */
  approve(
    userId: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<AdminVerificationRecord | null>
  /** Reject: status='rejected' + reason + reviewer/time, audited. Returns the updated record (null if absent). */
  reject(
    userId: string,
    input: { actorId: string | null; reason: string },
  ): Promise<AdminVerificationRecord | null>
  /** The r2 object key for one of a user's verification documents, or null when not theirs / not found. */
  getDocumentKey(userId: string, mediaId: string): Promise<string | null>
}

export interface AdminVerificationServiceDeps {
  repo: AdminVerificationRepository
  /** Presign an object key into a short-lived GET URL (wraps the Storage seam). */
  presignGet: (r2Key: string) => Promise<string>
}

export interface AdminVerificationService {
  list(query: AdminVerificationListQuery): Promise<AdminVerificationListResponse>
  get(userId: string): Promise<AdminVerificationDTO>
  approve(userId: string, input: { actorId: string | null; note: string | null }): Promise<void>
  reject(userId: string, input: { actorId: string | null; reason: string }): Promise<void>
  /** A short-lived signed GET URL for one of the applicant's documents (null when not found). */
  documentUrl(userId: string, mediaId: string): Promise<string | null>
}

/** Project a record into the wire DTO. Timestamps as ISO strings; the admin UI formats them. */
export function toAdminVerificationDTO(record: AdminVerificationRecord): AdminVerificationDTO {
  return {
    userId: record.userId,
    userName: record.userName,
    handle: record.handle,
    status: record.status,
    note: record.note,
    documents: record.documents,
    appliedAt: record.appliedAt.toISOString(),
    reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    reviewedBy: record.reviewedBy,
    rejectionReason: record.rejectionReason,
  }
}

export function makeAdminVerificationService(
  deps: AdminVerificationServiceDeps,
): AdminVerificationService {
  return {
    async list(query: AdminVerificationListQuery): Promise<AdminVerificationListResponse> {
      const args: ListVerificationsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: (query.filter ?? "all") as AdminVerificationFilter,
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const { records, nextCursor } = await deps.repo.list(args)
      return { items: records.map(toAdminVerificationDTO), nextCursor }
    },

    async get(userId: string): Promise<AdminVerificationDTO> {
      const record = await deps.repo.get(userId)
      if (!record) throw AppError.notFound("Verification request not found")
      return toAdminVerificationDTO(record)
    },

    async approve(
      userId: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<void> {
      const updated = await deps.repo.approve(userId, input)
      if (!updated) throw AppError.notFound("Verification request not found")
    },

    async reject(
      userId: string,
      input: { actorId: string | null; reason: string },
    ): Promise<void> {
      const updated = await deps.repo.reject(userId, input)
      if (!updated) throw AppError.notFound("Verification request not found")
    },

    async documentUrl(userId: string, mediaId: string): Promise<string | null> {
      const key = await deps.repo.getDocumentKey(userId, mediaId)
      if (key === null) return null
      return deps.presignGet(key)
    },
  }
}
