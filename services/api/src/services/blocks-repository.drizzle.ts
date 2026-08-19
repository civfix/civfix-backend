
import type { Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/shared"
import type { PersonDTO } from "@civfix/shared"
import { paginate, parseTimeCursor } from "../db/cursor-helpers.js"

export const LIST_BLOCKS_DEFAULT_LIMIT = 50

export interface ListBlockedArgs {
  cursor?: string | null
  limit?: number
}

export interface ListBlockedPage {
  blocked: PersonDTO[]
  nextCursor: string | null
}

export interface BlockState {
  blockedByViewer: boolean
  blockedByTarget: boolean
}

export interface BlocksRepository {
  block(blockerId: string, blockedId: string): Promise<void>
  unblock(blockerId: string, blockedId: string): Promise<void>
  isBlockedEitherWay(a: string, b: string): Promise<boolean>
  blockState(viewerId: string, targetId: string): Promise<BlockState>
  blockedIdsAmong?(actorId: string, candidateIds: string[]): Promise<Set<string>>
  listBlocked(blockerId: string, args?: ListBlockedArgs): Promise<ListBlockedPage>
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
      const cursor = parseTimeCursor(args?.cursor ?? null)
      const cursorFilter =
        cursor !== null
          ? sql`AND (b.created_at, b.blocked_id) < (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          bio: string | null
          avatar_url: string | null
          created_at: Date
        }[]
      >`
        SELECT u.id, u.display_name, u.handle, u.bio, u.avatar_url, b.created_at
        FROM user_blocks b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ${blockerId} AND u.deleted_at IS NULL
          ${cursorFilter}
        ORDER BY b.created_at DESC, b.blocked_id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginate(rows, limit, (r) => ({ at: r.created_at, id: r.id }))
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
        })),
        nextCursor,
      }
    },
  }
}
