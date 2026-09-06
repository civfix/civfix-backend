import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { organizations } from "./organizations.js"
import { users } from "./users.js"
import type { HostExportKindValue, HostExportStatusValue } from "./types-broadcast.js"

export const hostExports = pgTable(
  "host_exports",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id").references(() => cleanups.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<HostExportKindValue>().notNull(),
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<HostExportStatusValue>().notNull().default("queued"),
    r2Key: text("r2_key"),
    rowCount: integer("row_count"),
    byteSize: bigint("byte_size", { mode: "number" }),
    truncated: boolean("truncated").notNull().default(false),
    errorCode: text("error_code"),
    runToken: uuid("run_token"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("host_exports_cleanup_requested_idx").on(
      t.cleanupId,
      t.requestedAt.desc(),
      t.id.desc(),
    ),
    index("host_exports_requester_idx").on(t.requestedBy, t.requestedAt.desc(), t.id.desc()),
    index("host_exports_reap_idx")
      .on(t.expiresAt)
      .where(sql`status = 'ready'`),
    index("host_exports_stuck_idx")
      .on(t.startedAt)
      .where(sql`status = 'running'`),
    index("host_exports_org_requested_idx")
      .on(t.organizationId, t.requestedAt.desc(), t.id.desc())
      .where(sql`organization_id IS NOT NULL`),
  ],
)

export type HostExportRow = typeof hostExports.$inferSelect
export type NewHostExportRow = typeof hostExports.$inferInsert
