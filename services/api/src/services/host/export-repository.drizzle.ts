import type { HostExportKind, HostExportStatus } from "@civfix/shared"
import type { Sql } from "../../db/client.js"

export interface HostExportRecord {
  id: string
  cleanupId: string | null
  organizationId: string | null
  requestedBy: string
  kind: HostExportKind
  filters: Record<string, unknown>
  status: HostExportStatus
  r2Key: string | null
  rowCount: number | null
  byteSize: number | null
  truncated: boolean
  errorCode: string | null
  runToken: string | null
  requestedAt: Date
  startedAt: Date | null
  completedAt: Date | null
  expiresAt: Date | null
}

export interface HostExportRepository {
  create(input: {
    cleanupId: string | null
    organizationId: string | null
    requestedBy: string
    kind: HostExportKind
    filters: Record<string, unknown>
  }): Promise<HostExportRecord>
  findById(exportId: string): Promise<HostExportRecord | null>
  listForEvent(cleanupId: string, limit: number): Promise<HostExportRecord[]>
  listForOrganization(organizationId: string, limit: number): Promise<HostExportRecord[]>
  claimForRun(exportId: string, staleBefore: Date): Promise<HostExportRecord | null>
  markReady(
    exportId: string,
    args: {
      r2Key: string
      rowCount: number
      byteSize: number
      truncated: boolean
      expiresAt: Date
      runToken: string | null
    },
  ): Promise<HostExportRecord | null>
  markFailed(exportId: string, errorCode: string): Promise<void>
  listExpired(now: Date, limit: number): Promise<HostExportRecord[]>
  markExpired(exportId: string): Promise<void>
  deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>
}

interface RowSelect {
  id: string
  cleanup_id: string | null
  organization_id: string | null
  requested_by: string
  kind: HostExportKind
  filters: Record<string, unknown>
  status: HostExportStatus
  r2_key: string | null
  row_count: number | null
  byte_size: string | number | null
  truncated: boolean
  error_code: string | null
  run_token: string | null
  requested_at: Date
  started_at: Date | null
  completed_at: Date | null
  expires_at: Date | null
}

function toRecord(row: RowSelect): HostExportRecord {
  return {
    id: row.id,
    cleanupId: row.cleanup_id,
    organizationId: row.organization_id,
    requestedBy: row.requested_by,
    kind: row.kind,
    filters: row.filters ?? {},
    status: row.status,
    r2Key: row.r2_key,
    rowCount: row.row_count,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    truncated: row.truncated,
    errorCode: row.error_code,
    runToken: row.run_token,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  }
}

export function makeDrizzleHostExportRepository(sql: Sql): HostExportRepository {
  return {
    async create(input) {
      const rows = await sql<RowSelect[]>`
        INSERT INTO host_exports (cleanup_id, organization_id, requested_by, kind, filters)
        VALUES (${input.cleanupId}, ${input.organizationId}, ${input.requestedBy}, ${input.kind},
                ${sql.json(input.filters as Parameters<typeof sql.json>[0])})
        RETURNING id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
                  row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
                  completed_at, expires_at`
      return toRecord(rows[0]!)
    },

    async findById(exportId) {
      const rows = await sql<RowSelect[]>`
        SELECT id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
               row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
               completed_at, expires_at
          FROM host_exports WHERE id = ${exportId} LIMIT 1`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listForEvent(cleanupId, limit) {
      const rows = await sql<RowSelect[]>`
        SELECT id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
               row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
               completed_at, expires_at
          FROM host_exports
         WHERE cleanup_id = ${cleanupId}
         ORDER BY requested_at DESC, id DESC
         LIMIT ${limit}`
      return rows.map(toRecord)
    },

    async listForOrganization(organizationId, limit) {
      const rows = await sql<RowSelect[]>`
        SELECT id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
               row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
               completed_at, expires_at
          FROM host_exports
         WHERE organization_id = ${organizationId}
         ORDER BY requested_at DESC, id DESC
         LIMIT ${limit}`
      return rows.map(toRecord)
    },

    async claimForRun(exportId, staleBefore) {
      const rows = await sql<RowSelect[]>`
        UPDATE host_exports
           SET status = 'running', started_at = now(), run_token = gen_random_uuid()
         WHERE id = ${exportId}
           AND (status = 'queued'
                OR (status = 'running' AND started_at IS NOT NULL AND started_at < ${staleBefore}))
        RETURNING id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
                  row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
                  completed_at, expires_at`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async markReady(exportId, args) {
      const rows = await sql<RowSelect[]>`
        UPDATE host_exports
           SET status = 'ready', r2_key = ${args.r2Key}, row_count = ${args.rowCount},
               byte_size = ${args.byteSize}, truncated = ${args.truncated},
               completed_at = now(), expires_at = ${args.expiresAt}
         WHERE id = ${exportId} AND status = 'running' AND run_token IS NOT DISTINCT FROM ${args.runToken}
        RETURNING id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
                  row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
                  completed_at, expires_at`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async markFailed(exportId, errorCode) {
      await sql`
        UPDATE host_exports
           SET status = 'failed', error_code = ${errorCode}, completed_at = now()
         WHERE id = ${exportId} AND status IN ('queued','running')`
    },

    async listExpired(now, limit) {
      const rows = await sql<RowSelect[]>`
        SELECT id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
               row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
               completed_at, expires_at
          FROM host_exports
         WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ${now}
         ORDER BY expires_at
         LIMIT ${limit}`
      return rows.map(toRecord)
    },

    async markExpired(exportId) {
      await sql`
        UPDATE host_exports SET status = 'expired', r2_key = NULL WHERE id = ${exportId}`
    },

    async deleteOlderThan(cutoff, batchSize) {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM host_exports
         WHERE id IN (
           SELECT id FROM host_exports
            WHERE requested_at < ${cutoff}
            ORDER BY requested_at
            LIMIT ${batchSize}
         )
        RETURNING id`
      return rows.length
    },
  }
}
