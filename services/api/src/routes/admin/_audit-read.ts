/**
 * L4: audit trail for SENSITIVE admin READS.
 *
 * The admin console audits every WRITE (writeAudit inside the effect's transaction) but historically
 * audited no reads at all. That is a defensible default for aggregate/list/analytics surfaces — they are
 * high-volume, low-sensitivity, and auditing them would bury the log (this decision is documented in
 * audit.routes.ts). It is NOT defensible for the per-SUBJECT reads, which dump one identified person's
 * private material to one operator:
 *
 *   - GET /admin/users/:id/messages — the full TEXT of that user's private DMs, group chats and report
 *     chats, INCLUDING messages the user soft-deleted. This is the single most sensitive read in the
 *     product and, before this, it left no trace whatsoever.
 *   - GET /admin/users/:id       — the user's identity + moderation dossier.
 *   - GET /admin/inbox/:id       — one citizen↔city email with its body and attachments.
 *   - GET /admin/mail/:id        — one full correspondence thread.
 *
 * These four now write an audit row naming the operator and the subject, so "who looked at whose messages"
 * is answerable after the fact.
 *
 * BEST-EFFORT, deliberately: unlike a write, a read is not required to be atomic with its audit, and
 * failing a read because the audit insert failed would take the console down on an audit-table hiccup.
 * A failure is logged at warn. (The write paths keep the stricter contract: audit-in-transaction, failure
 * fails the request.)
 *
 * OFFLINE-SAFE: `container.getDb()` throws when no DATABASE_URL is configured (the offline HTTP test
 * harnesses), and that throw is caught here like any other failure — so a read route that audits still
 * runs in those harnesses.
 */

import type { FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { writeAudit, type AdminAuditAction } from "../../services/admin/audit.js"

export interface ReadAuditInput {
  /** Stable dotted action, e.g. "user.messages_viewed". */
  action: AdminAuditAction
  /** Subject reference, conventionally "<type>:<id>". */
  target: string
  meta?: Record<string, unknown> | null
}

/**
 * Record that `request`'s operator READ the given subject. Never throws: a failure is logged and the read
 * proceeds. Pass the actor explicitly (the routes already resolved it via requireOperator).
 */
export async function auditRead(
  request: FastifyRequest,
  container: Container,
  actorId: string | null,
  input: ReadAuditInput,
): Promise<void> {
  try {
    await writeAudit(container.getDb().sql, {
      actorId,
      action: input.action,
      target: input.target,
      meta: input.meta ?? null,
    })
  } catch (err) {
    request.log.warn({ err, action: input.action, target: input.target }, "admin read audit failed")
  }
}
