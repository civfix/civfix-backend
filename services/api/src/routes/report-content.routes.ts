import { ReportContentRequestSchema, type ReportContentResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { perIdentity } from "../plugins/rate-limit.js"
import { writeAudit } from "../services/admin/audit.js"
import {
  makeModerationService,
  type ModerationService,
} from "../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../services/admin/moderation-repository.drizzle.js"
import { reportOwnedBy } from "../services/report-sql.js"
import {
  makeAllowAllContentSubjectGate,
  makeDrizzleContentSubjectGate,
  type ContentSubjectGate,
} from "../services/content-report-subject.js"

export const REPORT_CONTENT_RATE_LIMIT = perIdentity({
  max: 20,
  timeWindow: "1 minute",
  hostMax: 60,
})

const OWNER_TAKEDOWN_FLAG = "Owner takedown request"
const USER_REPORT_FLAG = "User report"
const FALLBACK_REPORTER_LABEL = "User"
const TAKEDOWN_REQUESTED_AUDIT_ACTION = "report.takedown_requested"

declare module "fastify" {
  interface FastifyInstance {
    contentSubjectGate?: ContentSubjectGate
  }
}

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

  function subjectGate(): ContentSubjectGate {
    if (app.contentSubjectGate) return app.contentSubjectGate
    if (!container.env.DATABASE_URL) return makeAllowAllContentSubjectGate()
    const handle = container.getDb()
    return makeDrizzleContentSubjectGate(handle.sql, handle.db)
  }

  route(
    app,
    "reportContent",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CONTENT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ReportContentRequestSchema, request.body)

      await subjectGate().assertReportable(body.subjectType, body.subjectId, userId)

      const store = app.authServices?.users
      const reporter = reporterLabel(store ? await store.findById(userId) : null)

      const isOwnerTakedown =
        body.subjectType === "report" &&
        (await isOwnerTakedownReport(container, body.subjectId, userId))

      await moderation().createItem({
        kind: "user_report",
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        flag: isOwnerTakedown ? OWNER_TAKEDOWN_FLAG : USER_REPORT_FLAG,
        reason: body.reason,
        reporter,
        reporterUserId: userId,
        desc: body.details ?? null,
        priority: isOwnerTakedown ? "high" : "med",
        dedupeOpen: true,
      })

      if (isOwnerTakedown) {
        await writeAudit(container.getDb().sql, {
          actorId: userId,
          action: TAKEDOWN_REQUESTED_AUDIT_ACTION,
          target: `report:${body.subjectId}`,
          meta: { reason: body.reason, via: "content-reports" },
        })
      }

      const payload: ReportContentResponse = { ok: true }
      reply.status(200).send(payload)
    },
  )
}

function reporterLabel(
  user: { handle?: string | null; displayName?: string | null } | null | undefined,
): string {
  return user?.handle != null && user.handle !== ""
    ? `@${user.handle}`
    : (user?.displayName ?? FALLBACK_REPORTER_LABEL)
}

async function isOwnerTakedownReport(
  container: Container,
  reportId: string,
  userId: string,
): Promise<boolean> {
  if (!container.env.DATABASE_URL) return false
  return reportOwnedBy(container.getDb().sql, reportId, userId)
}
