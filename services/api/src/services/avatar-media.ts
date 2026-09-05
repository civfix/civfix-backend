import { AppError } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { UNBOUND_GRACE_MS } from "./media-authorization.js"

export interface AvatarMediaRef {
  id: string
  r2Key: string
}

export interface AvatarClaimant {
  userId?: string | undefined
  groupId?: string | undefined
}

export const AVATAR_CLAIM_WINDOW_SECONDS = UNBOUND_GRACE_MS / 1000

export async function resolveAvatarMediaOrThrow(
  sql: Sql,
  uploadId: string,
  claimant: AvatarClaimant = {},
): Promise<AvatarMediaRef> {
  const claimantUserId = claimant.userId ?? null
  const claimantGroupId = claimant.groupId ?? null
  const rows = await sql<{ id: string; r2_key: string }[]>`
    SELECT m.id, m.served_key AS r2_key
    FROM media_assets m
    WHERE m.upload_id = ${uploadId}
      AND m.status = 'ready'
      AND m.served_key IS NOT NULL
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
