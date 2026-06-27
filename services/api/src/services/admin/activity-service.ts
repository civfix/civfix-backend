
import { relativeAgo } from "@civfix/shared"
import type { ActivityItemDTO, ActivityKind, ActivityListResponse } from "@civfix/shared"
import { clampLimit } from "./pagination.js"

export type ActivitySource = "audit" | "report" | "cleanup" | "mail_event"

export interface ActivitySourceRecord {
  source: ActivitySource
  id: string
  ts: Date
  who: string
  where: string
  action?: string | null
  eventType?: string | null
  subject?: string | null
}

export const ACTIVITY_DEFAULT_LIMIT = 25

export interface ActivityRepository {
  recent(limit: number): Promise<ActivitySourceRecord[]>
}

const KIND_HUE: Record<ActivityKind, string> = {
  pin: "#38bdf8",
  claim: "#a78bfa",
  discovery_done: "#34d399",
  outreach_bounce: "#f87171",
  mod_action: "#fbbf24",
  gov_onboard: "#22d3ee",
  outreach_open: "#4ade80",
  cleanup_plan: "#facc15",
}

export function classifyAuditAction(action: string): ActivityKind {
  if (action.startsWith("gov_claim.")) return "gov_onboard"
  if (action.startsWith("discovery.")) return "discovery_done"
  if (action.startsWith("outreach.")) return "outreach_open"
  if (action.startsWith("mail.")) return "outreach_open"
  return "mod_action"
}

export function describeAuditAction(action: string): string {
  const map: Record<string, string> = {
    "operator.login": "Operator signed in",
    "operator.logout": "Operator signed out",
    "discovery.contacts_saved": "Saved routing contacts",
    "discovery.draft_saved": "Saved a routing draft",
    "discovery.note_added": "Added a discovery note",
    "discovery.flagged": "Flagged a jurisdiction",
    "jurisdiction.patched": "Updated a jurisdiction",
    "report.status_changed": "Changed a report status",
    "report.flagged": "Flagged a report",
    "report.unflagged": "Unflagged a report",
    "report.removed": "Removed a report",
    "report.followup_sent": "Sent a report follow-up",
    "event.status_changed": "Changed an event status",
    "event.flagged": "Flagged an event",
    "event.unflagged": "Unflagged an event",
    "event.cancelled": "Cancelled an event",
    "event.message_posted": "Messaged event attendees",
    "user.flagged": "Flagged an account",
    "user.unflagged": "Unflagged an account",
    "user.status_changed": "Changed an account status",
    "user.banned": "Banned an account",
    "user.role_changed": "Changed an account role",
    "gov_claim.verified": "Verified a gov claim check",
    "gov_claim.approved": "Approved a gov claim",
    "gov_claim.rejected": "Rejected a gov claim",
    "moderation.approved": "Approved a held item",
    "moderation.removed": "Removed a flagged item",
    "moderation.held": "Extended a hold",
    "moderation.appeal_decided": "Decided an appeal",
    "mail.sent": "Sent outreach mail",
    "mail.replied": "Replied to a thread",
    "mail.resent": "Resent a message",
    "mail.status_changed": "Updated a mail thread",
    "outreach.digest_sent": "Sent an outreach digest",
  }
  return map[action] ?? action
}

export function classifyActivity(record: ActivitySourceRecord, ref: Date): ActivityItemDTO {
  const ts = relativeAgo(record.ts, ref)
  if (record.source === "report") {
    const cat = record.subject && record.subject.trim() !== "" ? record.subject : "issue"
    return item("pin", record.who || "A neighbor", `New ${cat} report`, record.where, ts)
  }
  if (record.source === "cleanup") {
    const title = record.subject && record.subject.trim() !== "" ? record.subject : "cleanup"
    return item("cleanup_plan", record.who || "A neighbor", `Planned: ${title}`, record.where, ts)
  }
  if (record.source === "mail_event") {
    const type = record.eventType ?? ""
    if (type === "bounced") {
      return item("outreach_bounce", record.who || "Mail", "Outreach bounced", record.where, ts)
    }
    if (type === "failed") {
      return item("outreach_bounce", record.who || "Mail", "Outreach failed", record.where, ts)
    }
    if (type === "delivered") {
      return item("outreach_open", record.who || "Mail", "City replied", record.where, ts)
    }
    return item("outreach_open", record.who || "Mail", "Outreach sent", record.where, ts)
  }
  const action = record.action ?? ""
  const kind = classifyAuditAction(action)
  return item(kind, record.who || "Operator", describeAuditAction(action), record.where, ts)
}

function item(
  kind: ActivityKind,
  who: string,
  what: string,
  where: string,
  ts: string,
): ActivityItemDTO {
  return { kind, who, what, where, ts, hue: KIND_HUE[kind] }
}

export interface ActivityServiceDeps {
  repo: ActivityRepository
  now?: () => Date
}

export interface ActivityService {
  list(query: { limit?: number }): Promise<ActivityListResponse>
}

export function makeActivityService(deps: ActivityServiceDeps): ActivityService {
  const now = deps.now ?? (() => new Date())
  return {
    async list(query: { limit?: number }): Promise<ActivityListResponse> {
      const ref = now()
      const limit = clampLimit(query.limit ?? ACTIVITY_DEFAULT_LIMIT)
      const records = await deps.repo.recent(limit)
      return { items: records.map((r) => classifyActivity(r, ref)), nextCursor: null }
    },
  }
}
