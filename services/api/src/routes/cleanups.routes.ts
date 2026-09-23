import {
  CreateCleanupRequestSchema,
  UpdateCleanupRequestSchema,
  CancelCleanupRequestSchema,
  ClaimEventSlotRequestSchema,
  DuplicateCleanupRequestSchema,
  CompleteCleanupRequestSchema,
  GetEventIcsRequestSchema,
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
  type GetEventIcsResponse,
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
import { makeHostAuditSink } from "../services/host/host-audit.js"
import { enrichCleanupDTOs } from "../services/cleanup-enrichment.js"
import { makeCommsRuntime } from "../services/host/comms-wiring.js"
import { webBaseUrlOf } from "../lib/base-url.js"
import { makeInsightsGeneration } from "../services/host/host-analytics-cache.js"
import { makeEventMediaPresigner } from "../services/host/event-media.js"
import { SCHEDULE_MAX_AHEAD_MS, SCHEDULE_MAX_BACKDATE_MS } from "../services/cleanup-rules.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import { buildIcs } from "@civfix/shared/ics"
import { makeCachedAddressResolver, makeGeoidResolver } from "../services/route-geo-helpers.js"
import { resolveJurisdictionCode } from "../db/reference-code.js"
import { makeOutboundMailService } from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { perHost, perIdentity } from "../plugins/rate-limit.js"
import { route } from "../versioning/route.js"
import { chatHistoryPayload } from "./chat-route-helpers.js"
import { CappedBBoxQueryParam, LatLngQueryParam } from "./query-encoding.js"

export interface CleanupServiceOverrides {
  repo: CleanupRepository
  presignThumb?: CleanupServiceDeps["presignThumb"]
  presignEventMedia?: CleanupServiceDeps["presignEventMedia"]
  audit?: CleanupServiceDeps["audit"]
  newId?: CleanupServiceDeps["newId"]
  outboundMail?: CleanupServiceDeps["outboundMail"]
  notifier?: CleanupServiceDeps["notifier"]
  attendeeNotifier?: CleanupServiceDeps["attendeeNotifier"]
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

export const CLEANUP_MEMBERSHIP_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 minute" })

export const EVENT_ICS_RATE_LIMIT = perHost({ max: 120, timeWindow: "1 minute" })

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

export const DuplicateCleanupBodySchema = DuplicateCleanupRequestSchema.superRefine((data, ctx) =>
  refineScheduledAt(data.scheduledAt, ctx, { rejectPast: true }),
)

export const CancelCleanupBodySchema = trimTextFields(CancelCleanupRequestSchema, "reason")

export const RequestEventResourcesBodySchema = trimTextFields(
  RequestEventResourcesRequestSchema,
  "message",
)

type ContainerCleanupDeps = Omit<CleanupServiceDeps, "repo" | "tickets" | "logger">

function productionCleanupDeps(app: FastifyInstance, container: Container): ContainerCleanupDeps {
  return {
    presignThumb: (thumbKey: string) =>
      container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC),
    resolveJurisdictionGeoid: makeGeoidResolver(container),
    resolveAddress: makeCachedAddressResolver(container),
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
    affiliations: container.getAffiliationLoader(),
    notifier: makeRouteNotificationService(container, app.log),
    attendeeNotifier: makeCommsRuntime(container, app.log).lanes,
    insightsInvalidator: makeInsightsGeneration({
      cache: container.getCache(),
      logger: app.log,
    }),
    counters: container.getCounterStore(),
    jobs: container.jobs,
    presignEventMedia: makeEventMediaPresigner(container.storage),
    audit: makeHostAuditSink(container.getDb().sql, app.log),
    enrichDTOs: (dtos, viewerUserId) => enrichCleanupDTOs(container, dtos, viewerUserId),
  }
}

// Under test overrides the service runs on the injected repository plus only the seams the test names;
// the ticket signer still comes from the container.
function overriddenCleanupDeps(overrides: CleanupServiceOverrides): ContainerCleanupDeps {
  return {
    ...(overrides.presignThumb !== undefined ? { presignThumb: overrides.presignThumb } : {}),
    ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
    ...(overrides.outboundMail !== undefined ? { outboundMail: overrides.outboundMail } : {}),
    ...(overrides.notifier !== undefined ? { notifier: overrides.notifier } : {}),
    ...(overrides.attendeeNotifier !== undefined
      ? { attendeeNotifier: overrides.attendeeNotifier }
      : {}),
    ...(overrides.counters !== undefined ? { counters: overrides.counters } : {}),
    ...(overrides.presignEventMedia !== undefined
      ? { presignEventMedia: overrides.presignEventMedia }
      : {}),
    ...(overrides.audit !== undefined ? { audit: overrides.audit } : {}),
  }
}

export function makeContainerCleanupService(
  app: FastifyInstance,
  container: Container,
): CleanupService {
  const overrides = app.cleanupOverrides
  const repo: CleanupRepository =
    overrides !== undefined ? overrides.repo : makeDrizzleCleanupRepository(container.getDb().sql)
  const tickets = container.getTicketTokenSigner()
  const deps =
    overrides !== undefined
      ? overriddenCleanupDeps(overrides)
      : productionCleanupDeps(app, container)
  return makeCleanupService({ repo, tickets, ...deps, logger: app.log })
}

export async function registerCleanupRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const webOrigin = webBaseUrlOf(container.env)

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

  function service(): CleanupService {
    return makeContainerCleanupService(app, container)
  }

  route(
    app,
    "createCleanup",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_CLEANUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateCleanupBodySchema, request.body)
      const dto: CleanupDTO = await service().createCleanup(body, userId)
      reply.status(201).send(dto)
    },
  )

  route(
    app,
    "duplicateCleanup",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_CLEANUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(DuplicateCleanupBodySchema, { ...(request.body as object), id })
      const dto: GetCleanupResponse = await service().duplicateCleanup(userId, body)
      reply.status(201).send(dto)
    },
  )

  route(app, "updateCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(UpdateCleanupBodySchema, { ...(request.body as object), id })
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

  route(
    app,
    "completeCleanup",
    { preHandler: csrfProtect, config: { rateLimit: COMPLETE_CLEANUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(CompleteCleanupRequestSchema, { ...(request.body as object), id })
      const dto: GetCleanupResponse = await service().completeCleanup(
        id,
        body.note ?? null,
        userId,
        request.headers["user-agent"] ?? null,
      )
      reply.status(200).send(dto)
    },
  )

  route(
    app,
    "claimEventSlot",
    { preHandler: csrfProtect, config: { rateLimit: CLAIM_SLOT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(ClaimEventSlotRequestSchema, { ...(request.body as object), id })
      const dto: GetCleanupResponse = await service().claimEventSlot(id, userId, body.slotId)
      reply.status(200).send(dto)
    },
  )

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

  route(
    app,
    "setCleanupMemberRole",
    { preHandler: csrfProtect, config: { rateLimit: MEMBER_MANAGEMENT_RATE_LIMIT } },
    async (request, reply) => {
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
    },
  )

  route(
    app,
    "removeCleanupMember",
    { preHandler: csrfProtect, config: { rateLimit: MEMBER_MANAGEMENT_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireAuth(request)
      const { id, userId } = parse(MemberParamsSchema, request.params)
      const body = parse(RemoveMemberRequestSchema, { ...(request.body as object), id, userId })
      const payload: RemoveMemberResponse = await service().removeMember(id, actorId, body.userId)
      reply.status(200).send(payload)
    },
  )

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

  route(
    app,
    "getEventIcs",
    { config: { rateLimit: EVENT_ICS_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(GetEventIcsRequestSchema, request.params)
      const event = await service().getCleanup(id, viewerOf(request))
      const mine = event.slots.find(
        (slot): slot is typeof slot & { startsAt: string; endsAt: string } =>
          slot.mine === true && slot.startsAt != null && slot.endsAt != null,
      )
      const endsAt = mine !== undefined ? mine.endsAt : event.endsAt
      const payload: GetEventIcsResponse = {
        ics: buildIcs({
          uid: `cleanup-${event.id}@civfix.org`,
          title: mine !== undefined ? `${event.title} (${mine.title})` : event.title,
          startsAt: mine !== undefined ? mine.startsAt : event.scheduledAt,
          ...(event.description !== undefined && event.description !== null
            ? { description: event.description }
            : {}),
          ...(endsAt !== null && endsAt !== undefined ? { endsAt } : {}),
          ...(event.timezone !== null && event.timezone !== undefined
            ? { timezone: event.timezone }
            : {}),
          ...(event.address !== null ? { location: event.address } : {}),
          url: `${webOrigin}/events/${event.id}`,
          status: event.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
        }),
        filename: `civfix-event-${event.id}.ics`,
      }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "joinCleanup",
    { preHandler: csrfProtect, config: { rateLimit: CLEANUP_MEMBERSHIP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const payload: JoinCleanupResponse = await service().joinCleanup(id, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "leaveCleanup",
    { preHandler: csrfProtect, config: { rateLimit: CLEANUP_MEMBERSHIP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const payload: LeaveCleanupResponse = await service().leaveCleanup(id, userId)
      reply.status(200).send(payload)
    },
  )

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
