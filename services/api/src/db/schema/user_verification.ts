/**
 * user_verification: document-verification ("verified neighbor") queue. 1:1 with users via the PK so
 * the core `users` row stays lean — mirrors the user_moderation side-table pattern, but models the
 * gov_claims application-review lifecycle (pending -> verified|rejected) for a single per-user
 * verification rather than the abuse/risk signals.
 *
 * A row exists once the user applies (ABSENCE of a row = "unverified"). `status='verified'` is the
 * only state that lights the verified mark; approval changes NO role (it is a cosmetic trust signal).
 * `documents` jsonb: array of { mediaId, status?, note? } referencing media_assets rows tagged
 * purpose='verification'. All transitions audited via writeAudit.
 *
 * CANONICAL DDL: drizzle/0016_user_verification.sql. This mirror exists for typed queries / diff
 * inspection.
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { VERIFICATION_STATUS_VALUES } from "./types.js"

/**
 * The STORED status subset. 'unverified' (in the shared VerificationStatus enum) is represented by the
 * ABSENCE of a row, so it is never written to this column — the CHECK constraint in the canonical SQL
 * allows only pending|verified|rejected.
 */
export type VerificationStoredStatus = Exclude<
  (typeof VERIFICATION_STATUS_VALUES)[number],
  "unverified"
>

/** One uploaded verification document: a media_assets id (purpose='verification') + optional per-doc state. */
export interface VerificationDocument {
  mediaId: string
  status?: VerificationStoredStatus
  note?: string
}

export const userVerification = pgTable(
  "user_verification",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").$type<VerificationStoredStatus>().notNull().default("pending"),
    note: text("note"),
    documents: jsonb("documents").$type<VerificationDocument[]>().notNull().default([]),
    rejectionReason: text("rejection_reason"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_verification_status_applied_idx").on(t.status, t.appliedAt.desc())],
)

export type UserVerificationRow = typeof userVerification.$inferSelect
export type NewUserVerificationRow = typeof userVerification.$inferInsert
