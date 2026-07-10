/**
 * Task D-C4: @city forward AUDIT writes onto report_message_forwards (migration 0043).
 *
 * A report-chat message that @mentions its own jurisdiction handle records ONE row per (message, geoid):
 *   - recordMention: written BEFORE the forward is attempted, forwarded_at NULL. This captures
 *     "@city was mentioned" even when there is no city contact to forward to (mentioned-but-not-forwarded).
 *     Idempotent via ON CONFLICT DO NOTHING so a re-send / retry within the same message id never errors and
 *     never clobbers an already-forwarded row's forwarded_at.
 *   - markForwarded: run only AFTER a SUCCESSFUL send, stamping forwarded_at = now(). COALESCE keeps the
 *     first forward time on an idempotent re-run.
 *
 * Both are best-effort from the caller's perspective: forwardReportCityMention swallows their errors so a
 * failed/absent audit write can never reject the chat message (the message already persisted). The table has
 * no FK on message_id (chat_messages is range-partitioned) -- app-level integrity, exactly like the
 * reactions/mentions side tables.
 */

import type { Sql } from "../db/client.js"

export interface ReportForwardAudit {
  /** Insert the (message, geoid) audit row with forwarded_at NULL; idempotent (no-op on conflict). */
  recordMention(messageId: string, geoid: string): Promise<void>
  /** Stamp forwarded_at = now() for the (message, geoid) row (keeps the earliest time on re-run). */
  markForwarded(messageId: string, geoid: string): Promise<void>
}

export function makeReportForwardAudit(sql: Sql): ReportForwardAudit {
  return {
    async recordMention(messageId: string, geoid: string): Promise<void> {
      await sql`
        INSERT INTO report_message_forwards (message_id, geoid, forwarded_at)
        VALUES (${messageId}, ${geoid}, NULL)
        ON CONFLICT (message_id, geoid) DO NOTHING
      `
    },

    async markForwarded(messageId: string, geoid: string): Promise<void> {
      await sql`
        UPDATE report_message_forwards
        SET forwarded_at = COALESCE(forwarded_at, now())
        WHERE message_id = ${messageId} AND geoid = ${geoid}
      `
    },
  }
}
