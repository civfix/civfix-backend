/**
 * @city forward audit rows (report_message_forwards, migration 0043), one per (message, geoid).
 *   - recordMention runs BEFORE the forward is attempted, so "@city was mentioned" is captured even when
 *     there is no city contact to forward to. ON CONFLICT DO NOTHING keeps a retry from erroring or
 *     clobbering an already-forwarded row's forwarded_at.
 *   - markForwarded runs only after a SUCCESSFUL send; COALESCE keeps the first forward time on a re-run.
 *
 * forwardReportCityMention swallows both errors so a failed audit write can never reject the chat
 * message, which is already persisted. The table has no FK on message_id (chat_messages is
 * range-partitioned), so integrity is app-level, like the reactions/mentions side tables.
 */

import type { Sql } from "../db/client.js"

export interface ReportForwardAudit {
  recordMention(messageId: string, geoid: string): Promise<void>
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
