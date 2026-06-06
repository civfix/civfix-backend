/**
 * Admin activity-feed service (Phase 2): the "Recent activity" feed (#6, enumeration 2.A.7 / 4.9).
 *
 * The feed is a UNION of two kinds of source:
 *   1. audit_log entries (operator / gov actions: contacts saved, status changed, moderation, gov
 *      approve, ...), and
 *   2. recent DOMAIN events that are NOT audit_log actions (a citizen dropping a pin, a cleanup being
 *      planned, an outbound mail bouncing), which the design explicitly calls out as part of the feed
 *      (4.9: "the feed is a UNION of audit_log + recent activity").
 *
 * The repo (ActivityRepository) returns the merged, newest-first, limited list of NORMALIZED source
 * records; the service maps each to the wire ActivityItemDTO ({ kind, who, what, where, ts, hue }). The
 * source -> { kind, what, hue } classification is a PURE helper (classifyActivity) so it is unit-testable
 * with seeded in-memory data; the hue is cosmetic (the design tints the leading icon).
 *
 * This feed is LIMIT-based (a recent window), not deep cursor pagination: the design renders "first 7"
 * with an "All" affordance that opens the audit view (#67). The shared response is still the standard
 * page envelope ({ items, nextCursor }); nextCursor is always null here (the feed is a capped recent
 * window, the audit view is the paginated drill-down).
 */

import { relativeAgo } from "@civfix/shared"
import type { ActivityItemDTO, ActivityKind, ActivityListResponse } from "@civfix/shared"
import { clampLimit } from "./pagination.js"

// ---------------------------------------------------------------------------
// Repository seam (normalized source records; faked in tests)
// ---------------------------------------------------------------------------

/** The kind of underlying source a feed record came from (drives the classification). */
export type ActivitySource = "audit" | "report" | "cleanup" | "mail_event"

/**
 * A normalized activity source record (one merged scan across audit_log + the recent domain tables). The
 * service classifies it into an ActivityItemDTO. `who` is the best available human label (the audit
 * actor's name, a report reporter, a cleanup organizer, or "" when unknown); `where` the best place
 * label; `action` / `eventType` carry the audit action / the mail event type for classification.
 */
export interface ActivitySourceRecord {
  source: ActivitySource
  id: string
  ts: Date
  who: string
  where: string
  /** audit_log.action (only for source 'audit'). */
  action?: string | null
  /** mail_events.type (only for source 'mail_event'). */
  eventType?: string | null
  /** A short subject label (report title/category, cleanup title, audit target) used in `what`. */
  subject?: string | null
}

/** How many recent items the feed returns by default (the design shows ~7). */
export const ACTIVITY_DEFAULT_LIMIT = 25

/**
 * Persistence seam for the activity feed. The Drizzle impl runs ONE union query over audit_log + reports +
 * cleanups + mail_events, newest-first, limited; the offline tests pass an in-memory impl.
 */
export interface ActivityRepository {
  /** Return the merged, newest-first, limited list of source records (across all sources). */
  recent(limit: number): Promise<ActivitySourceRecord[]>
}

// ---------------------------------------------------------------------------
// Pure classification (no DB, no IO)
// ---------------------------------------------------------------------------

/** A cosmetic hue per kind (the design tints the leading icon). Stable hex-ish tokens. */
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

/**
 * Map an audit_log action to a feed kind. Operator/gov actions collapse into the design's activity kinds:
 *   - gov_claim.approved          -> gov_onboard
 *   - discovery.contacts_saved    -> discovery_done
 *   - moderation.*                -> mod_action
 *   - report.* / anon claim       -> claim (an account/report action by an operator/citizen)
 *   - mail.* sent/replied         -> outreach_open (an outbound mail touch)
 * Anything unrecognized falls back to mod_action (a generic operator action), so the feed never drops a
 * real audited action.
 */
export function classifyAuditAction(action: string): ActivityKind {
  if (action.startsWith("gov_claim.")) return "gov_onboard"
  if (action.startsWith("discovery.")) return "discovery_done"
  if (action.startsWith("moderation.")) return "mod_action"
  if (action.startsWith("outreach.")) return "outreach_open"
  if (action.startsWith("mail.")) return "outreach_open"
  if (action === "report.removed" || action.startsWith("user.")) return "mod_action"
  if (action.startsWith("report.") || action.startsWith("event.")) return "mod_action"
  return "mod_action"
}

/** A short human verb phrase for an audit action (the design's `what`). */
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

/**
 * Classify a normalized source record into the feed DTO. Pure (clock-injected for the relative `ts`).
 *   - report      -> kind 'pin' ("New <category> report")
 *   - cleanup     -> kind 'cleanup_plan' ("New cleanup planned")
 *   - mail_event  -> 'outreach_bounce' (bounced/complained) | 'outreach_open' (opened) | 'outreach_open'
 *   - audit       -> classifyAuditAction + describeAuditAction
 */
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
    if (type === "bounced" || type === "complained") {
      return item("outreach_bounce", record.who || "Mail", "Outreach bounced", record.where, ts)
    }
    if (type === "opened") {
      return item("outreach_open", record.who || "Mail", "Outreach opened", record.where, ts)
    }
    return item("outreach_open", record.who || "Mail", "Outreach delivered", record.where, ts)
  }
  // audit
  const action = record.action ?? ""
  const kind = classifyAuditAction(action)
  return item(kind, record.who || "Operator", describeAuditAction(action), record.where, ts)
}

/** Build a strict ActivityItemDTO with the kind's hue. */
function item(
  kind: ActivityKind,
  who: string,
  what: string,
  where: string,
  ts: string,
): ActivityItemDTO {
  return { kind, who, what, where, ts, hue: KIND_HUE[kind] }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ActivityServiceDeps {
  repo: ActivityRepository
  /** Injectable clock (defaults to Date.now) so the relative `ts` labels are deterministic. */
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
