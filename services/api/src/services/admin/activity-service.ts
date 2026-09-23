/**
 * Admin activity-feed service (Phase 2): the merged recent-activity feed's CLASSIFICATION + query
 * normalization. The repository (activity-repository.drizzle.ts) unions the four sources and pages them;
 * this module turns a normalized source row into the wire DTO.
 *
 * The kind vocabulary is declared ONCE here (AUDIT_ACTION_RULES / KIND_SOURCES / MAIL_BOUNCE_EVENT_TYPES)
 * and read by BOTH `classifyAuditAction` below and the repository's `filter=<kind>` SQL predicate. A second
 * copy of those prefixes inside a WHERE clause is exactly how a facet starts disagreeing with the chip it
 * filters — the feed would show a row under one kind and hide it under that kind's own filter.
 */

import { relativeAgo, ActivityKindSchema } from "@civfix/shared"
import type {
  ActivityItemDTO,
  ActivityKind,
  ActivityListQuery,
  ActivityListResponse,
} from "@civfix/shared"
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

/** The facet: "all" or one ActivityKind (the chip the operator clicked). */
export type ActivityFilter = "all" | ActivityKind

/** Feed direction. "newest" is the default; "oldest" walks the same keyset the other way. */
export type ActivitySort = "newest" | "oldest"

/** Normalized list arguments the repository consumes (search + facet + direction + page window). */
export interface ListActivityArgs {
  q: string | null
  filter: ActivityFilter
  sort: ActivitySort
  cursor: string | null
  limit: number
}

export interface ActivityRepository {
  /** Page the merged feed applying the search + kind facet + direction. */
  list(
    args: ListActivityArgs,
  ): Promise<{ records: ActivitySourceRecord[]; nextCursor: string | null }>
}

/**
 * `filter` / `sort` are free-form `z.ZodString` on the wire (ActivityListQuerySchema), so an unrecognized
 * value must degrade to the default rather than 422 or reach SQL — the server owns this vocabulary.
 */
export function parseActivityFilter(filter: string | undefined): ActivityFilter {
  if (filter === undefined || filter === "" || filter === "all") return "all"
  const parsed = ActivityKindSchema.safeParse(filter)
  return parsed.success ? parsed.data : "all"
}

export function parseActivitySort(sort: string | undefined): ActivitySort {
  return sort === "oldest" ? "oldest" : "newest"
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

/** One audit-action match: a dotted-namespace `prefix`, or one `exact` action. */
export type AuditActionRule =
  | { kind: ActivityKind; prefix: string; exact?: undefined }
  | { kind: ActivityKind; exact: string; prefix?: undefined }

/**
 * The audit-action -> ActivityKind rules in EVALUATION ORDER (first match wins). The repository builds its
 * `filter=<kind>` predicate for the audit branch from this same table, so the chip and the classifier
 * cannot disagree. Order matters: `report.routed` must be tested before the `report.` family falls through
 * to the catch-all.
 */
export const AUDIT_ACTION_RULES: readonly AuditActionRule[] = [
  { kind: "gov_onboard", prefix: "gov_claim." },
  { kind: "discovery_done", prefix: "discovery." },
  { kind: "outreach_open", prefix: "outreach." },
  { kind: "outreach_open", prefix: "mail." },
  // Forwarding a report to its jurisdiction IS outreach, not moderation — the `report.` prefix would
  // otherwise paint it the amber mod-action hue alongside flags and removals.
  { kind: "outreach_open", exact: "report.routed" },
  { kind: "outreach_open", prefix: "inbox." },
]

/** The kind an audit action matching NO rule falls back to (so a future action still renders). */
export const AUDIT_FALLBACK_KIND: ActivityKind = "mod_action"

/** The mail_events.type values that mean the outreach did not land (the rest are outreach_open). */
export const MAIL_BOUNCE_EVENT_TYPES = ["bounced", "failed"] as const

export function isMailBounceEventType(type: string): boolean {
  return (MAIL_BOUNCE_EVENT_TYPES as readonly string[]).includes(type)
}

/**
 * Which union branches can produce each kind — the repository prunes branches with this, so a filtered
 * page never scans a source that cannot contribute a row. Maintained BESIDE classifyActivity below; the
 * failure mode of a wrong entry is an empty page, never a misfiled row (the branch's own predicate still
 * decides), which is why this is a lookup and not a second classifier.
 */
const KIND_SOURCES: Record<ActivityKind, readonly ActivitySource[]> = {
  pin: ["report"],
  cleanup_plan: ["cleanup"],
  outreach_bounce: ["mail_event"],
  outreach_open: ["mail_event", "audit"],
  gov_onboard: ["audit"],
  discovery_done: ["audit"],
  mod_action: ["audit"],
  // NO source produces `claim` today: a gov claim arrives as a `gov_claim.*` audit row -> gov_onboard. The
  // value stays in the contract enum, so filtering on it yields an empty page rather than an error.
  claim: [],
}

/** The union branches that can produce `kind`. */
export function sourcesForKind(kind: ActivityKind): readonly ActivitySource[] {
  return KIND_SOURCES[kind]
}

/**
 * The rules whose kind is `kind`. EMPTY for AUDIT_FALLBACK_KIND — that kind is defined by EXCLUSION, so a
 * caller building SQL must negate every rule in AUDIT_ACTION_RULES instead of matching these.
 */
export function auditRulesForKind(kind: ActivityKind): readonly AuditActionRule[] {
  return AUDIT_ACTION_RULES.filter((rule) => rule.kind === kind)
}

function matchesRule(action: string, rule: AuditActionRule): boolean {
  return rule.exact !== undefined ? action === rule.exact : action.startsWith(rule.prefix)
}

export function classifyAuditAction(action: string): ActivityKind {
  for (const rule of AUDIT_ACTION_RULES) {
    if (matchesRule(action, rule)) return rule.kind
  }
  return AUDIT_FALLBACK_KIND
}

/**
 * Human label per audit action. Covers every literal in the AdminAuditAction catalogue (audit.ts) — an
 * unlabelled action renders as its raw dotted string in the operator's feed, which is how `report.routed`
 * and the user.verified family used to surface. An unknown//future action still falls back to the raw
 * string rather than failing.
 */
export function describeAuditAction(action: string): string {
  const map: Record<string, string> = {
    "operator.login": "Operator signed in",
    "operator.logout": "Operator signed out",
    "discovery.contacts_saved": "Saved routing contacts",
    "discovery.draft_saved": "Saved a routing draft",
    "discovery.note_added": "Added a discovery note",
    "discovery.flagged": "Flagged a jurisdiction",
    // Written by the PUBLIC suggest-contact endpoint, not an operator (the feed's `who` is the row's actor).
    "discovery.contact_suggested": "Suggested a routing contact",
    "jurisdiction.patched": "Updated a jurisdiction",
    "report.status_changed": "Changed a report status",
    "report.flagged": "Flagged a report",
    "report.unflagged": "Unflagged a report",
    "report.removed": "Removed a report",
    "report.followup_sent": "Sent a report follow-up",
    "report.verdict_set": "Set a report verdict",
    "report.routed": "Forwarded a report to the city",
    "event.status_changed": "Changed an event status",
    "event.flagged": "Flagged an event",
    "event.unflagged": "Unflagged an event",
    "event.cancelled": "Cancelled an event",
    "event.message_posted": "Messaged event attendees",
    "event.outcome_logged": "Logged an event outcome",
    "event.reports_linked": "Linked reports to an event",
    "event.report_unlinked": "Unlinked a report from an event",
    "user.flagged": "Flagged an account",
    "user.unflagged": "Unflagged an account",
    "user.status_changed": "Changed an account status",
    "user.banned": "Banned an account",
    "user.role_changed": "Changed an account role",
    "user.verified": "Verified an account",
    "user.unverified": "Removed an account's verification",
    "user.report_verified": "Granted report-verified status",
    "user.report_unverified": "Revoked report-verified status",
    "message.removed": "Removed a message",
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
    "mail.send_failed": "A send to a jurisdiction failed",
    "mail.status_changed": "Updated a mail thread",
    "mail.forward_template_set": "Updated the default forwarding template",
    "outreach.digest_sent": "Sent an outreach digest",
    "inbox.status_changed": "Updated an inbox message",
    // The L4 read audits are filtered out of the feed at the repo (AUDIT_READ_ACTIONS), so these labels
    // only matter if a row reaches the classifier another way (a fake, or a future feed that includes them).
    "user.detail_viewed": "Viewed an account",
    "user.messages_viewed": "Viewed an account's messages",
    "inbox.message_viewed": "Viewed an inbox message",
    "mail.thread_viewed": "Viewed a mail thread",
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
    // The KIND comes from MAIL_BOUNCE_EVENT_TYPES (the same list the repo's outreach_bounce filter uses);
    // only the label distinguishes the two members.
    if (isMailBounceEventType(type)) {
      const what = type === "failed" ? "Outreach failed" : "Outreach bounced"
      return item("outreach_bounce", record.who || "Mail", what, record.where, ts)
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
  list(query: ActivityListQuery): Promise<ActivityListResponse>
}

export function makeActivityService(deps: ActivityServiceDeps): ActivityService {
  const now = deps.now ?? (() => new Date())
  return {
    async list(query: ActivityListQuery): Promise<ActivityListResponse> {
      const ref = now()
      const args: ListActivityArgs = {
        q: query.q !== undefined && query.q.trim() !== "" ? query.q.trim() : null,
        filter: parseActivityFilter(query.filter),
        sort: parseActivitySort(query.sort),
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit ?? ACTIVITY_DEFAULT_LIMIT),
      }
      const { records, nextCursor } = await deps.repo.list(args)
      return { items: records.map((r) => classifyActivity(r, ref)), nextCursor }
    },
  }
}
