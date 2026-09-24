/**
 * getMedia authorizes the viewer against the bound subject's own visibility rules
 * (services/media-authorization.ts); without that, any holder of a media id got a fresh presigned URL to
 * private DM/group-chat attachments, media on held/unlisted reports and attachments on deleted posts.
 * Every deny is a 404, never a 403, so the endpoint is not an existence oracle.
 *
 * The write paths stay anon-reachable by necessity: an anonymous reporter uploads photos BEFORE the
 * report (and therefore any anon session) exists. They are bounded instead by the per-IP request cap
 * below and a cumulative per-caller byte quota (services/media-byte-quota.ts).
 *
 * CSRF is deliberately not enforced on createMediaUpload and finalizeMedia, the only two
 * cookie-authenticated state-changing routes without `csrfProtect`. Adding it was tried and reverted
 * because it cannot land on the backend alone:
 *
 *   - csrfProtect enforces on any request with a session cookie and no bearer token, i.e. every
 *     signed-in civfix-web request (mobile is bearer and short-circuits).
 *   - the shared typed client only sends `X-CSRF-Token` when the ENDPOINT DEFINITION says so
 *     (@civfix/shared client: `if (endpoint.csrf && opts.getCsrfToken)`), and the published
 *     contract declares `createMediaUpload csrf: false` / `finalizeMedia csrf: false`.
 *
 * Enforcing here would 403 every signed-in web user on POST /v1/media/upload, breaking report photos,
 * avatar upload and composer attachments. The residual risk is low (a cross-origin POST is already
 * blocked by the CORS preflight, and the response, a presigned PUT URL, is not readable cross-origin),
 * which does not justify a guaranteed production break.
 *
 * Conditional enforcement ("enforce only when the client sent a header") is not a middle ground: an
 * attacker simply omits the header, so it protects nobody while looking like it does.
 *
 * Enabling it takes `csrf: true` for both endpoints in @civfix/shared FIRST, then, in the same release,
 * this service adopting that version and adding `preHandler: csrfProtect` to both `route(...)` calls
 * below. Backend-first breaks web; shared-first is a no-op until the backend follows.
 *
 * Pre-report-commit ownership is CAPABILITY-BASED (the unguessable uploadId/media id is the proof) and is
 * bounded in time by media-authorization.ts UNBOUND_GRACE_MS. The DB handle is reached lazily via
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
import { perHost } from "../plugins/rate-limit.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"

declare module "fastify" {
  interface FastifyInstance {
    // Tests inject these so the HTTP flow runs offline; production leaves them unset and reaches the DB
    // and Redis lazily. With neither mediaRepo nor mediaAuthorizer set, the service falls back to its
    // fail-closed unbound-only authorizer.
    mediaRepo?: MediaRepository
    mediaAuthorizer?: MediaViewAuthorizer
    mediaByteMeter?: ByteMeter
  }
}

const UploadIdParamsSchema = z.object({ uploadId: IdSchema }).strict()
const MediaIdParamsSchema = z.object({ id: IdSchema }).strict()

// Per-IP cap on the anon-ok write paths above the global 300/min: createMediaUpload mints presigned R2
// PUTs and finalizeMedia enqueues the untrusted-byte media.checks pipeline, so a tight per-route limit
// bounds an unauthenticated client minting hundreds of presigns / pipeline jobs per minute. This bounds
// frequency only; the cumulative byte quota bounds volume.
export const MEDIA_WRITE_RATE_LIMIT = perHost({ max: 30, timeWindow: "1 minute" })

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
    // Without Redis (no-infra boot) there is no byte quota, only the rate limits; production always has
    // REDIS_URL. container.getByteMeter() rather than a route-local RedisByteMeter: the container's
    // wrapper resolves ONE RedisByteMeter per process on first add (and drops it in close(), so a
    // post-close reuse cannot charge into a quit connection). Constructing it opens nothing, which is
    // what mount time requires.
    if (!container.env.REDIS_URL) return undefined
    return container.getByteMeter()
  }

  function service(): MediaIntakeService {
    const repo: MediaRepository = app.mediaRepo ?? makeDrizzleMediaRepository(container.getDb().db)
    // An in-memory repo gets the service's fail-closed default authorizer, never the DB-backed one.
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

  // No `preHandler: csrfProtect` here: read the CSRF block in the module header before adding one. It
  // 403s every signed-in web caller until @civfix/shared declares `createMediaUpload csrf: true`.
  route(
    app,
    "createMediaUpload",
    { config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = parse(CreateMediaUploadRequestSchema, request.body)
      const payload: CreateMediaUploadResponse = await service().createUpload(
        body,
        ownerOf(request),
      )
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
      // The uploadId in the path IS the request; it still goes through the shared schema so the contract
      // stays the single source.
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
    guestAnonSessionId: auth?.guestAnonSessionId ?? undefined,
    // Last-resort quota bucket: a caller with neither an account nor an anon cookie is metered by IP.
    ipKey: normalizeIp(request.ip),
  }
}
