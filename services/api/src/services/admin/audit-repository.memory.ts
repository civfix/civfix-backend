/**
 * In-memory AuditRepository for the offline audit-service unit tests (no DB, no Docker).
 *
 * Faithful to the Drizzle impl's observable behavior: newest-first ordering by (createdAt DESC, id DESC),
 * the actor / action / target filters (actor matches actorId OR actorName; action/target are
 * case-insensitive substring matches, mirroring the SQL ILIKE), and the shared "<iso>|<id>" keyset
 * cursor. seedRow appends rows; the public `rows` array is inspectable.
 */

import type { AuditRecord, AuditRepository, ListAuditArgs } from "./audit-service.js"
import { decodeCursor, encodeCursor, type CursorAnchor } from "./pagination.js"

/** Optional fields for a seeded audit row (sensible defaults fill the rest). */
export interface SeedAuditInput {
  id?: string
  actorId?: string | null
  actorName?: string | null
  action?: string
  target?: string | null
  meta?: Record<string, unknown> | null
  createdAt?: Date
}

export class InMemoryAuditRepository implements AuditRepository {
  /** All seeded rows (insertion order; the list() method sorts a copy). */
  readonly rows: AuditRecord[] = []

  private seq = 0

  /** Append an audit row. Unspecified fields get deterministic defaults. */
  seedRow(input: SeedAuditInput = {}): AuditRecord {
    this.seq += 1
    const record: AuditRecord = {
      id: input.id ?? `audit-${this.seq}`,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
      action: input.action ?? "report.status_changed",
      target: input.target ?? null,
      meta: input.meta ?? null,
      createdAt: input.createdAt ?? new Date(),
    }
    this.rows.push(record)
    return record
  }

  async list(
    args: ListAuditArgs,
  ): Promise<{ records: AuditRecord[]; nextCursor: string | null }> {
    const anchor = decodeCursor(args.cursor)
    const actor = args.actor?.toLowerCase() ?? null
    const action = args.action?.toLowerCase() ?? null
    const target = args.target?.toLowerCase() ?? null

    const filtered = this.rows.filter((r) => {
      if (actor !== null) {
        const matchesId = (r.actorId ?? "").toLowerCase() === actor
        const matchesName = (r.actorName ?? "").toLowerCase().includes(actor)
        if (!matchesId && !matchesName) return false
      }
      if (action !== null && !r.action.toLowerCase().includes(action)) return false
      if (target !== null && !(r.target ?? "").toLowerCase().includes(target)) return false
      return true
    })

    // Newest first (createdAt DESC, id DESC), then drop anything not strictly before the cursor anchor.
    const sorted = [...filtered].sort(compareDesc)
    const windowed =
      anchor !== null ? sorted.filter((r) => beforeAnchor(r, anchor)) : sorted

    const page = windowed.slice(0, args.limit)
    const hasMore = windowed.length > args.limit
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(anchorOf(last)) : null
    return { records: page, nextCursor }
  }
}

/** The keyset anchor for an audit row (created_at + id tiebreak). */
function anchorOf(record: AuditRecord): CursorAnchor {
  return { createdAt: record.createdAt, id: record.id }
}

/** Sort comparator: newest first, id DESC as the tiebreak (matches the SQL ORDER BY). */
function compareDesc(a: AuditRecord, b: AuditRecord): number {
  const at = b.createdAt.getTime() - a.createdAt.getTime()
  if (at !== 0) return at
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** True when `record` sorts strictly after the anchor (i.e. belongs on a later page). */
function beforeAnchor(record: AuditRecord, anchor: CursorAnchor): boolean {
  const t = record.createdAt.getTime()
  const at = anchor.createdAt.getTime()
  if (t !== at) return t < at
  return record.id < anchor.id
}
