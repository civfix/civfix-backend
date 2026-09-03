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

/**
 * Optional injected admin-user dependencies (tests). When present the routes build the service from
 * these (an in-memory repo + stub revoke/role seams) instead of the container, so the HTTP flow runs
 * offline.
 */
export interface AdminUserRouteOverrides {
  repo: AdminUserRepository
  sessions: SessionControl
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
  const csrfProtect = container.csrf.protect

  /** Build the admin-user service from injected overrides (tests) or the container (production). */
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
      // H2: a ban revokes ALL the user's sessions + marks the account banned; a role change revokes all
      // sessions so a cached role cannot outlive the change. Both are wired to the SessionService in the
      // auth bundle (present whenever the admin routes are mounted).
      const sessionSvc = app.authServices.sessions
      const sessions: SessionControl = {
        applyStatus: (userId, status) => sessionSvc.applyAccountStatus(userId, status),
        revokeAll: (userId) => sessionSvc.revokeAllForUser(userId),
      }
      // L5: the role write itself now lives in the repo (users.role UPDATE + audit in ONE tx), so there is
      // no longer a separate UserStore.setRole seam here that could commit a privilege change unaudited.
      return makeAdminUserService({ repo, sessions })
    },
  )

  route(app, "listAdminUsers", async (request, reply) => {
    const query = parse(AdminUserListQuerySchema, request.query)
    const payload: AdminUserListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // L4: a per-subject read of one identified user's dossier is audited (see _audit-read.ts).
  route(app, "getAdminUser", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminUserDTO = await service().get(id)
    await auditRead(request, container, requireOperator(request), {
      action: "user.detail_viewed",
      target: `user:${id}`,
    })
    reply.status(200).send(payload)
  })

  // DELIBERATELY NOT read-audited, unlike the two neighbours: a user's reports and cleanups are their
  // PUBLIC civic record (the same rows any signed-out visitor sees on their profile), so an operator
  // opening those tabs discloses nothing private. The L4 audit is scoped to reads that expose material the
  // subject did not publish — the dossier (email, status, moderation history) and the chat text.
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

  // L4: THE sensitive read — the full text of this user's private DMs, group chats and report chats,
  // including messages they soft-deleted. Every fetch is attributed to the operator who made it.
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

  // H2: a "banned" status revokes ALL the user's sessions; the service does NOT 200 on a failed revoke.
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

  route(app, "setUserVerified", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetUserVerifiedRequestSchema, request)
    await service().setVerified(id, { verified: body.verified, actorId })
    sendOk(reply)
  })

  // D18 manual override/revoke of the report-verified flag (distinct from the verified-neighbor mark).
  route(app, "setUserReportVerified", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetUserReportVerifiedRequestSchema, request)
    await service().setReportVerified(id, { value: body.value, actorId })
    sendOk(reply)
  })

  route(app, "removeUserMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, messageId } = twoIdParams(request, "messageId")
    // The body carries the path ids (the typed client fills them); the authoritative ids are the URL path.
    const body = parse(RemoveUserMessageRequestSchema, { ...(request.body as object), id, messageId })
    await service().removeMessage(id, messageId, { reason: body.reason ?? null, actorId })
    sendOk(reply)
  })
}
