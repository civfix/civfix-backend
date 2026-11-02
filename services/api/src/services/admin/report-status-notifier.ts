import { ADMIN_REPORT_STATUS_LABELS, type AdminReportStatus } from "@civfix/contract"
import type { FastifyBaseLogger } from "fastify"
import type { ReporterNotifier } from "./admin-report-types.js"

const STATUS_NOTIFICATION_BODIES: Partial<Record<AdminReportStatus, string>> = {
  in_progress: "The city is working on your report.",
  resolved: "Your report has been marked resolved.",
}

/** The reporter's push for a status change, shared by an operator's change and a city's update (D11). */
export async function notifyReporterOfStatus(
  deps: { notifications?: ReporterNotifier; logger?: Pick<FastifyBaseLogger, "warn"> },
  reportId: string,
  reporterUserId: string | null,
  status: AdminReportStatus,
): Promise<void> {
  const body = STATUS_NOTIFICATION_BODIES[status]
  if (body === undefined) return
  if (reporterUserId === null || reporterUserId === "") return
  const notifications = deps.notifications
  if (notifications === undefined) {
    deps.logger?.warn(
      { reportId, status },
      "report status changed with no notifier wired: the reporter was not told",
    )
    return
  }
  try {
    await notifications.createNotification(reporterUserId, {
      type: "report_update",
      title: `Your report is ${ADMIN_REPORT_STATUS_LABELS[status].toLowerCase()}`,
      body,
      link: `/reports/${reportId}`,
    })
  } catch (err) {
    deps.logger?.warn(
      { err, reportId, status },
      "report_update notification failed (suppressed: the status change is committed)",
    )
  }
}
