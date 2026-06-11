/**
 * Media route plugin (all endpoints anon-ok; no auth guard - anonymous users attach media to anon
 * reports). Bodies/params are validated against the @civfix/shared Zod schemas (same `parse` ->
 * AppError.validation pattern as auth.routes.ts / map.routes.ts).
 *
 *   POST /media/upload            createUpload: cheap pre-checks + presign a direct-to-R2 PUT.
 *   POST /media/:uploadId/finalize finalize: confirm the object + enqueue the "media.checks" job.
 *   GET  /media/:id               getMedia: render a MediaDTO with a presigned/CDN URL (ready only).
 *
 * Owner context: derived from req.auth (resolved by the auth onRequest hook). A signed-in caller
 * supplies userId; an anonymous caller may carry an anonSessionId. See media-intake-service.ts for how
 * ownership (capability-based via the unguessable uploadId) and visibility (ready media is public) work.
 *
 * The DB handle is reached lazily via container.getDb() only inside the handlers, so merely mounting
 * this plugin never opens a connection (consistent with the map plugin).
 */

import {
  CreateMediaUploadRequestSchema,
  FinalizeMediaRequestSchema,
  IdSchema,
  AppError,
  type CreateMediaUploadResponse,
  type FinalizeMediaResponse,
  type GetMediaResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import {
  makeMediaIntakeService,
  type MediaIntakeService,
  type MediaOwner,
  type MediaRepository,
} from "../services/media-intake-service.js"
import { makeDrizzleMediaRepository } from "../services/media-repository.drizzle.js"
import { route } from "../versioning/route.js"

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Optional injected media repository (tests). When present, the media routes use it instead of
     * building the Drizzle-backed repo from the DB handle, which lets the create/finalize/getMedia HTTP
     * flow be exercised offline (no Docker) with an in-memory repo. In production it is left unset and
     * the routes reach the database lazily via container.getDb().
     */
    mediaRepo?: MediaRepository
  }
}

/** Path param schema for the routes that take a UUID in the URL. */
const UploadIdParamsSchema = z.object({ uploadId: IdSchema }).strict()
const MediaIdParamsSchema = z.object({ id: IdSchema }).strict()

export async function registerMediaRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the intake service bound to the repo (injected in tests, else DB-backed) + container seams. */
  function service(): MediaIntakeService {
    const repo: MediaRepository =
      app.mediaRepo ?? makeDrizzleMediaRepository(container.getDb().db)
    return makeMediaIntakeService({
      repo,
      storage: container.storage,
      jobs: container.jobs,
    })
  }

  // -------------------------------------------------------------------------
  // POST /media/upload  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "createMediaUpload", async (request, reply) => {
    const body = parse(CreateMediaUploadRequestSchema, request.body)
    const payload: CreateMediaUploadResponse = await service().createUpload(body, ownerOf(request))
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /media/:uploadId/finalize  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "finalizeMedia", async (request, reply) => {
    const { uploadId } = parse(UploadIdParamsSchema, request.params)
    // The body is empty/ignored; the uploadId in the path is the request. We still validate via the
    // shared schema so the contract (FinalizeMediaRequest { uploadId }) stays the single source.
    const input = parse(FinalizeMediaRequestSchema, { uploadId })
    const payload: FinalizeMediaResponse = await service().finalize(input, ownerOf(request))
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /media/:id  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "getMedia", async (request, reply) => {
    const { id } = parse(MediaIdParamsSchema, request.params)
    const payload: GetMediaResponse = await service().getMedia(id, ownerOf(request))
    reply.status(200).send(payload)
  })
}

/** Derive the owner context from the resolved auth on the request (signed-in userId or anon session). */
function ownerOf(request: FastifyRequest): MediaOwner {
  const auth = request.auth
  return {
    userId: auth?.userId ?? undefined,
    anonSessionId: auth?.anonSessionId ?? undefined,
  }
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned instead of a generic 500. Mirrors auth/map routes.
 */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
