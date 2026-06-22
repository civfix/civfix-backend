/**
 * @handle / display-name search reads for the social domain: the DM-start prefix search and the
 * @-mention typeahead. Split out of social-repository.drizzle.ts (these are free functions over the raw
 * postgres-js tag, a distinct responsibility from the SocialRepository row/follow persistence).
 */

import type { Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/shared"
import type { UserSearchResultDTO } from "@civfix/shared"
import { escapeLike } from "./admin/like.js"

/**
 * @handle PREFIX search for starting a DM (GET /users/search). Returns the minimal, privacy-conscious
 * UserSearchResultDTO (no email/bio/follower counts). Matches `handle ILIKE <prefix>%` case-insensitively
 * (handle is citext) with the prefix escaped so %/_/\ are literal. Exclusions (the locked product rules):
 *   - self (u.id <> viewerId);
 *   - soft-deleted users (deleted_at IS NOT NULL);
 *   - users with NULL handle (not searchable);
 *   - users with allow_direct_messages = false (DM-disabled accounts are hidden from search);
 *   - users blocked either way w.r.t. the viewer (NOT EXISTS over user_blocks in both directions).
 * `q` is the raw query with a leading `@` already stripped by the route. Ordered by handle asc, capped.
 */
export async function searchByHandlePrefix(
  sql: Sql,
  q: string,
  viewerId: string,
  limit: number,
): Promise<UserSearchResultDTO[]> {
  const prefix = escapeLike(q) + "%"
  const rows = await sql<
    { id: string; handle: string; display_name: string; avatar_url: string | null }[]
  >`
    SELECT u.id, u.handle, u.display_name, u.avatar_url
    FROM users u
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
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatar: avatarGradient(r.id),
    ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
  }))
}

/**
 * @handle / display-name search for the @-mention picker (GET /users/mention-search). BROADER than
 * searchByHandlePrefix in that it does NOT exclude DM-disabled accounts (anyone is taggable), but — like
 * searchByHandlePrefix — it DOES exclude users blocked either way (a blocked user should never surface as
 * a suggested mention target). Excludes self + soft-deleted + handle-less users. Matches a substring on
 * handle OR display_name (ILIKE %q%), capped. Returns the SAME UserSearchResultDTO shape searchUsers does.
 * A hand-typed @handle for a blocked user is still resolvable, but the resulting mention BELL is already
 * block-gated in the notifiers.
 */
export async function searchMentionable(
  sql: Sql,
  q: string,
  viewerId: string,
  limit: number,
): Promise<UserSearchResultDTO[]> {
  const term = "%" + escapeLike(q) + "%"
  const rows = await sql<
    { id: string; handle: string; display_name: string; avatar_url: string | null }[]
  >`
    SELECT u.id, u.handle, u.display_name, u.avatar_url
    FROM users u
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
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatar: avatarGradient(r.id),
    ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
  }))
}
