import { describe, expect, it } from "vitest"
import { eligibilityImportSchedules } from "../../../src/services/payments/payments-jobs.js"
import {
  ELIGIBILITY_IMPORT_QUEUES,
  ELIGIBILITY_IMPORT_SOURCES,
  PAYMENTS_QUEUE_NAMES,
} from "../../../src/services/payments/payments-queues.js"
import type { PaymentsEnv } from "../../../src/env/payments-env.js"

const ENV = {
  ELIGIBILITY_IRS_CRON: "0 9 5 * *",
  ELIGIBILITY_FTB_CRON: "30 9 5 * *",
  ELIGIBILITY_MNOS_CRON: "0 17 * * 3",
  ELIGIBILITY_OFAC_CRON: "0 10 5 * *",
} as PaymentsEnv

describe("eligibility import schedules", () => {
  it("uses one queue per source, because pg-boss keeps exactly one schedule per queue name", () => {
    const schedules = eligibilityImportSchedules(ENV)
    expect(schedules.map((s) => s.source)).toEqual([...ELIGIBILITY_IMPORT_SOURCES])
    expect(new Set(schedules.map((s) => s.queue)).size).toBe(schedules.length)
    for (const schedule of schedules) {
      expect(schedule.queue).toBe(`eligibility.import.${schedule.source}`)
      expect(PAYMENTS_QUEUE_NAMES).toContain(schedule.queue)
    }
    expect(ELIGIBILITY_IMPORT_QUEUES).toHaveLength(6)
  })

  it("maps every source to the cron its list is published on", () => {
    const byQueue = new Map(eligibilityImportSchedules(ENV).map((s) => [s.source, s.cron]))
    expect(byQueue.get("irs_pub78")).toBe(ENV.ELIGIBILITY_IRS_CRON)
    expect(byQueue.get("irs_eo_bmf")).toBe(ENV.ELIGIBILITY_IRS_CRON)
    expect(byQueue.get("irs_auto_revocation")).toBe(ENV.ELIGIBILITY_IRS_CRON)
    expect(byQueue.get("ftb_revoked")).toBe(ENV.ELIGIBILITY_FTB_CRON)
    expect(byQueue.get("ca_ag_mnos")).toBe(ENV.ELIGIBILITY_MNOS_CRON)
    expect(byQueue.get("ofac_sdn")).toBe(ENV.ELIGIBILITY_OFAC_CRON)
  })
})
