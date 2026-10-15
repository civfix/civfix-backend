import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const serviceHoursCertificates = pgTable(
  "service_hours_certificates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    code: text("code").notNull(),
    locale: text("locale").notNull(),
    holderName: text("holder_name").notNull(),
    holderHandle: text("holder_handle"),
    holderVerified: boolean("holder_verified").notNull().default(false),
    totalHours: numeric("total_hours", { precision: 8, scale: 2 }).notNull(),
    entryCount: integer("entry_count").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    ledgerFingerprint: text("ledger_fingerprint").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    r2Key: text("r2_key").notNull(),
    documentSha256: text("document_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    regeneratedAt: timestamp("regenerated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    uniqueIndex("service_hours_certificates_code_uidx").on(t.code),
    uniqueIndex("service_hours_certificates_live_fp_uidx")
      .on(t.userId, t.ledgerFingerprint)
      .where(sql`${t.revokedAt} is null`),
    index("service_hours_certificates_user_issued_idx").on(t.userId, t.issuedAt.desc()),
  ],
)

export type ServiceHoursCertificateRow = typeof serviceHoursCertificates.$inferSelect
export type NewServiceHoursCertificateRow = typeof serviceHoursCertificates.$inferInsert
