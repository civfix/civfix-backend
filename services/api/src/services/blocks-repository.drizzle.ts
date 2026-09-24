import type { Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/shared"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../db/cursor-helpers.js"
import { officialPersonFlag } from "../auth/official-account.js"
import type {
  BlockState,
  BlocksRepository,
  ListBlockedArgs,
  ListBlockedPage,
} from "./blocks-repository.js"

export const LIST_BLOCKS_DEFAULT_LIMIT = 50

export function bindBlockedIdsAmong(
  repo: BlocksRepository,
): ((actorId: string, candidateIds: string[]) => Promise<Set<string>>) | undefined {
  const batch = repo.blockedIdsAmong
  if (!batch) return undefined
  return (actorId, candidateIds) => batch.call(repo, actorId, candidateIds)
}

export function makeDrizzleBlocksRepository(sql: Sql): BlocksRepository {
  return {
    async block(blockerId: string, blockedId: string): Promise<void> {
      await sql`
        INSERT INTO user_blocks (blocker_id, blocked_id)
        VALUES (${blockerId}, ${blockedId})
        ON CONFLICT (blocker_id, blocked_id) DO NOTHING
      `
    },

    async unblock(blockerId: string, blockedId: string): Promise<void> {
      await sql`
        DELETE FROM user_blocks WHERE blocker_id = ${blockerId} AND blocked_id = ${blockedId}
      `
    },

    async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 FROM user_blocks
        WHERE (blocker_id = ${a} AND blocked_id = ${b})
           OR (blocker_id = ${b} AND blocked_id = ${a})
        LIMIT 1
      `
      return rows.length > 0
    },

    async blockState(viewerId: string, targetId: string): Promise<BlockState> {
      const rows = await sql<{ blocker_id: string }[]>`
        SELECT blocker_id FROM user_blocks
        WHERE (blocker_id = ${viewerId} AND blocked_id = ${targetId})
           OR (blocker_id = ${targetId} AND blocked_id = ${viewerId})
      `
      return {
        blockedByViewer: rows.some((r) => r.blocker_id === viewerId),
        blockedByTarget: rows.some((r) => r.blocker_id === targetId),
      }
    },

    async blockedIdsAmong(actorId: string, candidateIds: string[]): Promise<Set<string>> {
      if (candidateIds.length === 0) return new Set()
      const rows = await sql<{ other_id: string }[]>`
        SELECT CASE WHEN b.blocker_id = ${actorId} THEN b.blocked_id ELSE b.blocker_id END AS other_id
        FROM user_blocks b
        WHERE (b.blocker_id = ${actorId} AND b.blocked_id IN ${sql(candidateIds)})
           OR (b.blocked_id = ${actorId} AND b.blocker_id IN ${sql(candidateIds)})
      `
      return new Set(rows.map((r) => r.other_id))
    },

    async listBlocked(blockerId: string, args?: ListBlockedArgs): Promise<ListBlockedPage> {
      const limit = args?.limit ?? LIST_BLOCKS_DEFAULT_LIMIT
      const cursor = parseKeysetCursor(args?.cursor ?? null)
      const cursorFilter =
        cursor !== null
          ? sql`AND ${keysetPredicate(sql, sql`b.created_at`, sql`b.blocked_id`, cursor)}`
          : sql``
      const rows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          bio: string | null
          avatar_url: string | null
          cursor_at: string
        }[]
      >`
        SELECT u.id, u.display_name, u.handle, u.bio, u.avatar_url,
               ${keysetInstant(sql, sql`b.created_at`)} AS cursor_at
        FROM user_blocks b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ${blockerId} AND u.deleted_at IS NULL
          ${cursorFilter}
        ORDER BY b.created_at DESC, b.blocked_id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return {
        blocked: items.map((r) => ({
          id: r.id,
          name: r.display_name,
          handle: r.handle,
          bio: r.bio,
          avatar: avatarGradient(r.id),
          ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
          followers: 0,
          following: 0,
          isFollowing: false,
          ...officialPersonFlag(r.id),
        })),
        nextCursor,
      }
    },
  }
}
