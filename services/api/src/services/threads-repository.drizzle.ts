/**
 * Postgres-backed ThreadsRepository (the persistence half of the threads seam).
 *
 * listThreadsFor returns the viewer's cleanups (via cleanup_members) joined with the member count and a
 * lateral "most recent message" lookup, ordered by most recent activity (last message, else joined_at).
 * countUnread counts a cleanup's messages from senders other than the viewer with created_at after the
 * read watermark. Both run against the raw postgres-js tag (the message read pages the partitioned
 * chat_messages table).
 */

import type { Sql } from "../db/client.js"
import type { ThreadAggregate, ThreadsRepository } from "./threads-service.js"

/** Selected thread aggregate row (member's cleanup + last-message fields). */
interface ThreadRowSelect {
  cleanup_id: string
  title: string
  joined_at: Date
  members: number
  last_body: string | null
  last_created_at: Date | null
  last_sender_id: string | null
}

export function makeDrizzleThreadsRepository(sql: Sql): ThreadsRepository {
  return {
    async listThreadsFor(userId: string, limit: number): Promise<ThreadAggregate[]> {
      const rows = await sql<ThreadRowSelect[]>`
        SELECT
          c.id AS cleanup_id,
          c.title,
          mem.joined_at,
          (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id) AS members,
          last_msg.body AS last_body,
          last_msg.created_at AS last_created_at,
          last_msg.sender_id AS last_sender_id
        FROM cleanup_members mem
        JOIN cleanups c ON c.id = mem.cleanup_id
        LEFT JOIN LATERAL (
          SELECT cm.body, cm.created_at, cm.sender_id
          FROM chat_messages cm
          WHERE cm.cleanup_id = c.id AND cm.deleted_at IS NULL
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT 1
        ) last_msg ON TRUE
        WHERE mem.user_id = ${userId}
        ORDER BY COALESCE(last_msg.created_at, mem.joined_at) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        cleanupId: r.cleanup_id,
        title: r.title,
        joinedAt: r.joined_at,
        members: r.members,
        last:
          r.last_created_at !== null
            ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id! }
            : null,
      }))
    },

    async countUnread(cleanupId: string, userId: string, after: Date): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM chat_messages cm
        WHERE cm.cleanup_id = ${cleanupId}
          AND cm.deleted_at IS NULL
          AND cm.sender_id <> ${userId}
          AND cm.created_at > ${after}
      `
      return rows[0]?.count ?? 0
    },
  }
}
