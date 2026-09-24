import { describe, expect, it } from "vitest"
import { loadLimits } from "../../src/config.js"
import { imageLaneTimeoutMs } from "../../src/sandbox/image-lane.js"

// A lane kill that lands after the job budget turns a slow hostile image into a JobTimeoutError, which
// media.checks retries as infra instead of rejecting the bytes.
describe("loadLimits keeps the image lane inside the job budget", () => {
  it("boots with the defaults, whose lane budget sits below the job budget", () => {
    const limits = loadLimits({})
    expect(imageLaneTimeoutMs(limits)).toBeLessThan(limits.jobTimeoutMs)
  })

  it("boots with the largest image timeout the default job budget allows", () => {
    const limits = loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "28000" })
    expect(imageLaneTimeoutMs(limits)).toBe(89_000)
  })

  it("refuses to start when the image timeout pushes the lane past the job budget", () => {
    expect(() => loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "30000" })).toThrow(
      /media-worker: .*MEDIA_IMAGE_TIMEOUT_MS=30000.* 95000ms .*MEDIA_JOB_TIMEOUT_MS=90000/,
    )
  })

  it("refuses to start when the lane budget equals the job budget", () => {
    expect(() =>
      loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "15000", MEDIA_JOB_TIMEOUT_MS: "50000" }),
    ).toThrow(/MEDIA_JOB_TIMEOUT_MS=50000/)
  })

  it("boots when the job budget is raised along with the image timeout", () => {
    const limits = loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "30000", MEDIA_JOB_TIMEOUT_MS: "100000" })
    expect(limits.imageTimeoutMs).toBe(30_000)
    expect(limits.jobTimeoutMs).toBe(100_000)
  })
})
