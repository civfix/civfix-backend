import type { HostExportKind, HostExportStatus } from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import type { WriteAuditInput } from "../admin/audit.js"
import { insertAuditRow } from "../admin/audit-repository.drizzle.js"

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
  create(
    input: {
      cleanupId: string | null
      organizationId: string | null
      requestedBy: string
      kind: HostExportKind
      filters: Record<string, unknown>
    },
    audit?: (exportId: string) => WriteAuditInput,
  ): Promise<HostExportRecord>
  findById(exportId: string): Promise<HostExportRecord | null>
  listForEvent(cleanupId: string, limit: number): Promise<HostExportRecord[]>
  listForOrganization(organizationId: string, limit: number): Promise<HostExportRecord[]>
  claimForRun(exportId: string, staleBefore: Date): Promise<HostExportRecord | null>
  /**
   * Records the run's object key. `replaces` names the key the row must still hold (null for none): a
   * re-claimed row keeps the crashed run's key, and overwriting it unseen would orphan that object.
   */
  recordObjectKey(
    exportId: string,
    args: { r2Key: string; runToken: string | null; replaces: string | null },
  ): Promise<boolean>
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
  /** Fails the run holding `runToken`; the row keeps any object key for the reaper to delete. */
  markFailed(exportId: string, errorCode: string, runToken: string | null): Promise<boolean>
  listExpired(now: Date, limit: number): Promise<HostExportRecord[]>
  markExpired(exportId: string): Promise<void>
  listOrphaned(args: { staleBefore: Date; limit: number }): Promise<HostExportRecord[]>
  releaseObject(
    record: Pick<HostExportRecord, "id" | "status" | "runToken">,
    errorCode: string,
  ): Promise<boolean>
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
    create(input, audit) {
      // The export hands member PII out of the platform, so its request is never on record without
      // its audit row: both commit or neither does.
      return sql.begin(async (tx) => {
        const rows = await tx<RowSelect[]>`
          INSERT INTO host_exports (cleanup_id, organization_id, requested_by, kind, filters)
          VALUES (${input.cleanupId}, ${input.organizationId}, ${input.requestedBy}, ${input.kind},
                  ${tx.json(input.filters as Parameters<typeof tx.json>[0])})
          RETURNING id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
                    row_count, byte_size, truncated, error_code, run_token, requested_at,
                    started_at, completed_at, expires_at`
        const record = toRecord(rows[0]!)
        if (audit !== undefined) await insertAuditRow(tx, audit(record.id))
        return record
      }) as Promise<HostExportRecord>
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

    async recordObjectKey(exportId, args) {
      const rows = await sql<{ id: string }[]>`
        UPDATE host_exports SET r2_key = ${args.r2Key}
         WHERE id = ${exportId} AND status = 'running' AND run_token IS NOT DISTINCT FROM ${args.runToken}
           AND r2_key IS NOT DISTINCT FROM ${args.replaces}
        RETURNING id`
      return rows.length > 0
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

    async markFailed(exportId, errorCode, runToken) {
      const rows = await sql<{ id: string }[]>`
        UPDATE host_exports
           SET status = 'failed', error_code = ${errorCode}, completed_at = now()
         WHERE id = ${exportId} AND status IN ('queued','running')
           AND run_token IS NOT DISTINCT FROM ${runToken}
        RETURNING id`
      return rows.length > 0
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

    async listOrphaned({ staleBefore, limit }) {
      const rows = await sql<RowSelect[]>`
        SELECT id, cleanup_id, organization_id, requested_by, kind, filters, status, r2_key,
               row_count, byte_size, truncated, error_code, run_token, requested_at, started_at,
               completed_at, expires_at
          FROM host_exports
         WHERE (status = 'failed' AND r2_key IS NOT NULL)
            OR (status = 'running' AND started_at < ${staleBefore})
            OR (status = 'queued' AND requested_at < ${staleBefore})
         ORDER BY requested_at
         LIMIT ${limit}`
      return rows.map(toRecord)
    },

    async releaseObject(record, errorCode) {
      const rows = await sql<{ id: string }[]>`
        UPDATE host_exports
           SET status = 'failed', error_code = COALESCE(error_code, ${errorCode}), r2_key = NULL,
               completed_at = COALESCE(completed_at, now())
         WHERE id = ${record.id} AND status = ${record.status}
           AND run_token IS NOT DISTINCT FROM ${record.runToken}
        RETURNING id`
      return rows.length > 0
    },

    /** A row that still names an object is kept until the reaper has deleted that object. */
    async deleteOlderThan(cutoff, batchSize) {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM host_exports
         WHERE id IN (
           SELECT id FROM host_exports
            WHERE requested_at < ${cutoff} AND r2_key IS NULL
            ORDER BY requested_at
            LIMIT ${batchSize}
         )
        RETURNING id`
      return rows.length
    },
  }
}

export interface HostExportRosterRow {
  registration_id: string
  attendee_name: string | null
  attendee_kind: string
  ticket_type: string | null
  seats: number
  slot: string | null
  status: string
  registered_at: Date
  checked_in_at: Date | null
  checkin_method: string | null
  guest_email: string | null
  guest_phone: string | null
}

export interface HostExportCheckinRow {
  id: string
  attendee_name: string | null
  attendee_kind: string
  ticket_type: string | null
  checked_in_at: Date | null
  checkin_method: string | null
  no_show_at: Date | null
}

export interface HostExportAnswerRow {
  id: string
  registration_id: string
  attendee_kind: string
  prompt: string
  value_text: string | null
  value_json: unknown
  scrubbed_at: Date | null
  created_at: Date
}

export interface HostExportRowsRepository {
  rosterPage(cleanupId: string | null, after: string, limit: number): Promise<HostExportRosterRow[]>
  checkinPage(
    cleanupId: string | null,
    after: string,
    limit: number,
  ): Promise<HostExportCheckinRow[]>
  answerPage(cleanupId: string | null, after: string, limit: number): Promise<HostExportAnswerRow[]>
}

export function makeDrizzleHostExportRowsRepository(sql: Sql): HostExportRowsRepository {
  return {
    async rosterPage(cleanupId, after, limit) {
      return sql<HostExportRosterRow[]>`
        SELECT r.id AS registration_id,
               COALESCE(NULLIF(min(s.attendee_name), ''), g.name, u.display_name) AS attendee_name,
               CASE WHEN r.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS attendee_kind,
               t.name AS ticket_type,
               count(s.id)::int AS seats,
               (SELECT string_agg(sl.title, '; ' ORDER BY sl.title)
                  FROM cleanup_slot_claims sc
                  JOIN cleanup_slots sl ON sl.id = sc.slot_id
                 WHERE sc.cleanup_id = r.cleanup_id AND sc.user_id = r.user_id) AS slot,
               r.status,
               r.registered_at,
               min(s.checked_in_at) AS checked_in_at,
               min(s.checkin_method) AS checkin_method,
               g.email AS guest_email,
               g.phone AS guest_phone
          FROM cleanup_registrations r
          LEFT JOIN cleanup_registration_seats s ON s.registration_id = r.id
          LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
          LEFT JOIN cleanup_guests g ON g.id = r.guest_id
          LEFT JOIN users u ON u.id = r.user_id
         WHERE r.cleanup_id = ${cleanupId}
           AND (${after} = '' OR r.id > ${after}::uuid)
         GROUP BY r.id, r.cleanup_id, r.user_id, r.status, r.registered_at,
                  g.name, u.display_name, t.name, g.email, g.phone
         ORDER BY r.id
         LIMIT ${limit}`
    },

    async checkinPage(cleanupId, after, limit) {
      return sql<HostExportCheckinRow[]>`
        SELECT s.id,
               COALESCE(NULLIF(s.attendee_name, ''), g.name, u.display_name) AS attendee_name,
               CASE WHEN r.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS attendee_kind,
               t.name AS ticket_type,
               s.checked_in_at, s.checkin_method, s.no_show_at
          FROM cleanup_registration_seats s
          JOIN cleanup_registrations r ON r.id = s.registration_id
          LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
          LEFT JOIN cleanup_guests g ON g.id = r.guest_id
          LEFT JOIN users u ON u.id = r.user_id
         WHERE s.cleanup_id = ${cleanupId}
           AND (${after} = '' OR s.id > ${after}::uuid)
         ORDER BY s.id
         LIMIT ${limit}`
    },

    async answerPage(cleanupId, after, limit) {
      return sql<HostExportAnswerRow[]>`
        SELECT a.id, a.registration_id,
               CASE WHEN r.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS attendee_kind,
               q.prompt, a.value_text, a.value_json, a.scrubbed_at, a.created_at
          FROM cleanup_answers a
          JOIN cleanup_registrations r ON r.id = a.registration_id
          JOIN cleanup_questions q ON q.id = a.question_id
         WHERE a.cleanup_id = ${cleanupId}
           AND (${after} = '' OR a.id > ${after}::uuid)
         ORDER BY a.id
         LIMIT ${limit}`
    },
  }
}
