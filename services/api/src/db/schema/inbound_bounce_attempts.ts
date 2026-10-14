import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const inboundBounceAttempts = pgTable("inbound_bounce_attempts", {
  objectKey: text("object_key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
})

export type InboundBounceAttemptRow = typeof inboundBounceAttempts.$inferSelect
export type NewInboundBounceAttemptRow = typeof inboundBounceAttempts.$inferInsert
