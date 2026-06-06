/**
 * Admin audit-log view route (Phase 2).
 *
 *   GET /admin/audit  paginated audit_log read with filters actor / action / target (AuditListResponse).
 *
 * Read-only operator view (no audit written for a read). The requireOperator guard is applied by
 * routes/admin/index.ts (this whole router runs inside the guarded child context). The query is validated
 * against the shared AuditListQuerySchema via parse(). The service is built lazily from the container
 * (Drizzle repo) or from a test override (in-memory repo) for the offline tests, mirroring the moderation
 * routes.
 */

import { AuditListQuerySchema, type AuditListResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { parse } from "./_route-utils.js"
import {
  makeAuditService,
  type AuditRepository,
  type AuditService,
} from "../../services/admin/audit-service.js"
import { makeDrizzleAuditRepository } from "../../services/admin/audit-repository.drizzle.js"

/**
 * Optional injected audit-service dependencies (tests). When present the route builds the service from
 * these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface AuditRouteOverrides {
  repo: AuditRepository
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected audit-route overrides (tests). See AuditRouteOverrides. */
    auditOverrides?: AuditRouteOverrides
  }
}

export async function registerAdminAuditRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the audit service from injected overrides (tests) or the container (production). */
  function service(): AuditService {
    const overrides = app.auditOverrides
    if (overrides) return makeAuditService({ repo: overrides.repo })
    const repo: AuditRepository = makeDrizzleAuditRepository(container.getDb().sql)
    return makeAuditService({ repo })
  }

  // -------------------------------------------------------------------------
  // GET /admin/audit
  // -------------------------------------------------------------------------
  app.get("/admin/audit", async (request, reply) => {
    const query = parse(AuditListQuerySchema, request.query)
    const payload: AuditListResponse = await service().list(query)
    reply.status(200).send(payload)
  })
}
