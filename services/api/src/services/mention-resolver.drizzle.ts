/**
 * USER @-mention resolution reads: resolve @handles and explicit user ids to real, mentionable users.
 * Split out of social-repository.drizzle.ts. ANYONE may be named in a comment/chat — blocks + DM-prefs
 * gate only the resulting NOTIFICATION, not who can be tagged — so these reads only exclude the author
 * themselves plus soft-deleted/handle-less rows.
 */

import type { Sql } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"
import { isUuid } from "../db/cursor-helpers.js"

/**
 * Resolve a set of @handles to mentionable users (UserMentionDTO), EXCLUDING the author/self. EXACT
 * (case-insensitive — handle is citext) match against non-deleted, handle-bearing users. Unknown handles
 * are absent. An empty input short-circuits.
 */
export async function resolveHandles(
  sql: Sql,
  handles: string[],
  selfUserId: string,
): Promise<UserMentionDTO[]> {
  if (handles.length === 0) return []
  const lowered = [...new Set(handles.map((h) => h.toLowerCase()))]
  const rows = await sql<{ id: string; handle: string; display_name: string }[]>`
    SELECT u.id, u.handle, u.display_name
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.handle IS NOT NULL
      AND u.id <> ${selfUserId}
      AND lower(u.handle::text) IN ${sql(lowered)}
  `
  return rows.map((r) => ({ id: r.id, handle: r.handle, displayName: r.display_name }))
}

/**
 * Resolve explicit user ids to mentionable UserMentionDTO rows, EXCLUDING self + soft-deleted +
 * handle-less. A non-UUID id is filtered out before the IN list (it would match nothing anyway). Used by
 * resolveMentionTargets for the request's explicit mentionedUserIds.
 */
export async function resolveUserIdsToMentions(
  sql: Sql,
  userIds: string[],
  selfUserId: string,
): Promise<UserMentionDTO[]> {
  if (userIds.length === 0) return []
  const ids = [...new Set(userIds)].filter((id) => isUuid(id))
  if (ids.length === 0) return []
  const rows = await sql<{ id: string; handle: string; display_name: string }[]>`
    SELECT u.id, u.handle, u.display_name
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.handle IS NOT NULL
      AND u.id <> ${selfUserId}
      AND u.id IN ${sql(ids)}
  `
  return rows.map((r) => ({ id: r.id, handle: r.handle, displayName: r.display_name }))
}

/**
 * Resolve a COMBINED set of @handles + explicit user ids, EXCLUDING the author/self, for the USER
 * @-mention persist path. Backs the discussion/chat services' injected `resolveMentions`. The result is
 * de-duped by user id (handle-resolved order first, handles being the primary mention source).
 */
export async function resolveMentionTargets(
  sql: Sql,
  input: { handles: string[]; userIds: string[]; authorUserId: string },
): Promise<UserMentionDTO[]> {
  const byHandle = await resolveHandles(sql, input.handles, input.authorUserId)
  const byId =
    input.userIds.length > 0
      ? await resolveUserIdsToMentions(sql, input.userIds, input.authorUserId)
      : []
  const seen = new Set<string>()
  const out: UserMentionDTO[] = []
  for (const m of [...byHandle, ...byId]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}
