/**
 * Admin audit-log view service (Phase 2): the read side of the audit_log table (#67).
 *
 * Every admin write records an audit_log row via writeAudit (services/admin/audit.ts). This service is
 * the OPERATOR-facing reader: a paginated, filterable view of those rows (filter by actor / action /
 * target). It is read-only (no mutations) and infra-free: all access flows through AuditRepository so the
 * shaping (the row -> AuditLogEntryDTO projection, the actor-name resolution) is unit-testable with the
 * in-memory repo (audit-repository.memory.ts) and the raw-SQL impl (audit-repository.drizzle.ts) is
 * Docker-gated.
 *
 * Pagination reuses the shared keyset cursor (services/admin/pagination.ts): audit rows page newest-first
 * by (created_at DESC, id DESC) with the opaque "<iso>|<id>" cursor, identical to every other admin list.
 */

import type { AuditListQuery, AuditListResponse, AuditLogEntryDTO } from "@civfix/shared"
import { clampLimit } from "./pagination.js"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** Normalized list arguments the repo consumes (the filters + the page window). */
export interface ListAuditArgs {
  actor: string | null
  action: string | null
  target: string | null
  cursor: string | null
  limit: number
}

/**
 * An audit_log row projected into the service's record shape. `actorName` is the joined display name of
 * the acting user (null for a system action or an unknown actor); the rest mirror the columns.
 */
export interface AuditRecord {
  id: string
  actorId: string | null
  actorName: string | null
  action: string
  target: string | null
  meta: Record<string, unknown> | null
  createdAt: Date
}

/**
 * Persistence seam for the audit-log view. The Drizzle impl runs one raw SQL read (LEFT JOIN users for
 * the actor name) with a keyset cursor + the optional filters; the offline tests pass an in-memory impl.
 */
export interface AuditRepository {
  /** Page audit rows newest-first applying the actor / action / target filters with a keyset cursor. */
  list(args: ListAuditArgs): Promise<{ records: AuditRecord[]; nextCursor: string | null }>
}

// ---------------------------------------------------------------------------
// Pure projection (no DB, no IO)
// ---------------------------------------------------------------------------

/**
 * Project an audit record into the strict AuditLogEntryDTO. `target` falls back to "" so the strict DTO
 * (which requires a string) stays valid for a NULL target; `meta` falls back to {} for a NULL meta.
 */
export function toAuditEntryDTO(record: AuditRecord): AuditLogEntryDTO {
  return {
    id: record.id,
    actorId: record.actorId,
    actorName: record.actorName,
    action: record.action,
    target: record.target ?? "",
    meta: record.meta ?? {},
    createdAt: record.createdAt.toISOString(),
  }
}

/** Trim a query filter to null when absent/blank (so the repo only filters on a real value). */
function cleanFilter(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
