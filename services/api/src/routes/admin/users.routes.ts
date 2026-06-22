/**
 * Admin users routes (Phase 2).
 *
 *   GET  /admin/users              the user list (filter/search/paginate) (AdminUserListResponse).
 *   GET  /admin/users/:id          a user detail (GetAdminUserResponse).
 *   GET  /admin/users/:id/reports  the user's reports (UserReportsResponse).
 *   GET  /admin/users/:id/events   the user's cleanups (UserEventsResponse).
 *   GET  /admin/users/:id/messages the user's chat messages (UserMessagesResponse).
 *   POST /admin/users/:id/flag     flag/unflag (FlagUserRequest). [csrf]
 *   POST /admin/users/:id/status   set account status; ban revokes sessions (SetUserStatusRequest). [csrf]
 *   POST /admin/users/:id/role     set role (SetRoleRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts; mutations additionally carry csrfProtect. Each mutation resolves the
 * acting operator's (non-null) userId via requireOperator(request) and records it on every audit write
 * (flag/status audits inside the repo transaction; the role audit by the service). The service is built
 * lazily from the container (Drizzle user repo) with the session-revoke wired to
 * SessionService.revokeAllForUser and the role write wired to UserStore.setRole (both from
 * app.authServices), or from a per-instance test override.
 */

import {
  AdminUserListQuerySchema,
  FlagUserRequestSchema,
  RemoveUserMessageRequestSchema,
  SetRoleRequestSchema,
  SetUserReportVerifiedRequestSchema,
  SetUserStatusRequestSchema,
  SetUserVerifiedRequestSchema,
  UserSubListQuerySchema,
  IdSchema,
  type AdminOkResponse,
  type AdminUserDTO,
  type AdminUserListResponse,
  type UserEventsResponse,
  type UserMessagesResponse,
  type UserReportsResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeAdminUserService,
  type AdminUserRepository,
  type AdminUserService,
  type SessionControl,
  type SetUserRole,
} from "../../services/admin/admin-user-service.js"
import { makeDrizzleAdminUserRepository } from "../../services/admin/admin-user-repository.drizzle.js"

/**
 * Optional injected admin-user dependencies (tests). When present the routes build the service from
 * these (an in-memory repo + stub revoke/role seams) instead of the container, so the HTTP flow runs
 * offline.
 */
export interface AdminUserRouteOverrides {
  repo: AdminUserRepository
  sessions: SessionControl
  setUserRole: SetUserRole
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-user route overrides (tests). See AdminUserRouteOverrides. */
    adminUserOverrides?: AdminUserRouteOverrides
  }
}

export async function registerAdminUsersRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the admin-user service from injected overrides (tests) or the container (production). */
  function service(): AdminUserService {
    const overrides = app.adminUserOverrides
    if (overrides) {
      return makeAdminUserService({
        repo: overrides.repo,
        sessions: overrides.sessions,
        setUserRole: overrides.setUserRole,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: AdminUserRepository = makeDrizzleAdminUserRepository(container.getDb().sql)
    // H2: a ban revokes ALL the user's sessions + marks the account banned; a role change revokes all
    // sessions so a cached role cannot outlive the change. Both are wired to the SessionService in the
    // auth bundle (present whenever the admin routes are mounted).
    const sessionSvc = app.authServices.sessions
    const sessions: SessionControl = {
      ban: (userId) => sessionSvc.banUser(userId),
      clearBan: (userId) => sessionSvc.clearBan(userId),
      revokeAll: (userId) => sessionSvc.revokeAllForUser(userId),
    }
    const setUserRole: SetUserRole = async (userId, role) => {
      await app.authServices.users.setRole(userId, role)
    }
    return makeAdminUserService({ repo, sessions, setUserRole })
  }

  route(app, "listAdminUsers", async (request, reply) => {
    const query = parse(AdminUserListQuerySchema, request.query)
    const payload: AdminUserListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getAdminUser", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminUserDTO = await service().get(id)
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
    reply.status(200).send(payload)
  })

  route(app, "flagUser", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(FlagUserRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: requireOperator(request) })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // H2: a "banned" status revokes ALL the user's sessions; the service does NOT 200 on a failed revoke.
  route(app, "setUserStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetUserStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, {
      status: body.status,
      reason: body.reason ?? null,
      actorId: requireOperator(request),
    })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "setUserRole", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetRoleRequestSchema, { ...(request.body as object), id })
    await service().setRole(id, { role: body.role, actorId: requireOperator(request) })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "setUserVerified", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetUserVerifiedRequestSchema, { ...(request.body as object), id })
    await service().setVerified(id, { verified: body.verified, actorId: requireOperator(request) })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // D18 manual override/revoke of the report-verified flag (distinct from the verified-neighbor mark).
  route(app, "setUserReportVerified", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetUserReportVerifiedRequestSchema, { ...(request.body as object), id })
    await service().setReportVerified(id, { value: body.value, actorId: requireOperator(request) })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "removeUserMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const { id, messageId } = parse(MessageParamsSchema, request.params)
    // The body carries the path ids (the typed client fills them); the authoritative ids are the URL path.
    const body = parse(RemoveUserMessageRequestSchema, { ...(request.body as object), id, messageId })
    await service().removeMessage(id, messageId, {
      reason: body.reason ?? null,
      actorId: requireOperator(request),
    })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

/** Path-param schema for the per-message remove route (the `:id`/`:messageId` segments). */
const MessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()
