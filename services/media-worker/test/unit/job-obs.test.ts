import { afterEach, describe, expect, it, vi } from "vitest"
import { debugLog, resolveJobObs } from "../../src/jobs/obs.js"

describe("worker debug lines", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("never reach stdout in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    debugLog("media.checks: hold-release skipped", { uploadId: "u1" })
    resolveJobObs({}).debug("orphan.sweep: done", { deleted: 0 })
    expect(debug).not.toHaveBeenCalled()
  })

  it("print on a local run", () => {
    vi.stubEnv("NODE_ENV", "development")
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    resolveJobObs({}).debug("orphan.sweep: done", { deleted: 0 })
    expect(debug).toHaveBeenCalledWith("orphan.sweep: done", { deleted: 0 })
  })
})
