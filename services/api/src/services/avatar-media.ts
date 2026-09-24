import { AppError } from "@civfix/shared"
import type { Queryable } from "../db/client.js"
import { UNBOUND_GRACE_MS } from "./media-authorization.js"

export interface AvatarMediaRef {
  id: string
  r2Key: string
  servedKey: string | null
}

export interface AvatarClaimant {
  uploader: string
  userId?: string | undefined
  groupId?: string | undefined
}

export interface AvatarMediaRow extends Record<string, unknown> {
  id: string
  r2_key: string
  served_key: string | null
}

const MS_PER_SECOND = 1000
const AVATAR_CLAIM_WINDOW_SECONDS = UNBOUND_GRACE_MS / MS_PER_SECOND

type SqlTemplateTag<Q> = (strings: TemplateStringsArray, ...values: (string | number | null)[]) => Q

// Written against a bare template tag so the profile update can run it through drizzle's sql inside the
// same transaction that writes users.avatar_media_id. FOR UPDATE holds the media row until that write
// commits, so a report, post or chat claim waiting on the row then sees the avatar binding, and a claim
// that committed first leaves a row this query no longer matches.
export function avatarClaimQuery<Q>(
  tag: SqlTemplateTag<Q>,
  uploadId: string,
  claimant: AvatarClaimant,
): Q {
  const claimantUserId = claimant.userId ?? null
  const claimantGroupId = claimant.groupId ?? null
  return tag`
    SELECT m.id, COALESCE(m.served_key, m.r2_key) AS r2_key, m.served_key
    FROM media_assets m
    WHERE m.upload_id = ${uploadId}
      AND (
        (m.status = 'ready' AND m.served_key IS NOT NULL)
        OR (m.status = 'validating' AND m.finalized_at IS NOT NULL)
      )
      AND m.kind = 'image'
      AND m.purpose = 'report'
      AND m.report_id IS NULL
      AND m.post_id IS NULL
      AND m.chat_message_id IS NULL
      AND m.created_at > now() - make_interval(secs => ${AVATAR_CLAIM_WINDOW_SECONDS})
      AND (m.uploader = ${claimant.uploader} OR m.uploader IS NULL)
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
    FOR UPDATE OF m
  `
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
  const rows = await avatarClaimQuery(
    (strings, ...values) => sql<AvatarMediaRow[]>(strings, ...values),
    uploadId,
    claimant,
  )
  return avatarMediaRefOrThrow(rows)
}
