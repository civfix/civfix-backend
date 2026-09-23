import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { is, SQL } from "drizzle-orm"
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core"
import { broadcastDeliveries } from "../../src/db/schema/broadcast_deliveries.js"
import { cleanupTeamInvites } from "../../src/db/schema/cleanup_team_invites.js"
import { cleanupTimeline } from "../../src/db/schema/cleanup_timeline.js"
import { followsPeople } from "../../src/db/schema/follows.js"
import { mailEvents } from "../../src/db/schema/mail.js"
import { moderationItems } from "../../src/db/schema/moderation_items.js"
import { pushTokens } from "../../src/db/schema/push_tokens.js"

const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")
const dialect = new PgDialect()

interface IndexCase {
  migration: string
  table: PgTable
  name: string
  ddl: string
  columns: string[]
  where: string | null
}

const CASES: IndexCase[] = [
  {
    migration: "0186_follows_people_followee_created_idx.sql",
    table: followsPeople,
    name: "follows_people_followee_created_idx",
    ddl: "CREATE INDEX IF NOT EXISTS follows_people_followee_created_idx ON follows_people (followee_id, created_at DESC, follower_id DESC);",
    columns: ["followee_id", "created_at DESC", "follower_id DESC"],
    where: null,
  },
  {
    migration: "0187_cleanup_team_invites_invited_by_idx.sql",
    table: cleanupTeamInvites,
    name: "cleanup_team_invites_inviter_pending_idx",
    ddl: "CREATE INDEX IF NOT EXISTS cleanup_team_invites_inviter_pending_idx ON cleanup_team_invites (invited_by) WHERE status = 'pending';",
    columns: ["invited_by"],
    where: `"cleanup_team_invites"."status" = 'pending'`,
  },
  {
    migration: "0188_moderation_items_erasure_meta_idx.sql",
    table: moderationItems,
    name: "moderation_items_meta_user_id_idx",
    ddl: "CREATE INDEX IF NOT EXISTS moderation_items_meta_user_id_idx ON moderation_items ((meta -> 'user' ->> 'id')) WHERE (meta -> 'user' ->> 'id') IS NOT NULL;",
    columns: [`("moderation_items"."meta" -> 'user' ->> 'id')`],
    where: `("moderation_items"."meta" -> 'user' ->> 'id') IS NOT NULL`,
  },
  {
    migration: "0188_moderation_items_erasure_meta_idx.sql",
    table: moderationItems,
    name: "moderation_items_meta_reporter_user_id_idx",
    ddl: "CREATE INDEX IF NOT EXISTS moderation_items_meta_reporter_user_id_idx ON moderation_items ((meta ->> 'reporterUserId')) WHERE (meta ->> 'reporterUserId') IS NOT NULL;",
    columns: [`("moderation_items"."meta" ->> 'reporterUserId')`],
    where: `("moderation_items"."meta" ->> 'reporterUserId') IS NOT NULL`,
  },
  {
    migration: "0189_mail_events_bounced_recipient_idx.sql",
    table: mailEvents,
    name: "mail_events_bounced_recipient_idx",
    ddl: "CREATE INDEX IF NOT EXISTS mail_events_bounced_recipient_idx ON mail_events ((lower(meta ->> 'failedRecipient'))) WHERE type = 'bounced';",
    columns: [`lower("mail_events"."meta" ->> 'failedRecipient')`],
    where: `"mail_events"."type" = 'bounced'`,
  },
  {
    migration: "0190_cleanup_timeline_flag_state_idx.sql",
    table: cleanupTimeline,
    name: "cleanup_timeline_flag_state_idx",
    ddl: "CREATE INDEX IF NOT EXISTS cleanup_timeline_flag_state_idx ON cleanup_timeline (cleanup_id, created_at DESC, id DESC) WHERE kind IN ('flag', 'unflag');",
    columns: ["cleanup_id", "created_at DESC", "id DESC"],
    where: `"cleanup_timeline"."kind" in ('flag', 'unflag')`,
  },
  {
    migration: "0191_push_tokens_active_token_idx.sql",
    table: pushTokens,
    name: "push_tokens_active_token_idx",
    ddl: "CREATE INDEX IF NOT EXISTS push_tokens_active_token_idx ON push_tokens (token) WHERE revoked_at IS NULL;",
    columns: ["token"],
    where: `"push_tokens"."revoked_at" is null`,
  },
  {
    migration: "0192_broadcast_deliveries_broadcast_created_idx.sql",
    table: broadcastDeliveries,
    name: "broadcast_deliveries_broadcast_created_idx",
    ddl: "CREATE INDEX IF NOT EXISTS broadcast_deliveries_broadcast_created_idx ON broadcast_deliveries (broadcast_id, created_at DESC, id DESC);",
    columns: ["broadcast_id", "created_at DESC", "id DESC"],
    where: null,
  },
]

function normalizedDdl(file: string): string {
  return readFileSync(join(DRIZZLE_DIR, file), "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ")
}

function renderColumn(column: unknown): string {
  if (is(column, SQL)) return dialect.sqlToQuery(column).sql
  const c = column as { name: string; indexConfig?: { order?: string } }
  return c.indexConfig?.order === "desc" ? `${c.name} DESC` : c.name
}

describe("performance indexes 0186-0192", () => {
  it.each(CASES)("$migration ships $name idempotently and inline", (c) => {
    const ddl = normalizedDdl(c.migration)
    expect(ddl).toContain(c.ddl)
    expect(ddl).not.toMatch(/CONCURRENTLY/i)
  })

  it.each(CASES)("$name is mirrored with the same keys and predicate", (c) => {
    const index = getTableConfig(c.table).indexes.find((i) => i.config.name === c.name)

    expect(index).toBeDefined()
    expect(index!.config.unique).toBe(false)
    expect(index!.config.columns.map(renderColumn)).toEqual(c.columns)
    const where = index!.config.where ? dialect.sqlToQuery(index!.config.where).sql : null
    expect(where).toBe(c.where)
  })
})
