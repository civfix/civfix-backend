import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import type { GuestContactChannel } from "./cleanup_guests.js"

export const guestOtps = pgTable(
  "guest_otps",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    channel: text("channel").$type<GuestContactChannel>().notNull(),
    contact: text("contact").notNull(),
    name: text("name").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("guest_otps_cleanup_contact_created_idx").on(t.cleanupId, t.contact, t.createdAt.desc()),
    index("guest_otps_created_idx").on(t.createdAt),
  ],
)

export type GuestOtpRow = typeof guestOtps.$inferSelect
export type NewGuestOtpRow = typeof guestOtps.$inferInsert
