import {
  EventHoursQuerySchema,
  LeaderboardQuerySchema,
  LogEventHoursRequestSchema,
  MyVolunteerHoursEntriesQuerySchema,
  PublicVolunteerHoursQuerySchema,
  IdSchema,
  type EventHoursResponse,
  type GetMyHoursResponse,
  type LeaderboardResponse,
  type LogEventHoursResponse,
  type MyVolunteerHoursEntriesResponse,
  type PublicVolunteerHoursResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeVolunteerHoursService,
  type CleanupHoursLookup,
  type VolunteerHoursRepository,
  type VolunteerHoursService,
} from "../services/volunteer-hours-service.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import type { NotificationService } from "../services/notification-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export interface VolunteerHoursOverrides {
  repo: VolunteerHoursRepository
  cleanups?: CleanupHoursLookup
  isVerified?: (userId: string) => Promise<boolean>
  // A test harness that omits this means "no bells" (the service treats the notifier as optional).
  notifier?: Pick<NotificationService, "createNotification">
}

declare module "fastify" {
  interface FastifyInstance {
    volunteerOverrides?: VolunteerHoursOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()
const GeoidParamsSchema = z.object({ geoid: z.string().min(1).max(64) }).strict()
const UserIdParamsSchema = z.object({ id: IdSchema }).strict()

/**
 * B47 — the leaderboard has no route limit today and becomes a hot ANONYMOUS read the moment it lands on
 * the search page. Same headroom as mapReports/mapCleanups, which have the same anon-ok + short-TTL-cache
 * shape.
 */
const LEADERBOARD_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

/** B30c — anon-readable itemised transcript, parity with the map reads. */
const PUBLIC_HOURS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

/**
 * B37 — `logEventHours` never had a route limit and now fans out up to EVENT_HOURS_MEMBER_CAP push
 * notifications per call; the global 300/min was the only thing between one host and 600k pushes/minute.
 */
const LOG_EVENT_HOURS_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

/**
 * APPEND to `Vary`, never replace it.
 *
 * `@fastify/cors` already sets `Vary: Origin` (its allowlist reflects the request's Origin, so the
 * response genuinely varies by it) in a hook that runs BEFORE the handler, and `reply.header()`
 * OVERWRITES. A bare `reply.header("Vary", "Cookie, Authorization")` therefore silently drops `Origin`
 * from exactly the response we are about to invite a shared cache to store — which is how one origin's
 * `Access-Control-Allow-Origin` gets served to another.
 */
function appendVary(reply: FastifyReply, ...fields: readonly string[]): void {
  const existing = reply.getHeader("Vary")
  const raw = Array.isArray(existing) ? existing.join(",") : typeof existing === "string" ? existing : ""
  const current = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const field of fields) {
    if (!current.some((c) => c.toLowerCase() === field.toLowerCase())) current.push(field)
  }
  reply.header("Vary", current.join(", "))
}

export async function registerVolunteerHoursRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function repo(): VolunteerHoursRepository {
    const overrides = app.volunteerOverrides
    if (overrides) return overrides.repo
    return container.getVolunteerHoursRepo()
  }

  function cleanupLookup(): CleanupHoursLookup {
    const overrides = app.volunteerOverrides
    if (overrides?.cleanups) return overrides.cleanups
    return {
      async load(cleanupId: string) {
        const record = await makeDrizzleCleanupRepository(container.getDb().sql).findCleanupById(
          cleanupId,
          null,
        )
        if (!record) return null
        return {
          organizerUserId: record.organizerUserId,
          status: record.status,
          jurisdictionGeoid: record.jurisdictionGeoid,
          // B33: the hours_logged bell body names the event, so the title travels with the view.
          title: record.title,
        }
      },
      listMemberIds: (cleanupId: string, limit: number) =>
        makeDrizzleCleanupRepository(container.getDb().sql).listMemberIds(cleanupId, limit),
      // WS4/WS5: the acting user's membership role — gates logging to organizer|cohost (D4).
      roleOf: (cleanupId: string, userId: string) =>
        makeDrizzleCleanupRepository(container.getDb().sql).roleOf(cleanupId, userId),
    }
  }

  function isVerified(): (userId: string) => Promise<boolean> {
    const overrides = app.volunteerOverrides
    if (overrides?.isVerified) return overrides.isVerified
    return (userId: string) =>
      makeDrizzleVerificationRepository(container.getDb().sql).isVerified(userId)
  }

  function notifier(): Pick<NotificationService, "createNotification"> | undefined {
    const overrides = app.volunteerOverrides
    // An override object with no `notifier` deliberately means "no bells": the offline route-coverage
    // harness has no notification repo, and a bell is not what those tests assert.
    if (overrides) return overrides.notifier
    return makeRouteNotificationService(container, app.log)
  }

  function service(): VolunteerHoursService {
    const bells = notifier()
    const isBlockedEitherWay = app.volunteerOverrides
      ? undefined
      : (viewerId: string, targetId: string) =>
          container.getBlocksRepo().isBlockedEitherWay(viewerId, targetId)
    return makeVolunteerHoursService({
      repo: repo(),
      cleanups: cleanupLookup(),
      isVerified: isVerified(),
      ...(bells !== undefined ? { notifier: bells } : {}),
      ...(isBlockedEitherWay !== undefined ? { isBlockedEitherWay } : {}),
      logger: app.log,
    })
  }

  route(app, "getMyHours", async (request, reply) => {
    const userId = requireAuth(request)
    const hours = await service().getMyHours(userId)
    const payload: GetMyHoursResponse = { hours }
    reply.status(200).send(payload)
  })

  // B30a — the owner's own itemised transcript, keyset-paged newest-first. Every source is itemised
  // (it is their own data); the header total comes from the rollup, not from summing the page.
  route(app, "getMyHoursEntries", async (request, reply) => {
    const userId = requireAuth(request)
    const query = parse(MyVolunteerHoursEntriesQuerySchema, request.query ?? {})
    const payload: MyVolunteerHoursEntriesResponse = await service().getMyHoursEntries(userId, query)
    reply.status(200).send(payload)
  })

  route(
    app,
    "getPublicVolunteerHours",
    { config: { rateLimit: PUBLIC_HOURS_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(UserIdParamsSchema, request.params)
      const query = parse(PublicVolunteerHoursQuerySchema, {
        ...((request.query as object | undefined) ?? {}),
        id,
      })
      const viewerId = request.auth?.userId ?? null
      const payload: PublicVolunteerHoursResponse = await service().getPublicHours(query, viewerId)

      appendVary(reply, "Cookie", "Authorization")
      reply.header(
        "Cache-Control",
        viewerId === null ? "public, max-age=60" : "private, max-age=0, no-store",
      )
      reply.status(200).send(payload)
    },
  )

  // WS5 per-attendee shape: {entries: [{userId, hours}]} (the flat bulk `hours` body is gone). The
  // service enforces the D4 gate (actor organizer|cohost AND the ACTOR verified), the status 'done'
  // gate, and per-entry membership; `credited` = attendee rows written.
  route(
    app,
    "logEventHours",
    { preHandler: csrfProtect, config: { rateLimit: LOG_EVENT_HOURS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(LogEventHoursRequestSchema, { ...(request.body as object), id })
      const payload: LogEventHoursResponse = await service().logEventHours({
        cleanupId: body.id,
        actorId: userId,
        entries: body.entries,
      })
      reply.status(200).send(payload)
    },
  )

  // C10 — the read-back of already-logged hours. Shares the path with logEventHours on a different
  // METHOD, so the method+path pair is still unique. `:id` is a PATH param the query schema consumes.
  route(app, "getEventHours", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const query = parse(EventHoursQuerySchema, {
      ...((request.query as object | undefined) ?? {}),
      id,
    })
    const payload: EventHoursResponse = await service().getEventHours(query.id, userId)
    reply.status(200).send(payload)
  })

  route(
    app,
    "getJurisdictionLeaderboard",
    { config: { rateLimit: LEADERBOARD_RATE_LIMIT } },
    async (request, reply) => {
      const { geoid } = parse(GeoidParamsSchema, request.params)
      // T1 — `request.query` NEVER contains `geoid`: it is a PATH param the client already consumed.
      // Now that LeaderboardQuerySchema requires it, parsing the bare query object 422s every single
      // leaderboard request, including the empty-query one the app actually sends. Inject it.
      const query = parse(LeaderboardQuerySchema, {
        ...((request.query as object | undefined) ?? {}),
        geoid,
      })
      const viewerId = request.auth?.userId ?? null
      const payload: LeaderboardResponse = await service().leaderboard(geoid, query, viewerId)

      // T4 — `viewerRank`/`viewerHours` make ONE url serve TWO bodies. The anon body is identical for
      // everybody and is the dominant traffic (the search page), so it keeps a short shared TTL; the
      // authed body must never enter a shared cache or one user's rank is served to everyone.
      //
      // `Vary: Cookie, Authorization` ships on BOTH branches in the same commit as the split. Without it
      // nothing tells a shared cache WHY the same URL has two bodies — and the api sits behind
      // Cloudflare, where a "Cache Everything" rule written the obvious way overrides an origin
      // `no-store`. The follow-up edge rule must be scoped to /v1/jurisdictions/*/leaderboard with
      // "Respect origin cache-control" ON, never a bare Cache Everything.
      appendVary(reply, "Cookie", "Authorization")
      reply.header(
        "Cache-Control",
        viewerId === null ? "public, max-age=60" : "private, max-age=0, no-store",
      )
      reply.status(200).send(payload)
    },
  )
}
