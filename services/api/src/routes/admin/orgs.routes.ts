import {
  AdminOrgVerificationListQuerySchema,
  DecideOrgVerificationRequestSchema,
  type AdminOrgVerificationListResponse,
  type DecideOrgVerificationResponse,
  type GetAdminOrgResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import { idParam, parse, parseBodyWithId } from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import { makeContainerOrganizationService } from "../host/orgs.routes.js"
import type { OrganizationService } from "../../services/host/organization-service.js"

const ADMIN_ORGS_DEFAULT_LIMIT = 25

export async function registerAdminOrgRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function service(): OrganizationService {
    return makeContainerOrganizationService(app, container)
  }

  route(app, "adminListOrgVerifications", async (request, reply) => {
    const operatorId = requireOperator(request)
    const query = parse(AdminOrgVerificationListQuerySchema, request.query ?? {})
    const page = await service().adminListVerifications({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.q !== undefined ? { q: query.q } : {}),
      cursor: query.cursor ?? null,
      limit: query.limit ?? ADMIN_ORGS_DEFAULT_LIMIT,
    })
    await auditRead(request, container, operatorId, {
      action: "org.verifications_viewed",
      target: "org:queue",
      meta: { returned: page.items.length, status: query.status ?? null },
    })
    const payload: AdminOrgVerificationListResponse = page
    reply.status(200).send(payload)
  })

  route(app, "adminGetOrg", async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const dto: GetAdminOrgResponse = await service().adminGetOrganization(id)
    await auditRead(request, container, operatorId, {
      action: "org.detail_viewed",
      target: `organization:${id}`,
    })
    reply.status(200).send(dto)
  })

  route(app, "adminDecideOrgVerification", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(DecideOrgVerificationRequestSchema, request)
    const dto: DecideOrgVerificationResponse = await service().adminDecideVerification(
      id,
      operatorId,
      {
        decision: body.decision,
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      },
    )
    reply.status(200).send(dto)
  })
}
