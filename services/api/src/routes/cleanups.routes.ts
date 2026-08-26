
import {
  CreateCleanupRequestSchema,
  UpdateCleanupRequestSchema,
  CancelCleanupRequestSchema,
  ClaimEventSlotRequestSchema,
  CompleteCleanupRequestSchema,
  ListCleanupsRequestSchema,
  RequestEventResourcesRequestSchema,
  SetMemberRoleRequestSchema,
  RemoveMemberRequestSchema,
  ChatHistoryQuerySchema,
  IdSchema,
  ReportRefOrIdSchema,
  AppError,
  type CleanupDTO,
  type GetCleanupResponse,
  type JoinCleanupResponse,
  type LeaveCleanupResponse,
  type CleanupAttendeesResponse,
  type ChatHistoryResponse,
  type RemoveMemberResponse,
  type RequestEventResourcesResponse,
  type SetMemberRoleResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse, trimTextFields } from "./_validate.js"
import {
  makeCleanupService,
  type CleanupRepository,
  type CleanupService,
  type CleanupServiceDeps,
  type CleanupViewer,
} from "../services/cleanup-service.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeContainerGuestRsvpService } from "../services/guest-rsvp-wiring.js"
import {
  SCHEDULE_MAX_AHEAD_MS,
  SCHEDULE_MAX_BACKDATE_MS,
} from "../services/cleanup-rules.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import type { CounterStore } from "../abuse/counter-store.js"
import { makeGeoidResolver } from "../services/route-geo-helpers.js"
import { resolveJurisdictionCode } from "../db/reference-code.js"
import { makeOutboundMailService } from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { route } from "../versioning/route.js"
import { chatHistoryPayload } from "./chat-route-helpers.js"
import { CappedBBoxQueryParam, LatLngQueryParam } from "./query-encoding.js"

export interface CleanupServiceOverrides {
  repo: CleanupRepository
  presignThumb?: CleanupServiceDeps["presignThumb"]
  newId?: CleanupServiceDeps["newId"]
  outboundMail?: CleanupServiceDeps["outboundMail"]
  isVerified?: CleanupServiceDeps["isVerified"]
  notifier?: CleanupServiceDeps["notifier"]
  guestNotifier?: CleanupServiceDeps["guestNotifier"]
  counters?: CleanupServiceDeps["counters"]
}

declare module "fastify" {
  interface FastifyInstance {
    cleanupOverrides?: CleanupServiceOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

const MemberParamsSchema = z.object({ id: IdSchema, userId: IdSchema }).strict()

const CleanupRefOrIdParamsSchema = z.object({ id: ReportRefOrIdSchema }).strict()

const ListCleanupsQuerySchema = z.object({
  bbox: CappedBBoxQueryParam.optional(),
  near: LatLngQueryParam.optional(),
  when: z.enum(["upcoming", "past", "attending"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
})

const HISTORY_DEFAULT_LIMIT = 30

const MEMBER_MANAGEMENT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

const CREATE_CLEANUP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

const COMPLETE_CLEANUP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

const CLAIM_SLOT_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

function refineScheduledAt(
  scheduledAt: string | undefined,
  ctx: z.RefinementCtx,
  opts: { rejectPast: boolean },
): void {
  if (scheduledAt === undefined) return
  const whenMs = Date.parse(scheduledAt)
  if (Number.isNaN(whenMs)) return
  const nowMs = Date.now()
  if (opts.rejectPast && whenMs < nowMs - SCHEDULE_MAX_BACKDATE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledAt"],
      message: "must not be in the past",
    })
  } else if (whenMs > nowMs + SCHEDULE_MAX_AHEAD_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledAt"],
      message: "is too far in the future",
    })
  }
}

function dropBlankBringItems<T extends { bring?: readonly string[] | null }>(body: T): T {
  if (!Array.isArray(body.bring)) return body
  return { ...body, bring: body.bring.filter((item) => item !== "") }
}

export const CreateCleanupBodySchema = trimTextFields(
  CreateCleanupRequestSchema,
  "title",
  "description",
  "address",
  "bring",
)
  .superRefine((data, ctx) => refineScheduledAt(data.scheduledAt, ctx, { rejectPast: true }))
  .transform(dropBlankBringItems)

export const UpdateCleanupBodySchema = trimTextFields(
  UpdateCleanupRequestSchema,
  "title",
  "description",
  "address",
  "bring",
)
  .superRefine((data, ctx) => refineScheduledAt(data.scheduledAt, ctx, { rejectPast: false }))
  .transform(dropBlankBringItems)

export const CancelCleanupBodySchema = trimTextFields(CancelCleanupRequestSchema, "reason")

export const RequestEventResourcesBodySchema = trimTextFields(
  RequestEventResourcesRequestSchema,
  "message",
)

export async function registerCleanupRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function repo(): CleanupRepository {
    const overrides = app.cleanupOverrides
    if (overrides) return overrides.repo
    return makeDrizzleCleanupRepository(container.getDb().sql)
  }

  let pinsChatRepo: ChatRepository | undefined
  function pinsRepo(): ChatRepository | null {
    if (app.chatOverrides?.chatRepo) return app.chatOverrides.chatRepo
    if (container.env.USE_FAKE_CHAT) return null
    return (pinsChatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))
  }

  const lazyCounters: CounterStore = container.getCounterStore()

  function service(): CleanupService {
    const overrides = app.cleanupOverrides
    return makeCleanupService({
      repo: repo(),
      ...(overrides?.presignThumb !== undefined
        ? { presignThumb: overrides.presignThumb }
        : overrides
          ? {}
          : {
              presignThumb: (thumbKey: string) =>
                container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC),
            }),
      ...(overrides
        ? {}
        : {
            resolveJurisdictionGeoid: makeGeoidResolver(container),
            resolveJurisdictionCode: (geoid: string | null) =>
              resolveJurisdictionCode(container.getDb().sql, geoid),
            outboundMail: makeOutboundMailService({
              repo: makeDrizzleMailRepository(container.getDb().sql),
              mailer: container.mailer,
              env: {
                MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
                MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
              },
            }),
            isVerified: (userId: string) =>
              makeDrizzleVerificationRepository(container.getDb().sql).isVerified(userId),
            notifier: makeRouteNotificationService(container, app.log),
            guestNotifier: makeContainerGuestRsvpService(container, undefined, app.log),
            counters: lazyCounters,
            jobs: container.jobs,
          }),
      ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
      ...(overrides?.outboundMail !== undefined ? { outboundMail: overrides.outboundMail } : {}),
      ...(overrides?.isVerified !== undefined ? { isVerified: overrides.isVerified } : {}),
      ...(overrides?.notifier !== undefined ? { notifier: overrides.notifier } : {}),
      ...(overrides?.guestNotifier !== undefined
        ? { guestNotifier: overrides.guestNotifier }
        : {}),
      ...(overrides?.counters !== undefined ? { counters: overrides.counters } : {}),
      logger: app.log,
    })
  }

  route(app, "createCleanup", { preHandler: csrfProtect, config: { rateLimit: CREATE_CLEANUP_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(CreateCleanupBodySchema, request.body)
    const dto: CleanupDTO = await service().createCleanup(body, userId)
    reply.status(201).send(dto)
  })

  route(app, "updateCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(UpdateCleanupBodySchema, request.body)
    const dto: GetCleanupResponse = await service().updateCleanup(id, body, userId)
    reply.status(200).send(dto)
  })

  route(app, "cancelCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(CancelCleanupBodySchema, { ...(request.body as object), id })
    const dto: GetCleanupResponse = await service().cancelCleanup(id, body.reason ?? null, userId)
    reply.status(200).send(dto)
  })

  route(app, "completeCleanup", { preHandler: csrfProtect, config: { rateLimit: COMPLETE_CLEANUP_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(CompleteCleanupRequestSchema, { ...(request.body as object), id })
    const dto: GetCleanupResponse = await service().completeCleanup(id, body.note ?? null, userId)
    reply.status(200).send(dto)
  })

  route(app, "claimEventSlot", { preHandler: csrfProtect, config: { rateLimit: CLAIM_SLOT_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(ClaimEventSlotRequestSchema, { ...(request.body as object), id })
    const dto: GetCleanupResponse = await service().claimEventSlot(id, userId, body.slotId)
    reply.status(200).send(dto)
  })

  route(app, "requestEventResources", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(RequestEventResourcesBodySchema, { ...(request.body as object), id })
    const payload: RequestEventResourcesResponse = await service().requestResources({
      cleanupId: id,
      message: body.message,
      actorId: userId,
    })
    reply.status(200).send(payload)
  })

  route(app, "setCleanupMemberRole", { preHandler: csrfProtect, config: { rateLimit: MEMBER_MANAGEMENT_RATE_LIMIT } }, async (request, reply) => {
    const actorId = requireAuth(request)
    const { id, userId } = parse(MemberParamsSchema, request.params)
    const body = parse(SetMemberRoleRequestSchema, { ...(request.body as object), id, userId })
    const payload: SetMemberRoleResponse = await service().setMemberRole(
      id,
      actorId,
      body.userId,
      body.role,
    )
    reply.status(200).send(payload)
  })

  route(app, "removeCleanupMember", { preHandler: csrfProtect, config: { rateLimit: MEMBER_MANAGEMENT_RATE_LIMIT } }, async (request, reply) => {
    const actorId = requireAuth(request)
    const { id, userId } = parse(MemberParamsSchema, request.params)
    const body = parse(RemoveMemberRequestSchema, { ...(request.body as object), id, userId })
    const payload: RemoveMemberResponse = await service().removeMember(id, actorId, body.userId)
    reply.status(200).send(payload)
  })

  route(app, "listCleanups", async (request, reply) => {
    const q = parse(ListCleanupsQuerySchema, request.query)
    const validated = parse(ListCleanupsRequestSchema, {
      ...(q.bbox !== undefined ? { bbox: q.bbox } : {}),
      ...(q.near !== undefined ? { near: q.near } : {}),
      ...(q.when !== undefined ? { when: q.when } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    })
    const payload = await service().listCleanups(validated, viewerOf(request))
    reply.status(200).send(payload)
  })

  route(app, "getCleanup", async (request, reply) => {
    const { id } = parse(CleanupRefOrIdParamsSchema, request.params)
    const dto: GetCleanupResponse = await service().getCleanup(id, viewerOf(request))
    reply.status(200).send(dto)
  })

  route(app, "joinCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const payload: JoinCleanupResponse = await service().joinCleanup(id, userId)
    reply.status(200).send(payload)
  })

  route(app, "leaveCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const payload: LeaveCleanupResponse = await service().leaveCleanup(id, userId)
    reply.status(200).send(payload)
  })

  route(app, "getCleanupAttendees", async (request, reply) => {
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const payload: CleanupAttendeesResponse = await service().listAttendees(id, viewerOf(request))
    reply.status(200).send(payload)
  })

  route(app, "cleanupMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const q = parse(ChatHistoryQuerySchema, request.query)

    const isMember = await repo().isMember(id, userId)
    if (!isMember) throw AppError.forbidden("You are not a member of this cleanup.")

    const limit = q.limit ?? HISTORY_DEFAULT_LIMIT
    const pinsSource = q.before === undefined && q.around === undefined ? pinsRepo() : null
    const payload: ChatHistoryResponse = await chatHistoryPayload(
      {
        history: (before, pageLimit, around) =>
          container.chatService.history(id, before, pageLimit, userId, around),
        ...(pinsSource !== null ? { listPins: () => pinsSource.listPins(id, userId) } : {}),
      },
      q,
      limit,
    )
    reply.status(200).send(payload)
  })
}

function viewerOf(request: FastifyRequest): CleanupViewer {
  return { userId: request.auth?.userId ?? null }
}
