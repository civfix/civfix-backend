import { describe, expect, it } from "vitest"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import { makeEligibilityBootstrap } from "../../../src/services/payments/eligibility-bootstrap.js"
import { makeMemoryEligibilityRepository, memoryEligibilityOrg } from "../../../src/services/payments/eligibility-repository.memory.js"
import { makeEligibilityService } from "../../../src/services/payments/eligibility-service.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { NOW, ORG_ID, USER_ID, orgRow } from "./helpers.js"

function harness() {
  const eligibility = makeMemoryEligibilityRepository({ orgs: [memoryEligibilityOrg({ organizationId: ORG_ID })] })
  const jobs = new FakeJobs()
  const warnings: unknown[] = []
  const bootstrap = makeEligibilityBootstrap({
    eligibility: makeEligibilityService({
      eligibility,
      orgs: makeMemoryOrgPaymentsRepository({ orgs: [orgRow()] }),
      storage: new FakeStorage(),
      jobs,
      now: () => NOW,
    }),
    logger: { warn: (obj) => warnings.push(obj) },
  })
  return { eligibility, jobs, warnings, bootstrap }
}

describe("eligibility bootstrap on nonprofit verification", () => {
  it("queues an evaluation for a verified nonprofit whose EIN was copied in the approval transaction", async () => {
    const h = harness()
    await h.bootstrap.onNonprofitVerified({ organizationId: ORG_ID, ein: "95-4327245", operatorId: USER_ID })
    expect(h.jobs.enqueued).toHaveLength(1)
    expect(h.jobs.enqueued[0]).toMatchObject({
      name: "eligibility.evaluate",
      data: { organizationId: ORG_ID },
      opts: { singletonKey: `eligibility:${ORG_ID}` },
    })
    expect(h.warnings).toHaveLength(0)
  })

  it("warns instead of queueing when the application carried no usable EIN", async () => {
    const h = harness()
    await h.bootstrap.onNonprofitVerified({ organizationId: ORG_ID, ein: null, operatorId: USER_ID })
    await h.bootstrap.onNonprofitVerified({ organizationId: ORG_ID, ein: "12-34", operatorId: USER_ID })
    expect(h.jobs.enqueued).toHaveLength(0)
    expect(h.warnings).toHaveLength(2)
  })
})
