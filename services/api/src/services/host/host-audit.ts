import type { Queryable } from "../../db/client.js"
import { writeAudit, type WriteAuditInput } from "../admin/audit.js"

export type HostAuditAction =
  | "event.guests_viewed"
  | "event.roster_viewed"
  | "event.answers_viewed"
  | "event.roster_exported"
  | "event.attendee_removed"
  | "event.attendee_registered_by_host"
  | "event.team_invited"
  | "event.team_invite_revoked"
  | "event.team_role_changed"
  | "event.host_transferred"
  | "org.verification_submitted"
  | "org.verification_verified"
  | "org.verification_rejected"
  | "org.member_role_changed"
  | "org.member_removed"
  | "org.member_added"
  | "org.ownership_transferred"
  | "org.created"
  | "org.updated"
  | "org.suspended"
  | "org.unsuspended"
  | "org.invite_created"
  | "org.invite_revoked"
  | "org.invite_accepted"
  | "org.detail_viewed"
  | "org.verifications_viewed"
  | "org.list_viewed"
  | "org.members_viewed"
  | "org.events_viewed"

export interface HostAuditInput {
  actorId: string
  action: HostAuditAction
  target: string
  meta?: Record<string, unknown> | null
}

export interface HostAuditLogger {
  warn(obj: unknown, msg?: string): void
}

export interface HostAuditSink {
  record(input: HostAuditInput): Promise<void>
}

export function writeHostAudit(tx: Queryable, input: HostAuditInput): Promise<string> {
  return writeAudit(tx, input satisfies WriteAuditInput)
}

export function makeHostAuditSink(sql: Queryable, logger?: HostAuditLogger): HostAuditSink {
  return {
    async record(input: HostAuditInput): Promise<void> {
      try {
        await writeHostAudit(sql, input)
      } catch (err) {
        logger?.warn(
          { err, action: input.action, target: input.target },
          "host audit write failed (suppressed)",
        )
      }
    },
  }
}

export const NULL_HOST_AUDIT_SINK: HostAuditSink = {
  record: () => Promise.resolve(),
}
