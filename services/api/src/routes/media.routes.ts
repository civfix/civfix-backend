/**
 * Media route plugin (all endpoints anon-ok; no auth guard - anonymous users attach media to anon
 * reports).
 *
 *   POST /media/upload             createUpload: cheap pre-checks + presign a direct-to-R2 PUT.
 *   POST /media/:uploadId/finalize finalize: confirm the object + enqueue the "media.checks" job.
 *   GET  /media/:id                getMedia: render a MediaDTO with a presigned/CDN URL (ready only).
 *
 * Owner context: derived from req.auth (signed-in userId or anon session). See media-intake-service.ts:
 * pre-report-commit ownership is CAPABILITY-BASED (the unguessable uploadId is the proof), and only
 * "ready" media is public. The DB handle is reached lazily via container.getDb() inside handlers, so
 * mounting this plugin never opens a connection.
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
  type MediaIntakeService,
  type MediaOwner,
  type MediaRepository,
} from "../services/media-intake-service.js"
import { makeDrizzleMediaRepository } from "../services/media-repository.drizzle.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"

declare module "fastify" {
  interface FastifyInstance {
    // Optional injected media repository (tests) so the create/finalize/getMedia HTTP flow runs offline
    // (no Docker) with an in-memory repo. Unset in production, where the routes reach the DB lazily.
    mediaRepo?: MediaRepository
  }
}

const UploadIdParamsSchema = z.object({ uploadId: IdSchema }).strict()
const MediaIdParamsSchema = z.object({ id: IdSchema }).strict()

// Per-IP cap on the anon-ok write paths above the global 300/min: createMediaUpload mints presigned R2
// PUTs and finalizeMedia enqueues the untrusted-byte media.checks pipeline, so a tight per-route limit
// bounds an unauthenticated client minting hundreds of presigns / pipeline jobs per minute.
const MEDIA_WRITE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

export async function registerMediaRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function service(): MediaIntakeService {
    const repo: MediaRepository =
      app.mediaRepo ?? makeDrizzleMediaRepository(container.getDb().db)
    return makeMediaIntakeService({
      repo,
      storage: container.storage,
      jobs: container.jobs,
      logger: app.log,
    })
  }

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
  }
}
