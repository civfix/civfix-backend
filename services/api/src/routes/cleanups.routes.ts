/**
 * Cleanup route plugin.
 *
 *   POST  /cleanups               [auth][csrf]         create a cleanup (organizer auto-joins).
 *   PATCH /cleanups/:id           [auth][csrf]         organizer edit (scalars + linked-report reconcile).
 *   POST  /cleanups/:id/cancel    [auth][csrf]         organizer cancel (notifies attendees).
 *   GET   /cleanups               [anon-ok]            list cleanups (when/bbox/near, cursor paged).
 *   GET   /cleanups/:id           [anon-ok]            fetch one cleanup.
 *   POST  /cleanups/:id/join      [auth][csrf]         join (idempotent); returns {joined, going}.
 *   POST  /cleanups/:id/leave     [auth][csrf]         leave (organizer cannot leave); {joined, going}.
 *   GET   /cleanups/:id/attendees [anon-ok]            the "who's going" roster (viewer-scoped).
 *   GET   /cleanups/:id/messages  [auth][MEMBER-gated] chat history -> ChatHistoryResponse.
 *
 * The DB handle + seams are reached lazily inside handlers (via container) so merely mounting the plugin
 * opens no connection. The cleanup service is built per request from an injected override (tests: an
 * in-memory repo so the whole flow runs offline) or the container (production: the Drizzle/PostGIS repo).
 */

import {
  CreateCleanupRequestSchema,
  UpdateCleanupRequestSchema,
  CancelCleanupRequestSchema,
  ListCleanupsRequestSchema,
  RequestEventResourcesRequestSchema,
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
  type RequestEventResourcesResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import {
  makeCleanupService,
  type CleanupRepository,
  type CleanupService,
  type CleanupServiceDeps,
  type CleanupViewer,
} from "../services/cleanup-service.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import { makeMediaPresigner } from "../services/media-presign.js"
import { makeJurisdictionService } from "../services/jurisdiction-service.js"
import { resolveJurisdictionCode } from "../db/reference-code.js"
import { makeOutboundMailService } from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { route } from "../versioning/route.js"
import { BBoxQueryParam, LatLngQueryParam } from "./query-encoding.js"

// Optional injected cleanup-service dependencies (tests): the routes build the service from these instead
// of the container, so the whole HTTP flow runs offline. The same repo backs the member-gated history
// check. Unset in production, where the routes build the Drizzle-backed repo lazily.
export interface CleanupServiceOverrides {
  repo: CleanupRepository
  presignThumb?: CleanupServiceDeps["presignThumb"]
  newId?: CleanupServiceDeps["newId"]
  // Event resource-request seams (D19); tests inject fakes so requestResources runs offline. Production
  // wires them from the container (outbound mail over the Drizzle mail repo + the verification repo).
  outboundMail?: CleanupServiceDeps["outboundMail"]
  isVerified?: CleanupServiceDeps["isVerified"]
}

declare module "fastify" {
  interface FastifyInstance {
    cleanupOverrides?: CleanupServiceOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

// GET /cleanups/:id is resolve-either (issue #56 / ROUTING): the URL id may be a UUID OR an EVENT
// reference_code. Validate it with the looser shared ReportRefOrIdSchema (a 1..64-char opaque string,
// reused as the generic ref-or-id shape); the service branches uuid-shaped -> findCleanupById, else ->
// findCleanupByReferenceCode. ONLY this route is relaxed — every other by-id route keeps strict UUID.
const CleanupRefOrIdParamsSchema = z.object({ id: ReportRefOrIdSchema }).strict()

// Query schema for GET /cleanups, decoding EXACTLY what the shared client sends (see ./query-encoding.ts):
// optional bbox + optional near each as a single JSON-encoded object param, and scalar when/cursor/limit.
// We decode bbox/near here then re-validate the assembled object against the shared nested
// ListCleanupsRequest (the single source of truth) — `limit` stays a raw string here so it is coerced
// once, by the shared schema. (NOT .strict(); the re-validation against the shared .strict() schema gates.)
const ListCleanupsQuerySchema = z.object({
  bbox: BBoxQueryParam.optional(),
  near: LatLngQueryParam.optional(),
  when: z.enum(["upcoming", "past", "attending"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
})

const HISTORY_DEFAULT_LIMIT = 30

export async function registerCleanupRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function repo(): CleanupRepository {
    const overrides = app.cleanupOverrides
    if (overrides) return overrides.repo
    return makeDrizzleCleanupRepository(container.getDb().sql)
  }

  // Pins (P3): the cleanup history ITEMS come from container.chatService (FakeChatService offline), but
  // the pin rail reads the chat REPOSITORY (pins live on message rows). An injected chatOverrides.chatRepo
  // wins; else the lazily-built Drizzle repo — except under USE_FAKE_CHAT (offline dev, no DB), where
  // there is no chat repo at all and the initial page simply omits the `pins` key.
  let pinsChatRepo: ChatRepository | undefined
  function pinsRepo(): ChatRepository | null {
    if (app.chatOverrides?.chatRepo) return app.chatOverrides.chatRepo
    if (container.env.USE_FAKE_CHAT) return null
    return (pinsChatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makeMediaPresigner(container.storage),
    ))
  }

  function service(): CleanupService {
    const overrides = app.cleanupOverrides
    return makeCleanupService({
      repo: repo(),
      // Production presigns linked-report gallery thumbs over the Storage seam (the repo returns raw object
      // keys); a test override may inject its own (else the service defaults to a pass-through).
      ...(overrides?.presignThumb !== undefined
        ? { presignThumb: overrides.presignThumb }
        : overrides
          ? {}
          : {
              presignThumb: (thumbKey: string) =>
                container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC),
            }),
      // Production resolves the event's jurisdiction (#56 / D6) at create — same JurisdictionService + the
      // compact-code lookup the report path uses. Skipped under a test override (which boots with no DB),
      // so an offline cleanup create lands a null geoid + the EVENT code in the "0" bucket.
      ...(overrides
        ? {}
        : {
            resolveJurisdictionGeoid: async (lat: number, lng: number) => {
              const jurisdiction = makeJurisdictionService({
                sql: container.getDb().sql,
                geocoder: container.geocoder,
                jobs: container.jobs,
                jurisdictionLookup: container.jurisdictionLookup,
              })
              const resolved = await jurisdiction.resolveForPoint(lat, lng)
              return resolved?.geoid ?? null
            },
            resolveJurisdictionCode: (geoid: string | null) =>
              resolveJurisdictionCode(container.getDb().sql, geoid),
            // Event resource-request (D19): the outbound-mail seam (per-event thread) + the identity-
            // verification read. Built over the container's DB-backed seams in production.
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
          }),
      ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
      ...(overrides?.outboundMail !== undefined ? { outboundMail: overrides.outboundMail } : {}),
      ...(overrides?.isVerified !== undefined ? { isVerified: overrides.isVerified } : {}),
    })
  }

  route(app, "createCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(CreateCleanupRequestSchema, request.body)
    const dto: CleanupDTO = await service().createCleanup(body, userId)
    reply.status(201).send(dto)
  })

  // Organizer-only: the service throws FORBIDDEN (403) for a non-organizer and NOT_FOUND (404) for a
  // missing event; the route only resolves auth + validates the body.
  route(app, "updateCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(UpdateCleanupRequestSchema, request.body)
    const dto: GetCleanupResponse = await service().updateCleanup(id, body, userId)
    reply.status(200).send(dto)
  })

  // Organizer-only cancel: flips status to 'cancelled', writes a 'cancel' timeline row, fans a
  // notification to every attendee, then returns the updated CleanupDTO.
  route(app, "cancelCleanup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(CancelCleanupRequestSchema, { ...(request.body as object), id })
    const dto: GetCleanupResponse = await service().cancelCleanup(id, body.reason ?? null, userId)
    reply.status(200).send(dto)
  })

  // Host-only event resource request (POST /cleanups/:id/request-resources, D19): the service enforces the
  // organizer + identity-verified gate (403), the 404 for a missing event, and 422 NOT_ROUTABLE when the
  // jurisdiction has no contact. The body carries the host's message; the id comes from the URL path.
  route(app, "requestEventResources", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(RequestEventResourcesRequestSchema, { ...(request.body as object), id })
    const payload: RequestEventResourcesResponse = await service().requestResources({
      cleanupId: id,
      message: body.message,
      actorId: userId,
    })
    reply.status(200).send(payload)
  })

  route(app, "listCleanups", async (request, reply) => {
    const q = parse(ListCleanupsQuerySchema, request.query)
    // Re-validate the decoded shape against the shared schema (single source of truth). bbox/near are
    // already decoded BBox/LatLng objects (or undefined); when/cursor/limit are scalars.
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

  // GET /cleanups/:id  (anon-ok) — resolve-either: id may be a UUID or an EVENT reference_code (issue #56).
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

  // The "who's going" roster, scoped to the viewer by the service: only people you follow until you RSVP,
  // then everyone going. Anonymous/non-member viewers get an empty roster + the count.
  route(app, "getCleanupAttendees", async (request, reply) => {
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const payload: CleanupAttendeesResponse = await service().listAttendees(id, viewerOf(request))
    reply.status(200).send(payload)
  })

  route(app, "cleanupMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    // Shared non-strict ChatHistoryQuerySchema tolerates+strips the cleanupId path-param echo the typed
    // client still serializes into the query, and coerces `limit`. The authoritative id is the URL path.
    const q = parse(ChatHistoryQuerySchema, request.query)

    // Membership gate: only a cleanup member may read the room history. A non-member gets a 403 — the
    // cleanup's existence is not secret (it is listed on the public map) so 403, not 404.
    const isMember = await repo().isMember(id, userId)
    if (!isMember) throw AppError.forbidden("You are not a member of this cleanup.")

    const limit = q.limit ?? HISTORY_DEFAULT_LIMIT
    // `around` (P2 2.4) centers the page on a target message (schema rejects around+before together).
    // Pins (P3) ride ONLY the initial page (no before, no around) — see report-chat.routes.ts. Absent
    // entirely when no chat repo is reachable (offline dev path).
    const isInitialPage = q.before === undefined && q.around === undefined
    const repoForPins = isInitialPage ? pinsRepo() : null
    const [page, pins] = await Promise.all([
      container.chatService.history(id, q.before, limit, userId, q.around),
      repoForPins !== null ? repoForPins.listPins(id, userId) : Promise.resolve(undefined),
    ])
    // prevCursor is ABSENT on before-mode pages (byte-identical to pre-2.4 responses) and always
    // present — possibly null (window reaches the live head) — on around-mode pages.
    const payload: ChatHistoryResponse = {
      items: page.items,
      nextCursor: page.nextCursor,
      ...(page.prevCursor !== undefined ? { prevCursor: page.prevCursor } : {}),
      ...(pins !== undefined ? { pins } : {}),
    }
    reply.status(200).send(payload)
  })
}

function viewerOf(request: FastifyRequest): CleanupViewer {
  return { userId: request.auth?.userId ?? null }
}
