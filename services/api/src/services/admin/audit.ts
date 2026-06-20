/**
 * Audit log helper (Phase 2). EVERY admin write calls writeAudit so the activity feed and the
 * audit-log view (both read `audit_log`) record who did what. civfixplan done-gate: "all admin actions
 * are audited."
 *
 * The action string is a stable, dotted, lower_snake convention: `<domain>.<verb>` (e.g.
 * `operator.login`, `discovery.contacts_saved`, `report.status_changed`, `user.banned`,
 * `gov_claim.approved`, `moderation.removed`, `mail.sent`). `AdminAuditAction` enumerates the actions
 * wave 2 will write; it is a UNION of string literals AND `string` so a new action does not require an
 * edit here, but the named members give call sites autocomplete + a discoverable catalogue.
 *
 * `db` is the raw postgres-js tag (`container.getDb().sql`), matching the hand-written SQL repos. We
 * insert via a parameterized tagged template (jsonb is serialized by postgres.js from a plain object),
 * so there is no string interpolation of untrusted values. `target` is a free-form reference string,
 * conventionally `<type>:<id>` (e.g. `report:<uuid>`, `gov_claim:<uuid>`).
 */

import type { Queryable } from "../../db/client.js"

/**
 * Stable admin audit action catalogue. The trailing `(string & {})` keeps the union OPEN so a
 * not-yet-listed action still typechecks (wave 2 can add rows without editing this file) while the
 * named literals provide autocomplete. Grouped by domain to mirror the route groups.
 */
export type AdminAuditAction =
  // auth / session
  | "operator.login"
  | "operator.logout"
  // discovery / jurisdictions
  | "discovery.contacts_saved"
  | "discovery.draft_saved"
  | "discovery.note_added"
  | "discovery.flagged"
  | "jurisdiction.patched"
  // reports
  | "report.status_changed"
  | "report.flagged"
  | "report.unflagged"
  | "report.removed"
  | "report.followup_sent"
  | "report.routed"
  // events (cleanups)
  | "event.status_changed"
  | "event.flagged"
  | "event.unflagged"
  | "event.cancelled"
  | "event.message_posted"
  // users
  | "user.flagged"
  | "user.unflagged"
  | "user.status_changed"
  | "user.banned"
  | "user.role_changed"
  | "user.verified"
  | "user.unverified"
  // gov provisioning
  | "gov_claim.verified"
  | "gov_claim.approved"
  | "gov_claim.rejected"
  // moderation
  | "moderation.approved"
  | "moderation.removed"
  | "moderation.held"
  | "moderation.appeal_decided"
  // mail / outreach
  | "mail.sent"
  | "mail.replied"
  | "mail.resent"
  | "mail.status_changed"
  | "outreach.digest_sent"
  // escape hatch: any other dotted action wave 2 introduces
  | (string & {})

export interface WriteAuditInput {
  /** The acting operator's userId. Null/undefined for system-originated actions. */
  actorId?: string | null
  /** Stable dotted action, e.g. "report.status_changed". */
  action: AdminAuditAction
  /** Free-form subject reference, conventionally "<type>:<id>". Optional. */
  target?: string | null
  /** Action-specific detail (serialized to the jsonb `meta` column). Optional. */
  meta?: Record<string, unknown> | null
}

/**
 * Insert one audit_log row. Accepts the pooled tag OR a transaction-scoped tag (Queryable), so a caller
 * can record the audit inside the SAME transaction as the effect it audits (atomic "did + recorded").
 * Best practice: pass the transaction tag when one is open. Returns the new audit row id.
 *
 * `meta` is serialized to jsonb via the postgres.js `db.json(...)` value marker (the same pattern the
 * Phase 1 repos use for jsonb columns); a null/absent meta is written as SQL NULL.
 */
export async function writeAudit(db: Queryable, input: WriteAuditInput): Promise<string> {
  const actorId = input.actorId ?? null
  const target = input.target ?? null
  const meta = input.meta == null ? null : db.json(input.meta as Parameters<typeof db.json>[0])
  const rows = await db<{ id: string }[]>`
    INSERT INTO audit_log (actor_id, action, target, meta)
    VALUES (${actorId}, ${input.action}, ${target}, ${meta})
    RETURNING id
  `
  // RETURNING always yields the inserted row; guard for the type system.
  const id = rows[0]?.id
  if (id === undefined) throw new Error("writeAudit: insert returned no row")
  return id
}
