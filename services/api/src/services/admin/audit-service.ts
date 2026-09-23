import type { AuditListQuery, AuditListResponse, AuditLogEntryDTO } from "@civfix/shared"
import { clampLimit } from "./pagination.js"

export interface ListAuditArgs {
  actor: string | null
  action: string | null
  target: string | null
  cursor: string | null
  limit: number
}

export interface AuditRecord {
  id: string
  actorId: string | null
  /** Null for a system action or an unknown actor. */
  actorName: string | null
  action: string
  target: string | null
  meta: Record<string, unknown> | null
  createdAt: Date
}

export interface AuditRepository {
  list(args: ListAuditArgs): Promise<{ records: AuditRecord[]; nextCursor: string | null }>
}

// `created_at` is `DEFAULT now()` but nullable in the DDL: a hand-inserted NULL row would otherwise throw
// on `.toISOString()` and 500 the whole list.
export function toAuditEntryDTO(record: AuditRecord): AuditLogEntryDTO {
  return {
    id: record.id,
    actorId: record.actorId,
    actorName: record.actorName,
    action: record.action,
    target: record.target ?? "",
    meta: record.meta ?? {},
    createdAt: (record.createdAt ?? new Date(0)).toISOString(),
  }
}

function cleanFilter(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

export interface AuditServiceDeps {
  repo: AuditRepository
}

export interface AuditService {
  list(query: AuditListQuery): Promise<AuditListResponse>
}

export function makeAuditService(deps: AuditServiceDeps): AuditService {
  return {
    async list(query: AuditListQuery): Promise<AuditListResponse> {
      const args: ListAuditArgs = {
        actor: cleanFilter(query.actor),
        action: cleanFilter(query.action),
        target: cleanFilter(query.target),
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const { records, nextCursor } = await deps.repo.list(args)
      return { items: records.map(toAuditEntryDTO), nextCursor }
    },
  }
}
