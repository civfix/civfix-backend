/**
 * outreach_state: one row per jurisdiction tracking the outreach throttle (Phase 2).
 *
 * The digest cron + the "Save & route" enqueue consult this row to enforce the <=1 outreach /
 * jurisdiction / OUTREACH_THROTTLE_DAYS rule (compare now - last_outreach_at against the window) and a
 * manual `suppressed` opt-out. The geoid PK makes the upsert-on-send a single statement.
 *
 * CANONICAL DDL: drizzle/0007_admin_phase2.sql. This mirror exists for typed queries / diff inspection.
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
