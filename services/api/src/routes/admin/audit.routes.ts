// Reads of audit_log are not themselves audited.

import { AuditListQuerySchema, type AuditListResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { overridableService, parse } from "./_route-utils.js"
import { makeAuditService, type AuditRepository } from "../../services/admin/audit-service.js"
import { makeDrizzleAuditRepository } from "../../services/admin/audit-repository.drizzle.js"
import { route } from "../../versioning/route.js"

/** Injected audit-service deps (tests), so the HTTP flow runs offline. */
export interface AuditRouteOverrides {
  repo: AuditRepository
}

declare module "fastify" {
  interface FastifyInstance {
    auditOverrides?: AuditRouteOverrides
  }
}

export async function registerAdminAuditRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const service = overridableService(
    app,
    "auditOverrides",
    (overrides) => makeAuditService({ repo: overrides.repo }),
    () => {
      const repo: AuditRepository = makeDrizzleAuditRepository(container.getDb().sql)
      return makeAuditService({ repo })
    },
  )

  route(app, "listAudit", async (request, reply) => {
    const query = parse(AuditListQuerySchema, request.query)
    const payload: AuditListResponse = await service().list(query)
    reply.status(200).send(payload)
  })
}
