/**
 * Postgres-backed BlocksRepository: the persistence seam for user blocking.
 *
 * Blocks are directed edges (blocker_id -> blocked_id) in user_blocks. `block` is idempotent (ON CONFLICT
 * DO NOTHING on PK). `isBlockedEitherWay` is the bidirectional test the DM paths use: a thread is hidden
 * and sends are rejected whenever EITHER party blocked the other; `blockedIdsAmong` is its batch form for
 * the room fan-out (one query per message instead of one per member). `listBlocked` returns the viewer's
 * blocked users as PersonDTOs for the settings "Blocked accounts" list.
 *
 * Written against the raw postgres-js tag (`Sql`) to match the rest of the backend.
 */

import type { Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/shared"
import type { PersonDTO } from "@civfix/shared"

export interface BlockState {
  blockedByViewer: boolean
  blockedByTarget: boolean
}

export interface BlocksRepository {
  /** Insert a block edge (blocker -> blocked). Idempotent. */
  block(blockerId: string, blockedId: string): Promise<void>
  /** Remove a block edge (blocker -> blocked). Idempotent (deleting a missing edge is a no-op). */
  unblock(blockerId: string, blockedId: string): Promise<void>
  /** Whether `a` blocked `b` OR `b` blocked `a`. */
  isBlockedEitherWay(a: string, b: string): Promise<boolean>
  blockState(viewerId: string, targetId: string): Promise<BlockState>
  /**
   * BATCH form of isBlockedEitherWay: of `candidateIds`, the subset blocked either way with `actorId` —
   * ONE query for a whole room's candidate set instead of one per member. Feeds the room fan-out
   * notifiers' optional `blockedIdsFor` seam (chat-room-fanout-notifier), which keeps the per-candidate
   * path as its fallback.
   *
   * OPTIONAL on the seam on purpose: an implementation without a batch form (the in-memory repo backing
   * the fake-chat dev path and the offline harnesses) simply leaves the notifier on its per-candidate
   * `isBlockedEitherWay` gate — same verdicts, more round trips. Never a weaker gate.
   */
  blockedIdsAmong?(actorId: string, candidateIds: string[]): Promise<Set<string>>
  /** The users `blockerId` has blocked, as PersonDTOs (for the settings list). */
  listBlocked(blockerId: string): Promise<PersonDTO[]>
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
      // Either direction counts (the bidirectional test above, expressed over a set): a row is emitted
      // when the actor blocked the candidate OR the candidate blocked the actor. The projection picks
      // the OTHER party's id off whichever side matched, so the result is always candidate ids.
      const rows = await sql<{ other_id: string }[]>`
        SELECT CASE WHEN b.blocker_id = ${actorId} THEN b.blocked_id ELSE b.blocker_id END AS other_id
        FROM user_blocks b
        WHERE (b.blocker_id = ${actorId} AND b.blocked_id IN ${sql(candidateIds)})
           OR (b.blocked_id = ${actorId} AND b.blocker_id IN ${sql(candidateIds)})
      `
      return new Set(rows.map((r) => r.other_id))
    },

    async listBlocked(blockerId: string): Promise<PersonDTO[]> {
      const rows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          bio: string | null
          avatar_url: string | null
        }[]
      >`
        SELECT u.id, u.display_name, u.handle, u.bio, u.avatar_url
        FROM user_blocks b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ${blockerId} AND u.deleted_at IS NULL
        ORDER BY b.created_at DESC
      `
      return rows.map((r) => ({
        id: r.id,
        name: r.display_name,
        handle: r.handle,
        bio: r.bio,
        avatar: avatarGradient(r.id),
        ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
        followers: 0,
        following: 0,
        isFollowing: false,
      }))
    },
  }
}
