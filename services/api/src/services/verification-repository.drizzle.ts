/**
 * Postgres-backed VerificationRepository (the production impl of the verification persistence seam).
 *
 * Written against the raw postgres-js tag (`Sql`) like the rest of the backend. apply() runs in ONE
 * transaction: it tags the submitted media rows purpose='verification' (isolating them from the public
 * media path) and upserts the user_verification row to 'pending' atomically, so a partial failure never
 * leaves verification-tagged media with no pending application (or vice versa).
 */

import { AppError } from "@civfix/shared"
import type { VerificationDocument } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type {
  VerificationRecord,
  VerificationRepository,
  VerificationStoredStatus,
} from "./verification-service.js"

/** Shape of a user_verification row as selected back. */
interface VerificationRowSelect {
  status: VerificationStoredStatus
  note: string | null
  documents: VerificationDocument[] | null
  rejection_reason: string | null
  applied_at: Date | null
  reviewed_at: Date | null
}

function toRecord(r: VerificationRowSelect): VerificationRecord {
  return {
    status: r.status,
    note: r.note,
    documents: Array.isArray(r.documents) ? r.documents : [],
    rejectionReason: r.rejection_reason,
    appliedAt: r.applied_at,
    reviewedAt: r.reviewed_at,
  }
}

export function makeDrizzleVerificationRepository(sql: Sql): VerificationRepository {
  return {
    async getByUserId(userId: string): Promise<VerificationRecord | null> {
      const rows = await sql<VerificationRowSelect[]>`
        SELECT status, note, documents, rejection_reason, applied_at, reviewed_at
        FROM user_verification
        WHERE user_id = ${userId}
        LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async apply(
      userId: string,
      uploadIds: string[],
      note: string | null,
    ): Promise<VerificationRecord> {
      return sql.begin(async (tx) => {
        // 1) Tag the submitted (finalized) image media as verification documents. Possessing the upload id
        //    is the capability proof (media has no owner column pre-attach, like the report flow). Only
        //    'image' kind is accepted (documents are photographed). Every requested id MUST resolve, else
        //    the apply is a clean 422 rather than a partial application.
        const media = await tx<{ id: string }[]>`
          UPDATE media_assets
          SET purpose = 'verification'
          WHERE upload_id = ANY(${uploadIds}::uuid[]) AND kind = 'image'
          RETURNING id
        `
        if (media.length !== uploadIds.length) {
          throw AppError.validation({
            uploadIds: "one or more documents could not be attached (unknown or not an image)",
          })
        }
        const documents: VerificationDocument[] = media.map((m) => ({
          mediaId: m.id,
          status: "pending",
        }))

        // 2) Upsert the user_verification row back to 'pending', replacing any prior application (re-apply
        //    after a rejection) and clearing the prior decision fields.
        const rows = await tx<VerificationRowSelect[]>`
          INSERT INTO user_verification (user_id, status, note, documents, applied_at, updated_at)
          VALUES (${userId}, 'pending', ${note}, ${tx.json(documents)}, now(), now())
          ON CONFLICT (user_id) DO UPDATE SET
            status = 'pending',
            note = EXCLUDED.note,
            documents = EXCLUDED.documents,
            rejection_reason = NULL,
            reviewed_by = NULL,
            reviewed_at = NULL,
            applied_at = now(),
            updated_at = now()
          RETURNING status, note, documents, rejection_reason, applied_at, reviewed_at
        `
        const row = rows[0]
        if (!row) throw AppError.internal("verification apply: upsert returned no row")
        return toRecord(row)
      })
    },

    async getDocumentKey(userId: string, mediaId: string): Promise<string | null> {
      // The media must be tagged purpose='verification' AND be referenced by THIS user's application's
      // documents jsonb. The join enforces both ownership + the purpose isolation.
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
