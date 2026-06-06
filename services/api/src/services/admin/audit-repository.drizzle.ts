/**
 * Postgres-backed AuditRepository (Phase 2): the read side of audit_log for the operator audit view (#67).
 *
 * One raw SQL read (LEFT JOIN users for the actor display name) paged newest-first by
 * (created_at DESC, id DESC) with the shared "<iso>|<id>" keyset cursor, plus the optional actor / action
 * / target filters. Written against the raw postgres-js tag (`Sql`, from container.getDb().sql) like the
 * other admin repos so the jsonb `meta` column round-trips through postgres.js's default deserializer.
 *
 * Filters:
 *   - actor:  matches actor_id EXACTLY (a uuid) OR the joined user display_name (case-insensitive
 *             substring), so an operator can filter by either an id or a name fragment.
 *   - action: case-insensitive substring of the dotted action (e.g. "report." or "banned").
 *   - target: case-insensitive substring of the target reference (e.g. "report:" or a specific uuid).
 */

import type { Sql } from "../../db/client.js"
import { clampLimit, decodeCursor, encodeCursor, type CursorAnchor } from "./pagination.js"
import type { AuditRecord, AuditRepository, ListAuditArgs } from "./audit-service.js"

/** An audit_log row as selected back (snake_case columns + the joined actor name). */
interface AuditRowSelect {
  id: string
  actor_id: string | null
  actor_name: string | null
  action: string
  target: string | null
  meta: Record<string, unknown> | null
  created_at: Date
}

function toRecord(r: AuditRowSelect): AuditRecord {
  return {
    id: r.id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    target: r.target,
    meta: r.meta,
    createdAt: r.created_at,
  }
}

/** Construct the production AuditRepository over the raw postgres-js tag (`container.getDb().sql`). */
export function makeDrizzleAuditRepository(sql: Sql): AuditRepository {
  return {
    async list(
      args: ListAuditArgs,
    ): Promise<{ records: AuditRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND (a.created_at, a.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      // actor matches the exact actor_id (when it parses as a uuid) OR a substring of the display name.
      const actorFilter =
        args.actor !== null
          ? (() => {
              const like = `%${args.actor}%`
              const asUuid = isUuid(args.actor) ? args.actor : null
              return sql`AND (${asUuid}::uuid IS NOT NULL AND a.actor_id = ${asUuid}::uuid OR u.display_name ILIKE ${like})`
            })()
          : sql``
      const actionFilter =
        args.action !== null ? sql`AND a.action ILIKE ${`%${args.action}%`}` : sql``
      const targetFilter =
        args.target !== null ? sql`AND a.target ILIKE ${`%${args.target}%`}` : sql``

      const rows = await sql<AuditRowSelect[]>`
        SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action, a.target, a.meta, a.created_at
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_id
        WHERE true
          ${actorFilter}
          ${actionFilter}
          ${targetFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const records = page.map(toRecord)
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? encodeCursor(anchorOf(toRecord(last))) : null
      return { records, nextCursor }
    },
  }
}

/** The keyset anchor for an audit row (created_at + id tiebreak). */
function anchorOf(record: AuditRecord): CursorAnchor {
  return { createdAt: record.createdAt, id: record.id }
}

/** Loose uuid shape check so a non-uuid `actor` filter never trips a Postgres cast error. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
