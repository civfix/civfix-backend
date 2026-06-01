/**
 * audit_log: append-only record of privileged actions (status changes, role grants, moderation,
 * outreach edits, ...). `actor_id` null for system actions. `target` is a free-form reference string
 * (e.g. "report:<id>"). `meta` is jsonb with action-specific detail. Indexed by (actor_id,
 * created_at) for "what did this actor do" and by (action) for "all events of this type".
 */

import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    target: text("target"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("audit_log_actor_created_idx").on(t.actorId, t.createdAt),
    index("audit_log_action_idx").on(t.action),
  ],
)

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditLogRow = typeof auditLog.$inferInsert
