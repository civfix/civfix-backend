// Every read of a user's avatar resolves here, so the photo is the same everywhere it appears. A ready
// avatar upload wins, as its 400px thumbnail (or the served copy when the worker made no thumbnail);
// otherwise the stored users.avatar_url stands, which keeps OAuth provider pictures working.

import type { Storage } from "@civfix/seams"
import type { Queryable, SqlFragment } from "../db/client.js"
import { MEDIA_GET_URL_TTL_SEC } from "./media-intake-service.js"
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

export interface UserAvatarColumns {
  avatar_url: string | null
  avatar_media_status: string | null
  avatar_served_key: string | null
  avatar_thumb_key: string | null
}

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
  mediaAlias: MediaAlias,
): SqlFragment {
  return sql`
    ${sql(userAlias)}.avatar_url,
    ${sql(mediaAlias)}.status AS avatar_media_status,
    ${sql(mediaAlias)}.served_key AS avatar_served_key,
    ${sql(mediaAlias)}.thumb_key AS avatar_thumb_key
  `
}

export function userAvatarSource(row: UserAvatarColumns): UserAvatarSource {
  return {
    avatarUrl: row.avatar_url,
    avatarMedia:
      row.avatar_media_status === null
        ? null
        : {
            status: row.avatar_media_status,
            servedKey: row.avatar_served_key,
            thumbKey: row.avatar_thumb_key,
          },
  }
}
