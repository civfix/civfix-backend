/**
 * Enforces at most one outreach per jurisdiction per OUTREACH_THROTTLE_DAYS, plus a manual `suppressed`
 * opt-out. The geoid PK makes the upsert-on-send a single statement.
 */

import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"

export const outreachState = pgTable("outreach_state", {
  geoid: text("geoid")
    .primaryKey()
    .references(() => jurisdictions.geoid),
  lastOutreachAt: timestamp("last_outreach_at", { withTimezone: true }),
  suppressed: boolean("suppressed").notNull().default(false),
})

export type OutreachStateRow = typeof outreachState.$inferSelect
export type NewOutreachStateRow = typeof outreachState.$inferInsert
