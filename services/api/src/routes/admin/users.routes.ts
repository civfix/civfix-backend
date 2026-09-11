
import {
  AdminUserListQuerySchema,
  FlagUserRequestSchema,
  RemoveUserMessageRequestSchema,
  SetRoleRequestSchema,
  SetUserReportVerifiedRequestSchema,
  SetUserStatusRequestSchema,
  UserSubListQuerySchema,
  type AdminUserDTO,
  type AdminUserListResponse,
  type UserEventsResponse,
  type UserMessagesResponse,
  type UserReportsResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import {
  idParam,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  spreadNow,
  twoIdParams,
} from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import {
  makeAdminUserService,
  type AdminUserRepository,
  type SessionControl,
} from "../../services/admin/admin-user-service.js"
import { makeDrizzleAdminUserRepository } from "../../services/admin/admin-user-repository.drizzle.js"

export interface AdminUserRouteOverrides {
  repo: AdminUserRepository
  sessions: SessionControl
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    adminUserOverrides?: AdminUserRouteOverrides
  }
}

export async function registerAdminUsersRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "adminUserOverrides",
    (overrides) =>
      makeAdminUserService({
        repo: overrides.repo,
        sessions: overrides.sessions,
        ...spreadNow(overrides),
      }),
    () => {
      const repo: AdminUserRepository = makeDrizzleAdminUserRepository(container.getDb().sql)
      const sessionSvc = app.authServices.sessions
      const sessions: SessionControl = {
        applyStatus: (userId, status) => sessionSvc.applyAccountStatus(userId, status),
        revokeAll: (userId) => sessionSvc.revokeAllForUser(userId),
      }
      return makeAdminUserService({ repo, sessions })
    },
  )

  route(app, "listAdminUsers", async (request, reply) => {
    const query = parse(AdminUserListQuerySchema, request.query)
    const payload: AdminUserListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getAdminUser", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminUserDTO = await service().get(id)
    await auditRead(request, container, requireOperator(request), {
      action: "user.detail_viewed",
      target: `user:${id}`,
    })
    reply.status(200).send(payload)
  })

  route(app, "getUserReports", async (request, reply) => {
    const { id } = idParam(request)
    const query = parse(UserSubListQuerySchema, { ...(request.query as object), id })
    const payload: UserReportsResponse = await service().getReports(query)
    reply.status(200).send(payload)
  })

  route(app, "getUserEvents", async (request, reply) => {
    const { id } = idParam(request)
    const query = parse(UserSubListQuerySchema, { ...(request.query as object), id })
    const payload: UserEventsResponse = await service().getEvents(query)
    reply.status(200).send(payload)
  })

  route(app, "getUserMessages", async (request, reply) => {
    const { id } = idParam(request)
    const query = parse(UserSubListQuerySchema, { ...(request.query as object), id })
    const payload: UserMessagesResponse = await service().getMessages(query)
    await auditRead(request, container, requireOperator(request), {
      action: "user.messages_viewed",
      target: `user:${id}`,
      meta: { returned: payload.items.length, cursor: query.cursor ?? null },
    })
    reply.status(200).send(payload)
  })

  route(app, "flagUser", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(FlagUserRequestSchema, request)
    await service().flag(id, { reason: body.reason ?? null, actorId })
    sendOk(reply)
  })

  route(app, "setUserStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetUserStatusRequestSchema, request)
    await service().setStatus(id, { status: body.status, reason: body.reason ?? null, actorId })
    sendOk(reply)
  })

  route(app, "setUserRole", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetRoleRequestSchema, request)
    await service().setRole(id, { role: body.role, actorId })
    sendOk(reply)
  })

  route(app, "setUserReportVerified", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetUserReportVerifiedRequestSchema, request)
    await service().setReportVerified(id, { value: body.value, actorId })
    sendOk(reply)
  })

  route(app, "removeUserMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, messageId } = twoIdParams(request, "messageId")
    const body = parse(RemoveUserMessageRequestSchema, { ...(request.body as object), id, messageId })
    await service().removeMessage(id, messageId, { reason: body.reason ?? null, actorId })
    sendOk(reply)
  })
}
