
import type { Sql } from "../../db/client.js"
import { clampLimit, decodeCursor, paginate } from "./pagination.js"
import { isUuid } from "../../db/cursor-helpers.js"
import type { AuditRecord, AuditRepository, ListAuditArgs } from "./audit-service.js"
import { likeContains } from "./like.js"

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

export function makeDrizzleAuditRepository(sql: Sql): AuditRepository {
  return {
    async list(
      args: ListAuditArgs,
    ): Promise<{ records: AuditRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)
      const cursorFilter =
        anchor !== null
          ? sql`AND (a.created_at, a.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const actorFilter =
        args.actor !== null
          ? (() => {
              const like = likeContains(args.actor)
              const asUuid = isUuid(args.actor) ? args.actor : null
              return sql`AND (${asUuid}::uuid IS NOT NULL AND a.actor_id = ${asUuid}::uuid OR u.display_name ILIKE ${like} ESCAPE '\\')`
            })()
          : sql``
      const actionFilter =
        args.action !== null ? sql`AND a.action ILIKE ${likeContains(args.action)} ESCAPE '\\'` : sql``
      const targetFilter =
        args.target !== null ? sql`AND a.target ILIKE ${likeContains(args.target)} ESCAPE '\\'` : sql``

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
      const { items, nextCursor } = paginate(rows, limit, (r) => ({
        createdAt: r.created_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },
  }
}
