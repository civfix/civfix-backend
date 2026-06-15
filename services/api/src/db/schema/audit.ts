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
    // --- Performance indexes added in drizzle/0013_perf_indexes.sql ---
    // Activity-feed audit branch: global newest-first scan.
    index("audit_log_created_idx").on(t.createdAt.desc()),
    // Admin audit list keyset (created_at DESC, id DESC).
    index("audit_log_created_id_idx").on(t.createdAt.desc(), t.id.desc()),
    // discovery notes / contact-suggestion reads filter (action, target) then order by created_at ASC.
    index("audit_log_action_target_created_idx").on(t.action, t.target, t.createdAt),
  ],
)

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditLogRow = typeof auditLog.$inferInsert
