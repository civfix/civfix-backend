import {
  bigint,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"

export const eventMetricsDaily = pgTable(
  "event_metrics_daily",
  {
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    metric: text("metric").notNull(),
    bucket: text("bucket").notNull().default(""),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.day, t.metric, t.bucket] }),
    index("event_metrics_daily_metric_day_idx").on(t.cleanupId, t.metric, t.day),
  ],
)

export type EventMetricsDailyRow = typeof eventMetricsDaily.$inferSelect
export type NewEventMetricsDailyRow = typeof eventMetricsDaily.$inferInsert
