import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type { EmailSuppressionReasonValue } from "./types-broadcast.js"

export const emailSuppressions = pgTable("email_suppressions", {
  emailHash: text("email_hash").primaryKey(),
  reason: text("reason").$type<EmailSuppressionReasonValue>().notNull(),
  hits: integer("hits").notNull().default(1),
  firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
})

export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect
export type NewEmailSuppressionRow = typeof emailSuppressions.$inferInsert
