import type { CleanupDTO } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeCleanupService } from "./cleanup-service.js"
import { makeDrizzleCleanupRepository } from "./cleanup-repository.drizzle.js"
import { enrichCleanupDTOs } from "./cleanup-enrichment.js"
import { makeEventMediaPresigner } from "./host/event-media.js"
import { MEDIA_GET_URL_TTL_SEC } from "./media-intake-service.js"

export type CleanupReader = (cleanupId: string, viewerUserId: string) => Promise<CleanupDTO>

export function makeRouteCleanupReader(
  container: Container,
  logger?: FastifyBaseLogger,
): CleanupReader {
  return (cleanupId, viewerUserId) =>
    makeCleanupService({
      repo: makeDrizzleCleanupRepository(container.getDb().sql),
      presignThumb: (thumbKey: string) =>
        container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC),
      presignEventMedia: makeEventMediaPresigner(container.storage),
      enrichDTOs: (dtos, viewer) => enrichCleanupDTOs(container, dtos, viewer),
      ...(logger !== undefined ? { logger } : {}),
    }).getCleanup(cleanupId, { userId: viewerUserId })
}
