/**
 * Verification route plugin ("verified neighbor").
 *
 *   GET /me/verification   [auth]   the viewer's own verification status ({ status }).
 *
 * There is no in-app application: a user gets verified by scheduling a call with the founder (an external
 * link the UI surfaces) and an operator marks the account verified from the admin Users section. So the
 * citizen surface is read-only. The service is built per request from an injected override (tests) or the
 * container (production: the Drizzle verification repo).
 */

import type { GetMyVerificationResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeVerificationService,
  type VerificationService,
} from "../services/verification-service.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { route } from "../versioning/route.js"

/** Optional injected verification-service override (tests) so the HTTP flow runs offline. */
export interface VerificationServiceOverride {
  service: VerificationService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected verification-service override (tests). See VerificationServiceOverride. */
    verificationOverride?: VerificationServiceOverride
  }
}

export async function registerVerificationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the verification service from an injected override (tests) or the container (production). */
  function service(): VerificationService {
    const override = app.verificationOverride
    if (override) return override.service
    return makeVerificationService({
      repo: makeDrizzleVerificationRepository(container.getDb().sql),
    })
  }

  // -------------------------------------------------------------------------
  // GET /me/verification  [auth]
  // -------------------------------------------------------------------------
  route(app, "myVerification", async (request, reply) => {
    const userId = requireAuth(request)
    const verification = await service().getMine(userId)
    const payload: GetMyVerificationResponse = { verification }
    reply.status(200).send(payload)
  })
}
