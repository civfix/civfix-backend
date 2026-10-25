import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const runtimeFlags = pgTable("runtime_flags", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
})

export type RuntimeFlagRow = typeof runtimeFlags.$inferSelect
export type NewRuntimeFlagRow = typeof runtimeFlags.$inferInsert
