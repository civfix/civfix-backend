import type { HostExportKind, HostExportStatus } from "@civfix/shared"
import type { WriteAuditInput } from "../admin/audit.js"

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
