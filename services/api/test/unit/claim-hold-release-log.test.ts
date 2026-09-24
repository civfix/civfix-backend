import { describe, expect, it } from "vitest"
import type { ReportDTO } from "@civfix/shared"
import { sha256Hex } from "../../src/auth/crypto.js"
import { makeClaimService } from "../../src/services/claim-service.js"
import { InMemoryAnonStore } from "../helpers/anon.js"

describe("claimReport when the hold-release enqueue fails", () => {
  it("still returns the claimed report and logs the failure with the report id", async () => {
    const store = new InMemoryAnonStore()
    const token = store.seedToken({ id: "tok-1" })
    store.seedReport({
      id: "rep-1",
      anonSessionId: token.id,
      reporterUserId: null,
      status: "held",
      claimCodeHash: await sha256Hex("claim-xyz"),
    })
    const warnings: { obj: unknown; msg: string | undefined }[] = []
    const queueDown = new Error("queue down")
    const service = makeClaimService({
      repo: store.claimRepo(),
      anonTokenSigningKey: "test-anon-signing-key",
      getReportForOwner: (reportId) => Promise.resolve({ id: reportId } as ReportDTO),
      enqueueHoldRelease: () => Promise.reject(queueDown),
      logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    })

    const result = await service.claimReport("claim-xyz", "user-1")

    expect(result.report.id).toBe("rep-1")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.obj).toEqual({ err: queueDown, reportId: "rep-1" })
  })
})
