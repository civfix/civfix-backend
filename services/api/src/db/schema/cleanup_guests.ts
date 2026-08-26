import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { citext } from "./types.js"

export type GuestContactChannel = "email" | "sms"

export const cleanupGuests = pgTable(
  "cleanup_guests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    channel: text("channel").$type<GuestContactChannel>().notNull(),
    email: citext("email"),
    phone: text("phone"),
    contactKey: text("contact_key"),
    manageTokenHash: text("manage_token_hash").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    contactScrubbedAt: timestamp("contact_scrubbed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cleanup_guests_manage_token_uidx").on(t.manageTokenHash),
    uniqueIndex("cleanup_guests_active_contact_uidx")
      .on(t.cleanupId, t.contactKey)
      .where(sql`cancelled_at IS NULL AND contact_key IS NOT NULL`),
    index("cleanup_guests_cleanup_created_idx").on(t.cleanupId, t.createdAt.desc(), t.id.desc()),
    index("cleanup_guests_unscrubbed_idx")
      .on(t.cleanupId)
      .where(sql`contact_scrubbed_at IS NULL`),
  ],
)

export type CleanupGuestRow = typeof cleanupGuests.$inferSelect
export type NewCleanupGuestRow = typeof cleanupGuests.$inferInsert
