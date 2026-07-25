/**
 * Media route plugin.
 *
 *   POST /media/upload             createUpload: cheap pre-checks + presign a direct-to-R2 PUT.
 *   POST /media/:uploadId/finalize finalize: confirm the object + enqueue the "media.checks" job.
 *   GET  /media/:id                getMedia: render a MediaDTO with a presigned URL (ready + AUTHORIZED).
 *
 * AUTHORIZATION (security review H9). getMedia used to authorize NOTHING: any caller holding a media id
 * got a fresh presigned URL, which leaked private DM/group-chat attachments, media on held/unlisted
 * reports, and attachments on deleted posts. It now resolves the asset's binding and authorizes the
 * viewer against that subject's existing visibility rules — see services/media-authorization.ts. Every
 * deny is a 404, never a 403, so the endpoint is not an existence oracle.
 *
 * The write paths stay anon-reachable by necessity: an anonymous reporter uploads photos BEFORE the
 * report (and therefore before any anon session) exists, so there is no identity to require yet. They
 * are instead bounded by (a) the per-IP request cap below and (b) a cumulative per-caller BYTE quota
 * (M10, services/media-byte-quota.ts).
 *
 * ============================================================================================
 * TODO (L1, CSRF on createMediaUpload + finalizeMedia) — DELIBERATELY NOT ENFORCED YET.
 *
 * These are the only two cookie-authenticated state-changing routes with no `csrfProtect`
 * preHandler, and adding one was tried and REVERTED. It cannot land on the backend alone:
 *
 *   - csrfProtect enforces on any request with a session cookie and no bearer token — i.e. every
 *     signed-in civfix-web request (mobile is bearer and short-circuits).
 *   - the shared typed client only sends `X-CSRF-Token` when the ENDPOINT DEFINITION says so
 *     (@civfix/shared client: `if (endpoint.csrf && opts.getCsrfToken)`), and the published
 *     contract declares `createMediaUpload csrf: false` / `finalizeMedia csrf: false`.
 *
 * So enforcing here returns 403 "CSRF token missing or invalid." to every signed-in web user on
 * POST /v1/media/upload, breaking report photos, avatar upload and composer attachments. The
 * residual risk is LOW (a cross-origin POST is already blocked by the CORS preflight, and the
 * response — a presigned PUT URL — is not readable cross-origin), which does not justify a
 * guaranteed production break.
 *
 * Conditional enforcement ("enforce only when the client sent a header") is NOT an acceptable
 * middle ground: an attacker simply omits the header, so it protects nobody while looking like it
 * does.
 *
 * TO RE-ADD: ship `csrf: true` for both endpoints in @civfix/shared FIRST, then in the SAME
 * release bump this service to that version and add `preHandler: csrfProtect` to both `route(...)`
 * calls below. Order matters — backend-first breaks web, shared-first is a no-op until this lands.
 * ============================================================================================
 *
 * Pre-report-commit ownership remains CAPABILITY-BASED (the unguessable uploadId/media id is the proof)
 * and is bounded in time by media-authorization.ts UNBOUND_GRACE_MS. The DB handle is reached lazily via
 * container.getDb() inside handlers, so mounting this plugin never opens a connection.
 */

import {
  CreateMediaUploadRequestSchema,
  FinalizeMediaRequestSchema,
  IdSchema,
  type CreateMediaUploadResponse,
  type FinalizeMediaResponse,
  type GetMediaResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import {
  makeMediaIntakeService,
  type MediaByteQuota,
  type MediaIntakeService,
  type MediaOwner,
  type MediaRepository,
} from "../services/media-intake-service.js"
import { makeDrizzleMediaRepository } from "../services/media-repository.drizzle.js"
import {
  makeDrizzleMediaViewAuthorizer,
  type MediaViewAuthorizer,
} from "../services/media-authorization.js"
import { MEDIA_UPLOAD_BYTES_PER_DAY, type ByteMeter } from "../services/media-byte-quota.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"

declare module "fastify" {
  interface FastifyInstance {
    // Optional injected media repository (tests) so the create/finalize/getMedia HTTP flow runs offline
    // (no Docker) with an in-memory repo. Unset in production, where the routes reach the DB lazily.
    mediaRepo?: MediaRepository
    // Optional injected view authorizer (tests). Unset in production, where the DB-backed authorizer is
    // built lazily below. When BOTH this and mediaRepo are unset the service falls back to its
    // fail-closed unbound-only authorizer.
    mediaAuthorizer?: MediaViewAuthorizer
    // Optional injected byte meter (tests). Unset in production, where Redis backs the quota.
    mediaByteMeter?: ByteMeter
  }
}

const UploadIdParamsSchema = z.object({ uploadId: IdSchema }).strict()
const MediaIdParamsSchema = z.object({ id: IdSchema }).strict()

// Per-IP cap on the anon-ok write paths above the global 300/min: createMediaUpload mints presigned R2
// PUTs and finalizeMedia enqueues the untrusted-byte media.checks pipeline, so a tight per-route limit
// bounds an unauthenticated client minting hundreds of presigns / pipeline jobs per minute. This bounds
// FREQUENCY only — the cumulative byte quota below bounds VOLUME (M10).
const MEDIA_WRITE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

export async function registerMediaRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function byteQuota(): MediaByteQuota | undefined {
    const meter = app.mediaByteMeter ?? redisFallbackMeter()
    if (!meter) return undefined
    return {
      limitBytes: MEDIA_UPLOAD_BYTES_PER_DAY,
      charge: (subject, bytes) => meter.add(subject, bytes),
    }
  }

  function redisFallbackMeter(): ByteMeter | undefined {
    // No Redis configured (no-infra boot) -> no byte quota; the per-route + global rate limits still
    // apply. Production always has REDIS_URL, so the quota is always active there.
    //
    // container.getByteMeter() rather than a route-local RedisByteMeter: the container's wrapper resolves
    // ONE RedisByteMeter per process on first add (and drops it in close(), so a post-close reuse cannot
    // charge into a quit connection). Constructing it opens nothing, which is what mount time requires.
    if (!container.env.REDIS_URL) return undefined
    return container.getByteMeter()
  }

  function service(): MediaIntakeService {
    const repo: MediaRepository =
      app.mediaRepo ?? makeDrizzleMediaRepository(container.getDb().db)
    // An injected authorizer wins (tests). Otherwise: the DB-backed one when there is no injected repo
    // (i.e. production), and the service's fail-closed default when an in-memory repo is in play.
    const authorizer =
      app.mediaAuthorizer ??
      (app.mediaRepo ? undefined : makeDrizzleMediaViewAuthorizer(container.getDb().sql))
    const quota = byteQuota()
    return makeMediaIntakeService({
      repo,
      storage: container.storage,
      jobs: container.jobs,
      logger: app.log,
      ...(authorizer ? { authorizer } : {}),
      ...(quota ? { byteQuota: quota } : {}),
    })
  }

  // NO `preHandler: csrfProtect` HERE — see the CSRF block in the module header before adding one; it
  // 403s every signed-in web caller until @civfix/shared declares `createMediaUpload csrf: true`.
  route(
    app,
    "createMediaUpload",
    { config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = parse(CreateMediaUploadRequestSchema, request.body)
      const payload: CreateMediaUploadResponse = await service().createUpload(body, ownerOf(request))
      reply.status(200).send(payload)
    },
  )

  // Same as createMediaUpload above: CSRF stays off until the shared contract declares
  // `finalizeMedia csrf: true`, and both must move in one release.
  route(
    app,
    "finalizeMedia",
    { config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { uploadId } = parse(UploadIdParamsSchema, request.params)
      // The body is empty/ignored; the uploadId in the path IS the request. Still validated via the shared
      // schema so the contract (FinalizeMediaRequest { uploadId }) stays the single source.
      const input = parse(FinalizeMediaRequestSchema, { uploadId })
      const payload: FinalizeMediaResponse = await service().finalize(input, ownerOf(request))
      reply.status(200).send(payload)
    },
  )

  route(app, "getMedia", async (request, reply) => {
    const { id } = parse(MediaIdParamsSchema, request.params)
    const payload: GetMediaResponse = await service().getMedia(id, ownerOf(request))
    reply.status(200).send(payload)
  })
}

function ownerOf(request: FastifyRequest): MediaOwner {
  const auth = request.auth
  return {
    userId: auth?.userId ?? undefined,
    anonSessionId: auth?.anonSessionId ?? undefined,
    // Last-resort quota bucket: a caller with neither an account nor an anon cookie is metered by IP.
    ipKey: normalizeIp(request.ip),
  }
}
