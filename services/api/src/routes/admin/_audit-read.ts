/**
 * Audit trail for sensitive admin READS.
 *
 * Aggregate, list and analytics reads are not audited: they are high-volume and low-sensitivity, and
 * auditing them would bury the log. Per-subject reads that dump one identified person's private material
 * to one operator are audited through this helper, among them:
 *
 *   - GET /admin/users/:id/messages: the full text of that user's DMs, group chats and report chats,
 *     including messages the user soft-deleted. The most sensitive read in the product.
 *   - GET /admin/users/:id: the user's identity and moderation dossier.
 *   - GET /admin/inbox/:id: one citizen-to-city email with its body and attachments.
 *   - GET /admin/mail/:id: one full correspondence thread.
 *
 * Best-effort, deliberately: a read need not be atomic with its audit, and failing a read on an
 * audit-table hiccup would take the console down. Failures are logged at warn. Write paths keep the
 * stricter contract (audit in the same transaction; failure fails the request).
 *
 * Offline-safe: `container.getDb()` throws without a DATABASE_URL (the offline HTTP test harnesses), and
 * that throw is caught like any other failure.
 */

import type { FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import type { AdminAuditAction, WriteAuditInput } from "../../services/admin/audit.js"
import { insertAuditRow } from "../../services/admin/audit-repository.drizzle.js"

export interface ReadAuditInput {
  action: AdminAuditAction
  /** Conventionally "<type>:<id>". */
  target: string
  meta?: Record<string, unknown> | null
}

/**
 * Injected read-audit sink (tests). Without it these audits are unobservable from an HTTP test: the
 * offline harness has no DB, so the failure is swallowed by design and deleting an `auditRead` call would
 * break nothing.
 *
 * Read off `request.server`, so it covers every read-audited route and is inherited through the
 * encapsulated admin scope's prototype chain (a test may install it after buildServer).
 */
export interface AdminReadAuditOverrides {
  sink(input: WriteAuditInput): Promise<void>
}

declare module "fastify" {
  interface FastifyInstance {
    adminReadAuditOverrides?: AdminReadAuditOverrides
  }
}

/** Never throws: a failure is logged and the read proceeds. */
export async function auditRead(
  request: FastifyRequest,
  container: Container,
  actorId: string,
  input: ReadAuditInput,
): Promise<void> {
  const row: WriteAuditInput = {
    actorId,
    action: input.action,
    target: input.target,
    meta: input.meta ?? null,
  }
  try {
    // Both branches stay inside the try so the never-throws contract holds either way. `server` is
    // optional-chained because a bare request stub (the helper's own unit test) has none.
    const sink = request.server?.adminReadAuditOverrides?.sink
    if (sink) await sink(row)
    else await insertAuditRow(container.getDb().sql, row)
  } catch (err) {
    request.log.warn({ err, action: input.action, target: input.target }, "admin read audit failed")
  }
}
