import {
  AdminGetMediaRequestSchema,
  AppError,
  type AdminGetMediaResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { auditRead } from "./_audit-read.js"
import { makeDrizzleMediaRepository } from "../../services/media-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../../services/media-presign.js"
import type { MediaRepository } from "../../services/media-intake-service.js"
import { MEDIA_PRIVATE_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"

export interface AdminMediaOverrides {
  repo: MediaRepository
}

declare module "fastify" {
  interface FastifyInstance {
    adminMediaOverrides?: AdminMediaOverrides
  }
}

export async function registerAdminMediaRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const repo = (): MediaRepository =>
    app.adminMediaOverrides?.repo ?? makeDrizzleMediaRepository(container.getDb().db)
  const presign = makePrivateMediaPresigner(container.storage)

  route(app, "adminGetMedia", async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = parse(AdminGetMediaRequestSchema, request.params)
    const asset = await repo().findById(id)
    if (asset === null || asset.servedKey === null) throw AppError.notFound("Media not found")

    const { url, thumbUrl } = await presign(asset.servedKey, asset.thumbKey)

    await auditRead(request, container, operatorId, {
      action: "media.viewed",
      target: `media:${id}`,
      meta: { purpose: asset.purpose },
    })

    const payload: AdminGetMediaResponse = {
      media: {
        id: asset.id,
        kind: asset.kind,
        codec: asset.codec,
        url,
        ...(thumbUrl !== undefined ? { thumbUrl } : {}),
        width: asset.width,
        height: asset.height,
        status: asset.status,
      },
      expiresAt: new Date(Date.now() + MEDIA_PRIVATE_GET_URL_TTL_SEC * 1000).toISOString(),
    }
    reply.status(200).send(payload)
  })
}
