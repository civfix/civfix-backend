import { AppError } from "@civfix/shared"
import type { Queryable } from "../db/client.js"
import {
  findClaimableAvatarIn,
  type AvatarClaimant,
  type AvatarMediaRow,
} from "./media-claim-repository.drizzle.js"

export interface AvatarMediaRef {
  id: string
  r2Key: string
  servedKey: string | null
}

export function avatarMediaRefOrThrow(rows: readonly AvatarMediaRow[]): AvatarMediaRef {
  const row = rows[0]
  if (!row) {
    throw AppError.validation({ avatarUploadId: "That image is unavailable." })
  }
  return { id: row.id, r2Key: row.r2_key, servedKey: row.served_key }
}

export async function resolveAvatarMediaOrThrow(
  sql: Queryable,
  uploadId: string,
  claimant: AvatarClaimant,
): Promise<AvatarMediaRef> {
  const rows = await findClaimableAvatarIn(sql, uploadId, claimant)
  return avatarMediaRefOrThrow(rows)
}
