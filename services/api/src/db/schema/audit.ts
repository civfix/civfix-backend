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
    // Activity-feed audit branch: global newest-first scan.
    index("audit_log_created_idx").on(t.createdAt.desc()),
    // Admin audit list keyset (created_at DESC, id DESC).
    index("audit_log_created_id_idx").on(t.createdAt.desc(), t.id.desc()),
    // Discovery notes and contact-suggestion reads filter (action, target), then order by created_at.
    index("audit_log_action_target_created_idx").on(t.action, t.target, t.createdAt),
  ],
)

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditLogRow = typeof auditLog.$inferInsert
