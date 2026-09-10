
import type { Queryable } from "../../db/client.js"

export type AdminAuditAction =
  | "operator.login"
  | "operator.logout"
  | "discovery.contacts_saved"
  | "discovery.draft_saved"
  | "discovery.note_added"
  | "discovery.flagged"
  | "jurisdiction.patched"
  | "report.status_changed"
  | "report.flagged"
  | "report.unflagged"
  | "report.removed"
  | "report.followup_sent"
  | "report.routed"
  | "event.status_changed"
  | "event.flagged"
  | "event.unflagged"
  | "event.cancelled"
  | "event.message_posted"
  | "user.flagged"
  | "user.unflagged"
  | "user.status_changed"
  | "user.banned"
  | "user.role_changed"
  | "user.verified"
  | "user.unverified"
  | "gov_claim.verified"
  | "gov_claim.approved"
  | "gov_claim.rejected"
  | "moderation.approved"
  | "moderation.removed"
  | "moderation.held"
  | "moderation.appeal_decided"
  | "mail.sent"
  | "mail.replied"
  | "mail.resent"
  | "mail.status_changed"
  | "outreach.digest_sent"
  | "inbox.status_changed"
  | "user.detail_viewed"
  | "user.messages_viewed"
  | "inbox.message_viewed"
  | "mail.thread_viewed"
  | "media.viewed"
  | "org.detail_viewed"
  | "org.verifications_viewed"
  | "event.roster_viewed"
  | "event.guests_viewed"
  | "event.answers_viewed"
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
  | "org.list_viewed"
  | "org.members_viewed"
  | "org.events_viewed"
  | "event.host_transferred"
  | "event.team_invited"
  | "event.team_invite_revoked"
  | "event.team_role_changed"
  | "event.attendee_removed"
  | "event.attendee_transferred"
  | "event.attendee_note_set"
  | "event.attendee_registered_by_host"
  | "event.attendee_checked_in"
  | "event.attendee_checkin_undone"
  | "event.attendees_marked_no_show"
  | "event.waitlist_promoted"
  | "event.page_published"
  | "event_page.flagged"
  | "event_page.unflagged"
  | "event_page.unpublished"
  | "event.broadcast_sent"
  | "event.broadcast_test_sent"
  | "event.broadcast_killed"
  | "event.roster_exported"
  | "host.messaging_suspended"
  | "host.messaging_restored"
  | (string & {})

export const AUDIT_READ_ACTIONS: readonly AdminAuditAction[] = [
  "user.detail_viewed",
  "user.messages_viewed",
  "inbox.message_viewed",
  "mail.thread_viewed",
  "media.viewed",
  "org.detail_viewed",
  "org.verifications_viewed",
  "org.list_viewed",
  "org.members_viewed",
  "org.events_viewed",
  "event.roster_viewed",
  "event.guests_viewed",
  "event.answers_viewed",
]

export interface WriteAuditInput {
  actorId?: string | null
  action: AdminAuditAction
  target?: string | null
  meta?: Record<string, unknown> | null
}

export async function writeAudit(db: Queryable, input: WriteAuditInput): Promise<string> {
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
