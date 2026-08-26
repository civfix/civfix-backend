import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const smsOptOuts = pgTable("sms_opt_outs", {
  phone: text("phone").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type SmsOptOutRow = typeof smsOptOuts.$inferSelect
export type NewSmsOptOutRow = typeof smsOptOuts.$inferInsert
