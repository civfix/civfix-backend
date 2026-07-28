/**
 * Cleanup route plugin.
 *
 *   POST  /cleanups               [auth][csrf]         create a cleanup (organizer auto-joins).
 *   PATCH /cleanups/:id           [auth][csrf]         organizer edit (scalars + linked-report reconcile).
 *   POST  /cleanups/:id/cancel    [auth][csrf]         organizer cancel (notifies attendees).
 *   POST  /cleanups/:id/complete  [auth][csrf]         host (organizer|cohost) mark completed -> 'done'.
 *   PUT   /cleanups/:id/slot      [auth][csrf]         claim / move / release the viewer's signup slot.
 *   GET   /cleanups               [anon-ok]            list cleanups (when/bbox/near, cursor paged).
 *   GET   /cleanups/:id           [anon-ok]            fetch one cleanup.
 *   POST  /cleanups/:id/join      [auth][csrf]         join (idempotent); returns {joined, going}.
 *   POST  /cleanups/:id/leave     [auth][csrf]         leave (organizer cannot leave); {joined, going}.
 *   PATCH  /cleanups/:id/members/:userId [auth][csrf]  organizer promote/demote member<->cohost; {ok}.
 *   DELETE /cleanups/:id/members/:userId [auth][csrf]  organizer/cohost remove attendee; {ok, going}.
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
  // WS4: the cleanup_role bell seam (promote/demote/remove). Tests inject a recording fake; unset in a
  // test harness means "no bells" (the service treats the notifier as optional).
  notifier?: CleanupServiceDeps["notifier"]
  // M18/M20: an in-memory CounterStore so the resource-request budget + role-change cooldown run
  // offline. Unset in production, where the routes count through the container's shared lazy store.
  counters?: CleanupServiceDeps["counters"]
}

declare module "fastify" {
  interface FastifyInstance {
    cleanupOverrides?: CleanupServiceOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

// Path params for the member-management routes (WS4): /cleanups/:id/members/:userId.
const MemberParamsSchema = z.object({ id: IdSchema, userId: IdSchema }).strict()

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
  // M14 area cap (./query-encoding.ts): anon-ok viewport read, same cost profile as the map pin reads.
  bbox: CappedBBoxQueryParam.optional(),
  near: LatLngQueryParam.optional(),
  when: z.enum(["upcoming", "past", "attending"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
})

const HISTORY_DEFAULT_LIMIT = 30

/**
 * M18: per-IP caps on the two member-management mutations, which had none at all and therefore sat at
 * the global 300/min/IP. Promote/demote rings the target's lock screen on every flip, and remove now
 * writes a ban row, so both are cheap for the attacker and loud for the victim. Tightness matches
 * map.routes' GEOCODER_RATE_LIMIT family; no legitimate host manages members faster than this.
 *
 * This limiter is per-IP and therefore evadable by rotating exits — it is the OUTER of two layers. The
 * inner, non-evadable one is the per-(cleanup, target) role-change cooldown in cleanup-service.ts,
 * which counts at the receiver in the shared store.
 */
const MEMBER_MANAGEMENT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/**
 * Per-IP cap on create, mirroring reports.routes' CREATE_REPORT_RATE_LIMIT (20/min). Creating an event
 * runs the same expensive write path a report create does — the external Census lookup behind
 * resolveJurisdictionGeoid, a lazy jurisdiction upsert, and discovery-task pressure — so it does not
 * belong at the global 300/min. No legitimate organizer creates faster than this.
 */
const CREATE_CLEANUP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/**
 * B21: per-IP cap on host completion, from the MEMBER_MANAGEMENT_RATE_LIMIT family. Completion is
 * idempotent and rings nobody (B19), but it is the gate that opens hours logging on an event, and every
 * repeat call still takes a row lock on the cleanups row — so it does not belong at the global 300/min.
 */
const COMPLETE_CLEANUP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/**
 * B29c: per-IP cap on slot claim/move/release. Slightly looser than the member-management family
 * because a legitimate attendee genuinely does tap through a slot board — but it is nowhere near the
 * global 300/min, because every flip takes a `FOR UPDATE` on a contended slot row and a loop can stall
 * everyone else competing for the last seat on a popular event.
 *
 * This is the OUTER of two layers and is per-IP, therefore evadable by rotating exits. The inner,
 * non-evadable one is the per-(event, user) flip budget in cleanup-service.ts, counted in the shared
 * store — the same shape M18's role-change cooldown established.
 */
const CLAIM_SLOT_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

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

  // Pins (P3): the cleanup history ITEMS come from container.chatService (FakeChatService offline), but
  // the pin rail reads the chat REPOSITORY (pins live on message rows). An injected chatOverrides.chatRepo
  // wins; else the lazily-built Drizzle repo — except under USE_FAKE_CHAT (offline dev, no DB), where
  // there is no chat repo at all and the initial page simply omits the `pins` key.
  //
  // H9: PRIVATE presigner, like every other chat/DM/group/report chat-repo construction site. Pins
  // hydrate real message attachments, and GET /cleanups/:id/messages returns them alongside the signed
  // `items` — so a public presigner here would hand back a member-only pinned photo as a permanent,
  // unauthenticated CDN URL (R2_PUBLIC_BASE), which leaving, removal or deletion could never revoke.
  let pinsChatRepo: ChatRepository | undefined
  function pinsRepo(): ChatRepository | null {
    if (app.chatOverrides?.chatRepo) return app.chatOverrides.chatRepo
    if (container.env.USE_FAKE_CHAT) return null
    return (pinsChatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))
  }

  // The shared (Redis) abuse counter behind the cleanup service's resource-request budget and
  // role-change cooldown: container.getCounterStore(), the ONE process-wide lazy wrapper (di.ts), which
  // the anon + home-turf caps count through as well.
  //
  // Lazy matters here: only the MUTATION paths (resource requests, role changes) ever count, but service()
  // is rebuilt for every request including the anon-ok reads — and container.getRedis() THROWS when
  // REDIS_URL is empty. The wrapper resolves its client on the first actual incr, so a read touches Redis
  // not at all; a mutation on a Redis-less boot still fails closed (the throw becomes a 500) instead of
  // getting a free budget.
  const lazyCounters: CounterStore = container.getCounterStore()

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
            resolveJurisdictionGeoid: makeGeoidResolver(container),
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
            // WS4 cleanup_role bells (promote/demote/remove) ride the real notification pipeline
            // (in-app row + push + user-channel signal), same wiring as social.routes' notifier.
            notifier: makeRouteNotificationService(container, app.log),
            // M18/M20: the SHARED abuse budget behind the resource-request caps and the role-change
            // cooldown. Both were in-process Maps, so every pod carried its own allowance and a deploy
            // reset it — which is exactly what made the municipal-email relay (M20) work. The container's
            // shared wrapper resolves its Redis client lazily, so merely mounting the plugin opens nothing.
            counters: lazyCounters,
          }),
      ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
      ...(overrides?.outboundMail !== undefined ? { outboundMail: overrides.outboundMail } : {}),
      ...(overrides?.isVerified !== undefined ? { isVerified: overrides.isVerified } : {}),
      ...(overrides?.notifier !== undefined ? { notifier: overrides.notifier } : {}),
      ...(overrides?.counters !== undefined ? { counters: overrides.counters } : {}),
      logger: app.log,
    })
  }

  route(app, "createCleanup", { preHandler: csrfProtect, config: { rateLimit: CREATE_CLEANUP_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(CreateCleanupRequestSchema, request.body)
    const dto: CleanupDTO = await service().createCleanup(body, userId)
    reply.status(201).send(dto)
  })

  // Host-only (organizer OR cohost, WS4/D3): the service throws FORBIDDEN (403) for a non-host and
  // NOT_FOUND (404) for a missing event; the route only resolves auth + validates the body.
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

  // Host completion (organizer OR cohost, B13): flips status to 'done', writes a 'status' timeline row
  // and returns the updated CleanupDTO. The service owns the whole matrix — 403 for a non-host, 404 for
  // a missing event, 409 for a cancelled one or one that hasn't started yet (B14/B15), and an idempotent
  // 200 for an already-completed one. No notification (B19).
  route(app, "completeCleanup", { preHandler: csrfProtect, config: { rateLimit: COMPLETE_CLEANUP_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(CompleteCleanupRequestSchema, { ...(request.body as object), id })
    const dto: GetCleanupResponse = await service().completeCleanup(id, body.note ?? null, userId)
    reply.status(200).send(dto)
  })

  // P9 (B27): PUT /cleanups/:id/slot — the viewer's slot on this event is a SINGULAR resource (one slot
  // per person per event), so claiming, MOVING and releasing are all one idempotent PUT of its value;
  // `slotId: null` releases. Same path-param merge as cancel/complete. The service owns the whole
  // matrix — 404 for a missing event or slot, 403 for a removed (banned) attendee, 409 for a closed
  // event or a full slot, 429 for flapping — and returns the refreshed CleanupDTO (C5), whose `slots`
  // already carry the new `claimed`/`mine`, so the client needs no refetch.
  route(app, "claimEventSlot", { preHandler: csrfProtect, config: { rateLimit: CLAIM_SLOT_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(ClaimEventSlotRequestSchema, { ...(request.body as object), id })
    const dto: GetCleanupResponse = await service().claimEventSlot(id, userId, body.slotId)
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

  // WS4 (D3): organizer-only promote/demote — PATCH /cleanups/:id/members/:userId. Path params are
  // merged into the body BEFORE parsing (the CancelCleanupRequest pattern: the typed client extracts
  // both into the path, the route reconciles them back). The service enforces the whole matrix.
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

  // WS4 (D3): remove an attendee — DELETE /cleanups/:id/members/:userId (organizer: cohosts+members;
  // cohost: plain members only; the organizer is irremovable). Same path-param merge; a DELETE body is
  // typically absent, and `{ ...(null|undefined) }` spreads to {} so the merge stays safe.
  route(app, "removeCleanupMember", { preHandler: csrfProtect, config: { rateLimit: MEMBER_MANAGEMENT_RATE_LIMIT } }, async (request, reply) => {
    const actorId = requireAuth(request)
    const { id, userId } = parse(MemberParamsSchema, request.params)
    const body = parse(RemoveMemberRequestSchema, { ...(request.body as object), id, userId })
    const payload: RemoveMemberResponse = await service().removeMember(id, actorId, body.userId)
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
    // The page contract — pins on the INITIAL page only, prevCursor absent in before-mode and always
    // present (possibly null) in around-mode — lives in chatHistoryPayload, shared with the report /
    // group / dm history routes. This room is the reason `listPins` is optional there: its ITEMS come
    // from container.chatService while its pin rail needs the chat REPOSITORY, which the offline dev path
    // has none of. The source is resolved HERE rather than inside listPins so a paged read never builds
    // the Drizzle pin repo at all.
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
