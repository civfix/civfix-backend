/**
 * Watermarks only ever move forward (GREATEST), so an out-of-order ack from a slow client can never
 * un-read newer messages. COALESCE from epoch 0 treats a NULL prior value as the floor.
 */

import type { Queryable, Sql } from "../db/client.js"
import type { ChatReadState } from "./threads-service.js"

/**
 * `table` and the key columns are caller-supplied module constants, never user input, interpolated as
 * postgres.js identifiers. The membership tables take the UPDATE-shape sibling below instead: their row
 * always pre-exists, so an INSERT would violate their other NOT NULL columns.
 */
export async function monotonicReadWatermark(
  tag: Queryable,
  table: string,
  keys: Record<string, string>,
  at: Date,
): Promise<void> {
  const entries = Object.entries(keys)
  const colList = entries.reduce(
    (acc, [c], i) => (i === 0 ? tag`${tag(c)}` : tag`${acc}, ${tag(c)}`),
    tag``,
  )
  const valList = entries.reduce(
    (acc, [, v], i) => (i === 0 ? tag`${v}` : tag`${acc}, ${v}`),
    tag``,
  )
  await tag`
    INSERT INTO ${tag(table)} (${colList}, last_read_at)
    VALUES (${valList}, ${at})
    ON CONFLICT (${colList}) DO UPDATE
    SET last_read_at = GREATEST(COALESCE(${tag(table)}.last_read_at, to_timestamp(0)), ${at})
  `
}

/**
 * A non-member is a silent no-op (0 rows matched). A message reference for `at` matches nothing unless
 * the message belongs to the SAME room, so an ack naming another room's message can't move this
 * watermark. Every identifier is a caller-supplied module constant, never user input.
 */
export async function monotonicReadWatermarkUpdate(
  tag: Queryable,
  table: string,
  keys: Record<string, string>,
  at: Date | { messagesTable: string; messageId: string; scopeColumn: string; scopeId: string },
): Promise<void> {
  const where = Object.entries(keys).reduce(
    (acc, [c, v], i) => (i === 0 ? tag`m.${tag(c)} = ${v}` : tag`${acc} AND m.${tag(c)} = ${v}`),
    tag``,
  )
  if (at instanceof Date) {
    await tag`
      UPDATE ${tag(table)} m
      SET last_read_at = GREATEST(COALESCE(m.last_read_at, to_timestamp(0)), ${at})
      WHERE ${where}
    `
    return
  }
  await tag`
    UPDATE ${tag(table)} m
    SET last_read_at = GREATEST(COALESCE(m.last_read_at, to_timestamp(0)), cm.created_at)
    FROM ${tag(at.messagesTable)} cm
    WHERE ${where}
      AND cm.id = ${at.messageId}
      AND cm.${tag(at.scopeColumn)} = ${at.scopeId}
  `
}

export function makeDrizzleChatReadState(sql: Sql): ChatReadState {
  return {
    async markRead(cleanupId: string, userId: string, at: Date): Promise<void> {
      await monotonicReadWatermarkUpdate(
        sql,
        "cleanup_members",
        { cleanup_id: cleanupId, user_id: userId },
        at,
      )
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
