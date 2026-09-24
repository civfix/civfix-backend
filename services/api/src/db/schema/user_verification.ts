/**
 * Document-verification ("verified neighbor") queue, a 1:1 side table so the core users row stays lean.
 * A row exists once the user applies; its absence means "unverified". Approval changes no role: the
 * verified mark is a cosmetic trust signal only.
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { VERIFICATION_STATUS_VALUES } from "./types.js"

/** 'unverified' is the absence of a row, so the column's CHECK never admits it. */
export type VerificationStoredStatus = Exclude<
  (typeof VERIFICATION_STATUS_VALUES)[number],
  "unverified"
>

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
