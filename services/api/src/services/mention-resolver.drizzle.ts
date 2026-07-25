
import type { Sql } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"
import { isUuid } from "../db/cursor-helpers.js"

export async function resolveHandles(
  sql: Sql,
  handles: string[],
  selfUserId: string,
): Promise<UserMentionDTO[]> {
  if (handles.length === 0) return []
  const handleSet = [...new Set(handles.map((h) => h.toLowerCase()))]
  const rows = await sql<{ id: string; handle: string; display_name: string }[]>`
    SELECT u.id, u.handle, u.display_name
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.handle IS NOT NULL
      AND u.id <> ${selfUserId}
      AND u.handle IN ${sql(handleSet)}
  `
  return rows.map((r) => ({ id: r.id, handle: r.handle, displayName: r.display_name }))
}

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

export async function resolveMentionTargets(
  sql: Sql,
  input: { handles: string[]; userIds: string[]; authorUserId: string },
): Promise<UserMentionDTO[]> {
  // Independent lookups, so they go out together — this sits on the WS send hot path for every
  // mention-bearing message. Each already short-circuits to [] on an empty input list.
  const [byHandle, byId] = await Promise.all([
    resolveHandles(sql, input.handles, input.authorUserId),
    resolveUserIdsToMentions(sql, input.userIds, input.authorUserId),
  ])
  const seen = new Set<string>()
  const out: UserMentionDTO[] = []
  for (const m of [...byHandle, ...byId]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}
