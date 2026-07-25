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

import type { Queryable, Sql } from "../db/client.js"
import type { ChatReadState } from "./threads-service.js"

/**
 * Monotonically advance a per-user read watermark via INSERT … ON CONFLICT DO UPDATE: the watermark only
 * ever moves forward (GREATEST against the existing value, COALESCEd from epoch 0 so a NULL prior value is
 * treated as the floor). Shared by dm_read_state (and any future per-user read-state table with a
 * two-column key + a `last_read_at` column). `table`/key columns are caller-supplied module constants
 * (never user input), interpolated as postgres.js identifiers. The membership tables (cleanup_members,
 * report_chat_members, chat_group_members) take the UPDATE-shape sibling below instead: their row always
 * pre-exists, so an INSERT would violate their other NOT NULL columns.
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
 * The UPDATE-shape sibling of monotonicReadWatermark, for the membership tables whose row always
 * pre-exists (cleanup_members / report_chat_members / chat_group_members — an INSERT would violate their
 * other NOT NULL columns). Same monotonic guarantee: GREATEST against the current value, COALESCEd from
 * epoch 0 so a NULL prior watermark is the floor. A non-member is a silent no-op (0 rows matched).
 *
 * `at` is EITHER a timestamp or a message reference: `{ messagesTable, messageId, scopeColumn }` sets the
 * watermark to that message's created_at via a FROM-join, and matches nothing unless the message belongs
 * to the SAME room (so an ack naming another room's message can't move this watermark). `table` / key
 * columns / the message table + scope column are caller-supplied module constants (never user input),
 * interpolated as postgres.js identifiers.
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
