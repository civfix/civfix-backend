/**
 * Postgres-backed ChatReadState: the durable half of the chat read watermark.
 *
 * Phase 1 stored the per-(user, cleanup) last-read timestamp in process memory (InMemoryChatReadState),
 * so unread counts reset on every API restart and could not be shared across instances. This impl
 * persists the watermark on `cleanup_members.last_read_at` (migration 0008) so unread counts decrement
 * when a conversation is read AND survive restarts / span workers.
 *
 * markRead is MONOTONIC: it only ever moves the watermark forward (GREATEST), so an out-of-order ack from
 * a slow client can never un-read newer messages. It targets the existing membership row (only a member
 * can mark a cleanup read), so a non-member ack is a silent no-op (0 rows updated). Reads come straight
 * off the composite-PK row, an index point-lookup.
 */

import type { Sql } from "../db/client.js"
import type { ChatReadState } from "./threads-service.js"

export function makeDrizzleChatReadState(sql: Sql): ChatReadState {
  return {
    async markRead(cleanupId: string, userId: string, at: Date): Promise<void> {
      await sql`
        UPDATE cleanup_members
        SET last_read_at = GREATEST(COALESCE(last_read_at, to_timestamp(0)), ${at})
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      `
    },

    async lastReadAt(cleanupId: string, userId: string): Promise<Date | null> {
      const rows = await sql<{ last_read_at: Date | null }[]>`
        SELECT last_read_at
        FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      `
      return rows[0]?.last_read_at ?? null
    },
  }
}
