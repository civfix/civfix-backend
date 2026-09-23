import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"

export const jurisdictionContacts = pgTable(
  "jurisdiction_contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    geoid: text("geoid")
      .notNull()
      .references(() => jurisdictions.geoid),
    category: text("category"),
    email: text("email"),
    formUrl: text("form_url"),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jurisdiction_contacts_geoid_category_key")
      .on(t.geoid, t.category)
      .where(sql`category IS NOT NULL`),
    uniqueIndex("jurisdiction_contacts_geoid_default_key")
      .on(t.geoid)
      .where(sql`category IS NULL`),
    index("jurisdiction_contacts_geoid_idx").on(t.geoid),
    index("jurisdiction_contacts_email_lower_idx").on(sql`lower(${t.email})`),
  ],
)

export type JurisdictionContactRow = typeof jurisdictionContacts.$inferSelect
export type NewJurisdictionContactRow = typeof jurisdictionContacts.$inferInsert
