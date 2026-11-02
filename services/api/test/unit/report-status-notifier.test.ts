/**
 * The operator's status push, which `report-status-notifier.ts` shares with the city-update worker.
 */

import { describe, expect, it } from "vitest"
import type { AdminReportStatus } from "@civfix/contract"
import { makeAdminReportService } from "../../src/services/admin/admin-report-service.js"
import type { OutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { filingHarness, memoryFilingService } from "../helpers/filings/filing-harness.js"

const OWNER = "u-reporter"
const OPERATOR = "op-1"

describe("the shared status push", () => {
  it("T36: an operator's in_progress then resolved sends the same titles and bodies as before this PR", async () => {
    const h = filingHarness()
    const R = h.seed({ status: "acknowledged", reporterId: OWNER })
    const svc = makeAdminReportService({
      repo: h.reports,
      outboundMail: {} as OutboundMailService,
      filings: memoryFilingService(h.reports, { filings: h.filings }),
      notifications: h.notifier,
    })

    for (const status of ["in_progress", "resolved"] as AdminReportStatus[]) {
      await svc.setStatus(R.record.id, { status, actorId: OPERATOR })
    }

    expect(h.notifier.sent).toEqual([
      {
        userId: OWNER,
        type: "report_update",
        title: "Your report is in progress",
        body: "The city is working on your report.",
        link: `/reports/${R.record.id}`,
      },
      {
        userId: OWNER,
        type: "report_update",
        title: "Your report is resolved",
        body: "Your report has been marked resolved.",
        link: `/reports/${R.record.id}`,
      },
    ])
  })
})
