import {
  AdminAddOrgMemberRequestSchema,
  AdminCreateOrgRequestSchema,
  AdminOrgEventListRequestSchema,
  AdminOrgListQuerySchema,
  AdminOrgMemberListRequestSchema,
  AdminOrgVerificationListQuerySchema,
  AdminRemoveOrgMemberRequestSchema,
  AdminSetOrgMemberRoleRequestSchema,
  AdminSetOrgSuspendedRequestSchema,
  AdminUpdateOrgRequestSchema,
  DecideOrgVerificationRequestSchema,
  type AdminCreateOrgResponse,
  type AdminOrgEventListResponse,
  type AdminOrgListResponse,
  type AdminOrgMemberListResponse,
  type AdminOrgVerificationListResponse,
  type AdminSetOrgSuspendedResponse,
  type AdminUpdateOrgResponse,
  type DecideOrgVerificationResponse,
  type GetAdminOrgResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import { idParam, parse, parseBodyWithId, sendOk, twoIdParams } from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import { makeContainerAdminEventService } from "./events.routes.js"
import { makeContainerOrganizationService } from "../host/orgs.routes.js"
import {
  ADMIN_ORGS_DEFAULT_LIMIT,
  type OrganizationService,
} from "../../services/host/organization-service.js"

export async function registerAdminOrgRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function service(): OrganizationService {
    return makeContainerOrganizationService(app, container)
  }

  const events = makeContainerAdminEventService(app, container)

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

  // Every org-management mutation writes its operator audit, with the mandatory `reason` in its meta, inside
  // the repository transaction, so the audit row and the state change commit or roll back together. The
  // routes add no second insertAuditRow.

  route(app, "adminListOrgs", async (request, reply) => {
    const operatorId = requireOperator(request)
    const query = parse(AdminOrgListQuerySchema, request.query ?? {})
    const page = await service().adminListOrganizations({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.verified !== undefined ? { verified: query.verified } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.suspended !== undefined ? { suspended: query.suspended } : {}),
      cursor: query.cursor ?? null,
      limit: query.limit ?? ADMIN_ORGS_DEFAULT_LIMIT,
    })
    await auditRead(request, container, operatorId, {
      action: "org.list_viewed",
      target: "org:list",
      meta: { returned: page.items.length, q: query.q ?? null },
    })
    const payload: AdminOrgListResponse = page
    reply.status(200).send(payload)
  })

  route(app, "adminCreateOrg", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const body = parse(AdminCreateOrgRequestSchema, request.body ?? {})
    const dto: AdminCreateOrgResponse = await service().adminCreateOrganization(operatorId, body)
    reply.status(201).send(dto)
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

  route(app, "adminUpdateOrg", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(AdminUpdateOrgRequestSchema, request)
    const { id: _id, ...patch } = body
    const dto: AdminUpdateOrgResponse = await service().adminUpdateOrganization(
      id,
      operatorId,
      patch,
    )
    reply.status(200).send(dto)
  })

  route(app, "adminSetOrgSuspended", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(AdminSetOrgSuspendedRequestSchema, request)
    const dto: AdminSetOrgSuspendedResponse = await service().adminSetSuspended(id, operatorId, {
      suspended: body.suspended,
      reason: body.reason,
    })
    reply.status(200).send(dto)
  })

  route(app, "adminListOrgMembers", async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const query = parse(AdminOrgMemberListRequestSchema, { ...(request.query as object), id })
    const page = await service().adminListMembers(id, {
      cursor: query.cursor ?? null,
      limit: query.limit ?? ADMIN_ORGS_DEFAULT_LIMIT,
    })
    await auditRead(request, container, operatorId, {
      action: "org.members_viewed",
      target: `organization:${id}`,
      meta: { returned: page.items.length },
    })
    const payload: AdminOrgMemberListResponse = page
    reply.status(200).send(payload)
  })

  route(app, "adminAddOrgMember", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(AdminAddOrgMemberRequestSchema, request)
    await service().adminAddMember(id, operatorId, {
      userId: body.userId,
      role: body.role,
      reason: body.reason,
    })
    sendOk(reply)
  })

  route(app, "adminSetOrgMemberRole", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, userId } = twoIdParams(request, "userId")
    const body = parse(AdminSetOrgMemberRoleRequestSchema, {
      ...(request.body as object),
      id,
      userId,
    })
    await service().adminSetMemberRole(id, operatorId, {
      userId: body.userId,
      role: body.role,
      reason: body.reason,
    })
    sendOk(reply)
  })

  route(app, "adminRemoveOrgMember", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, userId } = twoIdParams(request, "userId")
    const body = parse(AdminRemoveOrgMemberRequestSchema, {
      ...(request.body as object),
      id,
      userId,
    })
    await service().adminRemoveMember(id, operatorId, {
      userId: body.userId,
      reason: body.reason,
    })
    sendOk(reply)
  })

  route(app, "adminListOrgEvents", async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const query = parse(AdminOrgEventListRequestSchema, { ...(request.query as object), id })
    // 404 for an unknown org (rather than an empty page) so the console can tell the two apart.
    await service().adminGetOrganization(id)
    const page = await events().listForOrganization(id, {
      when: query.when ?? "all",
      cursor: query.cursor ?? null,
      limit: query.limit ?? ADMIN_ORGS_DEFAULT_LIMIT,
    })
    await auditRead(request, container, operatorId, {
      action: "org.events_viewed",
      target: `organization:${id}`,
      meta: { returned: page.items.length, when: query.when ?? "all" },
    })
    const payload: AdminOrgEventListResponse = page
    reply.status(200).send(payload)
  })

  // Unlike broadcasts/pages, which call insertAuditRow in the route after the effect, this decision is
  // audited inside the repository transaction (decideVerificationTx), so the audit row and the state change
  // commit or roll back together. A route-level insertAuditRow here would double-write the row.
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
