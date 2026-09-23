import type { AuditRecord, AuditRepository, ListAuditArgs } from "./audit-service.js"
import { pageBeforeTimeCursor, parseKeysetCursor } from "../../db/cursor-helpers.js"

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
    const anchor = parseKeysetCursor(args.cursor, { requireUuid: false })
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
    const { items, nextCursor } = pageBeforeTimeCursor(sorted, anchor, args.limit, (r) => ({
      at: r.createdAt,
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
