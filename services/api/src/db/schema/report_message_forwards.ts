/**
 * @city forward audit: a report-chat message mentioning a jurisdiction handle was forwarded to its
 * contact, or (forwarded_at NULL) was mentioned while no contact existed to forward to.
 *
 * No FK on message_id: chat_messages is range-partitioned with composite PK(id, created_at), so there is
 * no single-column key to reference. geoid has no FK either, so a forward can be recorded for a geoid the
 * jurisdictions table does not hold yet.
 */

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const reportMessageForwards = pgTable(
  "report_message_forwards",
  {
    messageId: uuid("message_id").notNull(),
    geoid: text("geoid").notNull(),
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.geoid] })],
)

export type ReportMessageForwardRow = typeof reportMessageForwards.$inferSelect
export type NewReportMessageForwardRow = typeof reportMessageForwards.$inferInsert
