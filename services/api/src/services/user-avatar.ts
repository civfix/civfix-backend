// Every read of a user's avatar resolves here, so the photo is the same everywhere it appears. A ready
// avatar upload wins, as its 400px thumbnail (or the served copy when the worker made no thumbnail);
// otherwise the stored users.avatar_url stands, which keeps OAuth provider pictures working.

import type { Storage } from "@civfix/seams"
import type { Queryable, SqlFragment } from "../db/client.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { MEDIA_GET_URL_TTL_SEC } from "./media-intake-service.js"
import { PRESIGN_CONCURRENCY } from "./media-presign.js"
import type { MediaAlias } from "./media-served-key.js"

export interface AvatarMedia {
  status: string
  servedKey: string | null
  thumbKey: string | null
}

export interface UserAvatarSource {
  avatarUrl: string | null
  avatarMedia: AvatarMedia | null
}

export type AvatarPresigner = (key: string) => Promise<string>

interface AvatarColumnFields {
  avatar_url: string | null
  avatar_media_status: string | null
  avatar_served_key: string | null
  avatar_thumb_key: string | null
}

// A row that carries several users (an invite's invitee and inviter) names each one's columns with a prefix.
export type UserAvatarColumns<P extends string = ""> = {
  [K in keyof AvatarColumnFields as `${P}${K}`]: AvatarColumnFields[K]
}

type AvatarMediaAlias = MediaAlias | "uam" | "iam" | "bam"

export function avatarPresigner(storage: Pick<Storage, "presignGet">): AvatarPresigner {
  return (key) => storage.presignGet(key, MEDIA_GET_URL_TTL_SEC)
}

// Until the worker marks the media ready, its keys may point at the uploader's unchecked bytes, so only a
// ready asset is ever presigned.
export async function resolveUserAvatarUrl(
  presign: AvatarPresigner,
  user: UserAvatarSource,
): Promise<string | null> {
  const media = user.avatarMedia
  const key = media?.status === "ready" ? (media.thumbKey ?? media.servedKey) : null
  return key !== null ? presign(key) : user.avatarUrl
}

// The query must LEFT JOIN media_assets as mediaAlias on users.avatar_media_id.
export function userAvatarColumns(
  sql: Queryable,
  userAlias: string,
  mediaAlias: AvatarMediaAlias,
  prefix = "",
): SqlFragment {
  return sql`
    ${sql(userAlias)}.avatar_url AS ${sql(`${prefix}avatar_url`)},
    ${sql(mediaAlias)}.status AS ${sql(`${prefix}avatar_media_status`)},
    ${sql(mediaAlias)}.served_key AS ${sql(`${prefix}avatar_served_key`)},
    ${sql(mediaAlias)}.thumb_key AS ${sql(`${prefix}avatar_thumb_key`)}
  `
}

export function userAvatarSource<P extends string = "">(
  row: UserAvatarColumns<P>,
  prefix: P = "" as P,
): UserAvatarSource {
  const col = row as unknown as Record<string, string | null>
  const status = col[`${prefix}avatar_media_status`] ?? null
  return {
    avatarUrl: col[`${prefix}avatar_url`] ?? null,
    avatarMedia:
      status === null
        ? null
        : {
            status,
            servedKey: col[`${prefix}avatar_served_key`] ?? null,
            thumbKey: col[`${prefix}avatar_thumb_key`] ?? null,
          },
  }
}

// Writes the resolved URL over each row's stored `${prefix}avatar_url`, in place, so a row mapper written
// against the column shows the resolved avatar as it is. A repository built without a presigner keeps the
// stored URL.
export async function resolveAvatarColumns<P extends string = "">(
  presign: AvatarPresigner | undefined,
  rows: readonly UserAvatarColumns<P>[],
  prefixes: readonly P[] = ["" as P],
): Promise<void> {
  if (presign === undefined) return
  await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (row) => {
    const columns = row as unknown as Record<string, string | null>
    for (const prefix of prefixes) {
      columns[`${prefix}avatar_url`] = await resolveUserAvatarUrl(
        presign,
        userAvatarSource(row, prefix),
      )
    }
  })
}
