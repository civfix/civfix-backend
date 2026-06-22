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

import { ReportContentRequestSchema, type ReportContentResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { writeAudit } from "../services/admin/audit.js"
import {
  makeModerationService,
  type ModerationService,
} from "../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../services/admin/moderation-repository.drizzle.js"
import { reportOwnedBy } from "../services/report-sql.js"

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

      // OWNER TAKEDOWN PATH (privacy §7.2): a content report against a `report` subject the CALLER owns is
      // not third-party abuse — it is the reporter asking to remove their OWN published report. `DELETE /me`
      // soft-deletes the account but published reports survive; this is the channel to request removal of a
      // single specific report. We detect ownership server-side, mark the moderation item distinctly (so an
      // operator can fast-track an owner-consented removal), bump priority, and write an audit-log entry. No
      // hard purge happens here (that is a product/counsel decision) — an admin actions the queue item.
      const isOwnerTakedown =
        body.subjectType === "report" &&
        (await isOwnerTakedownReport(app, container, body.subjectId, userId))

      // Enqueue a user-filed report. subjectType maps 1:1 to moderation_items.subject_type (the CHECK was
      // widened in 0024 to include comment|message|event|profile|photo). dedupeOpen keeps one open item per
      // (subjectType, subjectId).
      await moderation().createItem({
        kind: "user_report",
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        flag: isOwnerTakedown ? "Owner takedown request" : "User report",
        reason: body.reason,
        reporter,
        desc: body.details ?? null,
        // An owner asking to remove their own report is consented + low-risk to action, so surface it
        // higher in the queue; third-party reports stay at the default medium priority.
        priority: isOwnerTakedown ? "high" : "med",
        dedupeOpen: true,
      })

      // Audit the owner takedown REQUEST (the removal itself is audited when an operator actions the item).
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

/**
 * Owner-takedown detection for POST /content-reports: is the caller the reporter of this report? DB-gated
 * + fail-safe: with no DATABASE_URL (offline/all-fakes boot) it returns false so the route degrades to the
 * ordinary user-report path rather than attempting a connection; any query error is swallowed to false for
 * the same reason. The ownership query itself lives in the persistence layer (report-sql.reportOwnedBy).
 */
async function isOwnerTakedownReport(
  app: FastifyInstance,
  container: Container,
  reportId: string,
  userId: string,
): Promise<boolean> {
  if (!container.env.DATABASE_URL) return false
  try {
    return await reportOwnedBy(container.getDb().sql, reportId, userId)
  } catch (err) {
    app.log.warn({ err: String(err), reportId }, "content-reports: owner check failed (non-fatal)")
    return false
  }
}
