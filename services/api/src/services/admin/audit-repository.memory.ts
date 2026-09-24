import type { AuditRecord, AuditRepository, ListAuditArgs } from "./audit-service.js"
import { decodeCursor, paginate, type CursorAnchor } from "./pagination.js"

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
  readonly rows: AuditRecord[] = []

  private seq = 0

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

  async list(args: ListAuditArgs): Promise<{ records: AuditRecord[]; nextCursor: string | null }> {
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

    const sorted = [...filtered].sort(compareDesc)
    const windowed = anchor !== null ? sorted.filter((r) => beforeAnchor(r, anchor)) : sorted

    const { items, nextCursor } = paginate(windowed, args.limit, (r) => ({
      createdAt: r.createdAt,
      id: r.id,
    }))
    return { records: items, nextCursor }
  }
}

function compareDesc(a: AuditRecord, b: AuditRecord): number {
  const at = b.createdAt.getTime() - a.createdAt.getTime()
  if (at !== 0) return at
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

// Strictly older than the anchor in the DESC order, i.e. on a later page.
function beforeAnchor(record: AuditRecord, anchor: CursorAnchor): boolean {
  const t = record.createdAt.getTime()
  const at = anchor.createdAt.getTime()
  if (t !== at) return t < at
  return record.id < anchor.id
}
