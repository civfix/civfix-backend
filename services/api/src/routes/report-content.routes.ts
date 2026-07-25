
import { ReportContentRequestSchema, type ReportContentResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { writeAudit } from "../services/admin/audit.js"
import {
  makeModerationService,
  type ModerationService,
} from "../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../services/admin/moderation-repository.drizzle.js"
import { reportOwnedBy } from "../services/report-sql.js"

const REPORT_CONTENT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

export async function registerReportContentRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

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

  route(
    app,
    "reportContent",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CONTENT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ReportContentRequestSchema, request.body)

      const store = app.authServices?.users
      const reporterUser = store ? await store.findById(userId) : null
      const reporter =
        reporterUser?.handle != null && reporterUser.handle !== ""
          ? `@${reporterUser.handle}`
          : (reporterUser?.displayName ?? "User")

      const isOwnerTakedown =
        body.subjectType === "report" &&
        (await isOwnerTakedownReport(container, body.subjectId, userId))

      await moderation().createItem({
        kind: "user_report",
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        flag: isOwnerTakedown ? "Owner takedown request" : "User report",
        reason: body.reason,
        reporter,
        // The authed FLAGGING user's id (distinct from the flagged content's author), so the moderation
        // queue's reporterId deep-links to the actual reporter rather than the subject's owner.
        reporterUserId: userId,
        desc: body.details ?? null,
        priority: isOwnerTakedown ? "high" : "med",
        dedupeOpen: true,
      })

      if (isOwnerTakedown) {
        await writeAudit(container.getDb().sql, {
          actorId: userId,
          action: "report.takedown_requested",
          target: `report:${body.subjectId}`,
          meta: { reason: body.reason, via: "content-reports" },
        })
      }

      const payload: ReportContentResponse = { ok: true }
      reply.status(200).send(payload)
    },
  )
}

async function isOwnerTakedownReport(
  container: Container,
  reportId: string,
  userId: string,
): Promise<boolean> {
  if (!container.env.DATABASE_URL) return false
  return reportOwnedBy(container.getDb().sql, reportId, userId)
}
