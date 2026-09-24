import type { Queryable, Sql, SqlFragment } from "../../db/client.js"
import { clampLimit } from "./pagination.js"
import {
  isUuid,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import type { AuditRecord, AuditRepository, ListAuditArgs } from "./audit-repository.js"
import type { WriteAuditInput } from "./audit.js"
import { likeContains } from "../../db/like.js"

interface AuditRowSelect {
  id: string
  actor_id: string | null
  actor_name: string | null
  action: string
  target: string | null
  meta: Record<string, unknown> | null
  created_at: Date
  cursor_at: string | null
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

function auditActorFilter(sql: Queryable, actor: string | null): SqlFragment {
  if (actor === null) return sql``
  const like = likeContains(actor)
  const asUuid = isUuid(actor) ? actor : null
  return sql`AND (${asUuid}::uuid IS NOT NULL AND a.actor_id = ${asUuid}::uuid OR u.display_name ILIKE ${like} ESCAPE '\\')`
}

function containsFilter(sql: Queryable, column: SqlFragment, term: string | null): SqlFragment {
  return term === null ? sql`` : sql`AND ${column} ILIKE ${likeContains(term)} ESCAPE '\\'`
}

export function makeDrizzleAuditRepository(sql: Sql): AuditRepository {
  return {
    async list(
      args: ListAuditArgs,
    ): Promise<{ records: AuditRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = parseKeysetCursor(args.cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND ${keysetPredicate(sql, sql`a.created_at`, sql`a.id`, anchor)}`
          : sql``
      const actorFilter = auditActorFilter(sql, args.actor)
      const actionFilter = containsFilter(sql, sql`a.action`, args.action)
      const targetFilter = containsFilter(sql, sql`a.target`, args.target)

      const rows = await sql<AuditRowSelect[]>`
        SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action, a.target, a.meta, a.created_at,
               ${keysetInstant(sql, sql`a.created_at`)} AS cursor_at
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
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },
  }
}

export async function insertAuditRow(db: Queryable, input: WriteAuditInput): Promise<string> {
  const actorId = input.actorId ?? null
  const target = input.target ?? null
  const meta = input.meta == null ? null : db.json(input.meta as Parameters<typeof db.json>[0])
  const rows = await db<{ id: string }[]>`
    INSERT INTO audit_log (actor_id, action, target, meta)
    VALUES (${actorId}, ${input.action}, ${target}, ${meta})
    RETURNING id
  `
  const id = rows[0]?.id
  if (id === undefined) throw new Error("writeAudit: insert returned no row")
  return id
}
