/**
 * Public content-report route plugin (App-Store-audit remediation: the user-facing "Report" button
 * across the UGC surfaces).
 *
 *   POST /content-reports  [auth][csrf][rate-limit]  file a content report against a UGC subject
 *                          ({ subjectType, subjectId, reason, details? }) -> { ok: true }.
 *
 * The handler resolves the reporter's identity (handle/display name) and enqueues a `user_report`
 * moderation item via ModerationService.createItem with dedupeOpen:true (50 users reporting one photo
 * create ONE open queue item, not 50). The item lands in the existing admin moderation queue with no
 * admin-side change. The moderation service is built the SAME way moderation.routes.ts does — from the
 * container's Drizzle repo, or an injected in-memory repo (app.moderationOverrides) for the offline tests.
 */

import {
  ReportContentRequestSchema,
  AppError,
  type ReportContentResponse,
} from "@civfix/shared"
import { ZodError, type z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
import {
  makeModerationService,
  type ModerationService,
} from "../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../services/admin/moderation-repository.drizzle.js"

/**
 * Tighter per-IP rate limit for filing content reports: a real user reports a handful per minute; 20/min
 * bounds report-spam while staying ample. Mirrors the DM-open / discussion-write write limits.
 */
export const REPORT_CONTENT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

export async function registerReportContentRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /**
   * Build the moderation service the SAME way the admin moderation routes do: from the injected in-memory
   * repo (tests) via app.moderationOverrides, else the container's Drizzle repo. Reusing the SAME override
   * seam lets a test inject one in-memory ModerationRepository that both this public route and the admin
   * queue read.
   */
  function moderation(): ModerationService {
    const overrides = app.moderationOverrides
    if (overrides) {
      return makeModerationService({
        repo: overrides.repo,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    return makeModerationService({
      repo: makeDrizzleModerationRepository(container.getDb().sql),
    })
  }

  // -------------------------------------------------------------------------
  // POST /content-reports  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
  route(
    app,
    "reportContent",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CONTENT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ReportContentRequestSchema, request.body)

      // Resolve the reporter label (handle preferred, else display name) for the queue row. Best-effort:
      // a missing store just yields a generic label rather than failing the report.
      const store = app.authServices?.users
      const reporterUser = store ? await store.findById(userId) : null
      const reporter =
        reporterUser?.handle != null && reporterUser.handle !== ""
          ? `@${reporterUser.handle}`
          : (reporterUser?.displayName ?? "User")

      // Enqueue a user-filed abuse report. subjectType maps 1:1 to moderation_items.subject_type (the
      // CHECK was widened in 0024 to include comment|message|event|profile|photo). dedupeOpen keeps one
      // open item per (subjectType, subjectId).
      await moderation().createItem({
        kind: "user_report",
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        flag: "User report",
        reason: body.reason,
        reporter,
        desc: body.details ?? null,
        priority: "med",
        dedupeOpen: true,
      })

      const payload: ReportContentResponse = { ok: true }
      reply.status(200).send(payload)
    },
  )
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on failure
 * so the canonical envelope is returned instead of a generic 500. Mirrors the other route plugins.
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
