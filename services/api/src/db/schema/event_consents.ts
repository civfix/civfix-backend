import { sql } from "drizzle-orm"
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanupGuests } from "./cleanup_guests.js"
import { cleanupRegistrations } from "./cleanup_registrations.js"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type { EVENT_CONSENT_SUBJECT_TYPE_VALUES } from "./types-host.js"

type EventConsentSubjectType = (typeof EVENT_CONSENT_SUBJECT_TYPE_VALUES)[number]

export const eventConsents = pgTable(
  "event_consents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<EventConsentSubjectType>().notNull(),
    userId: uuid("user_id").references(() => users.id),
    guestId: uuid("guest_id").references(() => cleanupGuests.id),
    registrationId: uuid("registration_id").references(() => cleanupRegistrations.id, {
      onDelete: "set null",
    }),
    termsVersion: text("terms_version").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    hostContactOptIn: boolean("host_contact_opt_in").notNull().default(false),
    smsOptIn: boolean("sms_opt_in").notNull().default(false),
    surface: text("surface"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "event_consents_subject_chk",
      sql`(${t.subjectType} = 'user' AND ${t.userId} IS NOT NULL AND ${t.guestId} IS NULL)
          OR (${t.subjectType} = 'guest' AND ${t.guestId} IS NOT NULL AND ${t.userId} IS NULL)`,
    ),
    index("event_consents_cleanup_accepted_idx").on(t.cleanupId, t.acceptedAt.desc(), t.id.desc()),
    index("event_consents_user_idx")
      .on(t.userId, t.acceptedAt.desc())
      .where(sql`${t.userId} is not null`),
    index("event_consents_guest_idx")
      .on(t.guestId, t.acceptedAt.desc())
      .where(sql`${t.guestId} is not null`),
    index("event_consents_registration_idx")
      .on(t.registrationId)
      .where(sql`${t.registrationId} is not null`),
  ],
)

export type EventConsentRow = typeof eventConsents.$inferSelect
export type NewEventConsentRow = typeof eventConsents.$inferInsert
