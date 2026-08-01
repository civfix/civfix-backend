import { AppError } from "@civfix/shared"
import type { Sql } from "../db/client.js"

export interface AvatarMediaRef {
  id: string
  r2Key: string
}

export async function resolveAvatarMediaOrThrow(
  sql: Sql,
  uploadId: string,
): Promise<AvatarMediaRef> {
  const rows = await sql<{ id: string; r2_key: string }[]>`
    SELECT id, r2_key
    FROM media_assets
    WHERE upload_id = ${uploadId}
      AND status = 'ready'
      AND kind = 'image'
      AND report_id IS NULL
      AND post_id IS NULL
      AND chat_message_id IS NULL
    LIMIT 1
  `
  const row = rows[0]
  if (!row) {
    throw AppError.validation({ avatarUploadId: "That image is unavailable." })
  }
  return { id: row.id, r2Key: row.r2_key }
}
