/**
 * email_otps: short-lived one-time passcodes for email sign-in.
 *
 * Only the hash of the code is stored. `attempts` lets the verifier rate-limit guesses; `consumed_at`
 * marks single-use redemption; `expires_at` bounds validity. Indexed by (email, created_at) so the
 * latest active code for an address is cheap to fetch.
 */

import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { citext } from "./types.js"

export const emailOtps = pgTable(
  "email_otps",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: citext("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("email_otps_email_created_idx").on(t.email, t.createdAt),
    index("email_otps_expires_idx").on(t.expiresAt),
    index("email_otps_consumed_idx")
      .on(t.consumedAt)
      .where(sql`${t.consumedAt} is not null`),
  ],
)

export type EmailOtpRow = typeof emailOtps.$inferSelect
export type NewEmailOtpRow = typeof emailOtps.$inferInsert
