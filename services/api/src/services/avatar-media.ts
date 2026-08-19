import { AppError } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { UNBOUND_GRACE_MS } from "./media-authorization.js"

export interface AvatarMediaRef {
  id: string
  r2Key: string
}

/**
 * The subject about to point at the media row. Supplying it makes a re-apply of the avatar the caller
 * ALREADY owns idempotent (a profile screen that resubmits the same avatarUploadId with an edited bio
 * must not 422) while every OTHER subject is still refused the claimed row.
 */
export interface AvatarClaimant {
  userId?: string | undefined
  groupId?: string | undefined
}

/** The avatar claim window matches the serving side's unbound grace (media-authorization.ts). */
export const AVATAR_CLAIM_WINDOW_SECONDS = UNBOUND_GRACE_MS / 1000

/**
 * Resolve an uploadId to the media row an avatar may point at, or throw.
 *
 * F074: the uploadId is a bearer capability (media_assets has no owner column), so the gate has to be
 * as narrow as every other claim lane:
 *   - purpose = 'report'      — the pipeline's only pre-claim purpose; keeps a verification document
 *                               (whose serving lane is denied outright) from being laundered into a
 *                               publicly-rendered avatar.
 *   - report/post/chat NULL   — unclaimed by the bound lanes (unchanged).
 *   - created_at inside the window — a leaked id expires with the upload instead of staying a
 *                               permanent capability, and matches UNBOUND_GRACE_MS on the serving side.
 *                               A NULL created_at cannot be proven fresh, so it is refused.
 *   - not already an avatar   — claim-once, mirroring message-attachments' "target columns must be
 *                               NULL": without it one id could be pointed at by any number of
 *                               users.avatar_media_id / chat_groups.avatar_media_id rows forever, which
 *                               also rescued the row from the orphan sweep's reverse-binding probes.
 */
export async function resolveAvatarMediaOrThrow(
  sql: Sql,
  uploadId: string,
  claimant: AvatarClaimant = {},
): Promise<AvatarMediaRef> {
  const claimantUserId = claimant.userId ?? null
  const claimantGroupId = claimant.groupId ?? null
  const rows = await sql<{ id: string; r2_key: string }[]>`
    SELECT m.id, m.r2_key
    FROM media_assets m
    WHERE m.upload_id = ${uploadId}
      AND m.status = 'ready'
      AND m.kind = 'image'
      AND m.purpose = 'report'
      AND m.report_id IS NULL
      AND m.post_id IS NULL
      AND m.chat_message_id IS NULL
      AND m.created_at > now() - make_interval(secs => ${AVATAR_CLAIM_WINDOW_SECONDS})
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.avatar_media_id = m.id
          AND (${claimantUserId}::uuid IS NULL OR u.id <> ${claimantUserId}::uuid)
      )
      AND NOT EXISTS (
        SELECT 1 FROM chat_groups g
        WHERE g.avatar_media_id = m.id
          AND (${claimantGroupId}::uuid IS NULL OR g.id <> ${claimantGroupId}::uuid)
      )
    LIMIT 1
  `
  const row = rows[0]
  if (!row) {
    throw AppError.validation({ avatarUploadId: "That image is unavailable." })
  }
  return { id: row.id, r2Key: row.r2_key }
}
