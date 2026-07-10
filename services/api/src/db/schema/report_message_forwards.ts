/**
 * report_message_forwards: @city forward audit. Records that a report-chat message mentioning
 * @city (jurisdiction handle) was forwarded to that jurisdiction's contact -- or, when
 * forwarded_at is NULL, that @city was mentioned but there is no city contact to forward to yet.
 * geoid identifies the jurisdiction (matches jurisdictions.geoid elsewhere in the schema).
 *
 * NO foreign key on message_id: chat_messages is RANGE-partitioned with a composite PK(id,
 * created_at), so there is no single-column key to reference -- exactly like
 * chat_message_reactions (schema/chat_reactions.ts) / chat_message_mentions
 * (schema/message_mentions.ts). App-level integrity holds. geoid is also left unconstrained (no FK
 * to jurisdictions) so forwarding can be recorded even for a geoid not yet present in the
 * jurisdictions table.
 *
 * Composite PK(message_id, geoid) means one forward record per (message, jurisdiction) pair.
 *
 * CANONICAL DDL: drizzle/0043_report_message_forwards.sql. This mirror exists for typed queries /
 * diff inspection only; nothing reads/writes it yet (forward audit lands in D-C4).
 */

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const reportMessageForwards = pgTable(
  "report_message_forwards",
  {
    // A chat_messages.id (uuid, globally unique). Intentionally NOT a FK -- see header.
    messageId: uuid("message_id").notNull(),
    geoid: text("geoid").notNull(),
    // NULL = @city mentioned but not yet forwarded (no city contact).
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.geoid] })],
)

export type ReportMessageForwardRow = typeof reportMessageForwards.$inferSelect
export type NewReportMessageForwardRow = typeof reportMessageForwards.$inferInsert
