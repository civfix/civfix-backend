/**
 * service_hours_certificates: issued, verifiable PDF transcripts of a user's volunteer service (P5).
 *
 * The ROW is the record of truth; the R2 object at `r2Key` is a durable cache that is re-renderable from
 * `snapshot`. `code` is the canonical-uppercase 12-char Crockford-base32 public capability printed on the
 * document (see @civfix/shared normalizeCertificateCode / formatCertificateCode) — it is the ONLY
 * identifier the unauthenticated verify endpoint accepts, and `id` (which is also the R2 key segment) is
 * never disclosed.
 *
 * IMMUTABLE SNAPSHOT, NOT A VIEW: totalHours / entryCount / periodStart / periodEnd are frozen at issue
 * time and the verify endpoint reports them verbatim — it never re-reads the ledger. A document whose
 * number silently changes after a registrar has filed it is worse than no document. A corrected ledger
 * means a NEW certificate.
 *
 * `ledgerFingerprint` + the partial unique index on (user_id, ledger_fingerprint) WHERE revoked_at IS
 * NULL give double-tap idempotency: a second "Prepare transcript" over an unchanged ledger returns the
 * SAME code and renders nothing. Revoking frees the slot so the holder can re-issue over the same ledger.
 * That index is intentionally NOT mirrored below (partial/expression indexes stay SQL-only in this repo),
 * so a repo relying on the ON CONFLICT must name it in raw SQL.
 *
 * v1 issues over the WHOLE ledger: there are deliberately no issue-time filter columns (no
 * jurisdiction_geoid FK, no caller-supplied from/to) and no `recipient` — periodStart/periodEnd are the
 * DERIVED min/max of the included rows.
 *
 * revokedAt, not a DELETE: a revoked certificate must keep answering "issued, then revoked" rather than
 * "no such code". No users cascade — accounts soft-delete everywhere (docs/erasure-behavior.md), and the
 * verify projection filters on users.deleted_at instead.
 *
 * CANONICAL DDL: drizzle/0064_service_hours_certificates.sql.
 */

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
    // Canonical UPPERCASE 12-char Crockford-base32 code. Stored canonical, so the lookup is a plain
    // equality on the normalized input — no expression index needed.
    code: text("code").notNull(),
    // The locale the PDF was rendered in; a re-issue in another locale is a new document.
    locale: text("locale").notNull(),
    // Denormalized holder identity, frozen with the rest of the snapshot: the document names the person
    // it was issued to AT ISSUE TIME, even if they later rename or the account is tombstoned. A rename
    // therefore changes the fingerprint and mints a new document rather than mutating the old one.
    holderName: text("holder_name").notNull(),
    holderHandle: text("holder_handle"),
    holderVerified: boolean("holder_verified").notNull().default(false),
    // The SUM of the itemised entries the PDF prints, so the printed total always equals the sum of the
    // printed lines.
    totalHours: numeric("total_hours", { precision: 8, scale: 2 }).notNull(),
    entryCount: integer("entry_count").notNull(),
    // DERIVED min/max occurredAt of the included rows — not caller-supplied filters.
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    // Stable digest of the exact ledger rows included; the idempotency key.
    ledgerFingerprint: text("ledger_fingerprint").notNull(),
    // The exact rendered model, so the object can be re-rendered. Typed `unknown` on purpose: the render
    // model is owned by the certificate service, which parses it on read rather than trusting the column.
    snapshot: jsonb("snapshot").notNull(),
    // R2 object key. Always served through a forceSigned presign, never a public CDN URL.
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
    index("service_hours_certificates_user_issued_idx").on(t.userId, t.issuedAt.desc()),
  ],
)

export type ServiceHoursCertificateRow = typeof serviceHoursCertificates.$inferSelect
export type NewServiceHoursCertificateRow = typeof serviceHoursCertificates.$inferInsert
