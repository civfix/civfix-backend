import type { Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/contract"
import type { UserSearchResultDTO } from "@civfix/contract"
import { likeContains, likePrefix } from "../db/like.js"
import type { UserSearchRepository } from "./user-search-repository.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { PRESIGN_CONCURRENCY } from "./media-presign.js"
import {
  resolveUserAvatarUrl,
  userAvatarColumns,
  userAvatarSource,
  type AvatarPresigner,
  type UserAvatarColumns,
} from "./user-avatar.js"

interface UserSearchRow extends UserAvatarColumns {
  id: string
  handle: string
  display_name: string
}

export function makeDrizzleUserSearchRepository(
  sql: Sql,
  presignAvatar: AvatarPresigner,
): UserSearchRepository {
  function toSearchResults(rows: UserSearchRow[]): Promise<UserSearchResultDTO[]> {
    return mapWithLimit(rows, PRESIGN_CONCURRENCY, async (r) => {
      const avatarUrl = await resolveUserAvatarUrl(presignAvatar, userAvatarSource(r))
      return {
        id: r.id,
        handle: r.handle,
        displayName: r.display_name,
        avatar: avatarGradient(r.id),
        ...(avatarUrl !== null ? { avatarUrl } : {}),
      }
    })
  }

  return {
    // Locked product rule: DM search never surfaces the viewer, deleted or handle-less users, accounts with
    // DMs turned off, or anyone blocked in either direction. The result shape carries no email, bio or
    // follower counts. The route has already stripped a leading `@` from `q`.
    async searchByHandlePrefix(
      q: string,
      viewerId: string,
      limit: number,
    ): Promise<UserSearchResultDTO[]> {
      const prefix = likePrefix(q)
      const rows = await sql<UserSearchRow[]>`
        SELECT u.id, u.handle, u.display_name, ${userAvatarColumns(sql, "u", "am")}
        FROM users u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        WHERE u.deleted_at IS NULL
          AND u.handle IS NOT NULL
          AND u.allow_direct_messages = true
          AND u.id <> ${viewerId}
          -- handle is CITEXT; cast to text so the per-keystroke @handle prefix search can use the
          -- gin_trgm_ops expression index users_handle_trgm on (handle::text) (0014_search_trgm.sql).
          AND (u.handle::text) ILIKE ${prefix} ESCAPE '\\'
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
          )
        ORDER BY u.handle ASC
        LIMIT ${limit}
      `
      return toSearchResults(rows)
    },

    // Keeps DM-disabled accounts (anyone is taggable) but, like DM search, never suggests a user blocked in
    // either direction. A hand-typed @handle for a blocked user still resolves; the mention notification is
    // block-gated in the notifiers instead.
    async searchMentionable(
      q: string,
      viewerId: string,
      limit: number,
    ): Promise<UserSearchResultDTO[]> {
      const term = likeContains(q)
      const rows = await sql<UserSearchRow[]>`
        SELECT u.id, u.handle, u.display_name, ${userAvatarColumns(sql, "u", "am")}
        FROM users u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        WHERE u.deleted_at IS NULL
          AND u.handle IS NOT NULL
          AND u.id <> ${viewerId}
          -- handle is CITEXT; cast to text so the gin_trgm_ops expression index users_handle_trgm on
          -- (handle::text) (0014_search_trgm.sql) can serve the substring ILIKE.
          AND ((u.handle::text) ILIKE ${term} ESCAPE '\\' OR u.display_name ILIKE ${term} ESCAPE '\\')
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
          )
        ORDER BY u.handle ASC, u.display_name ASC
        LIMIT ${limit}
      `
      return toSearchResults(rows)
    },
  }
}
