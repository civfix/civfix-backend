import { describe, expect, it } from "vitest"
import { loadLimits, videoPathTimeoutMs } from "../../src/config.js"
import { imageLaneTimeoutMs } from "../../src/sandbox/image-lane.js"

// A lane kill that lands after the job budget turns a slow hostile image into a JobTimeoutError, which
// media.checks retries as infra instead of rejecting the bytes.
describe("loadLimits keeps the image lane inside the job budget", () => {
  it("boots with the defaults, whose lane budget sits below the job budget", () => {
    const limits = loadLimits({})
    expect(imageLaneTimeoutMs(limits)).toBeLessThan(limits.jobTimeoutMs)
  })

  it("boots with the largest image timeout the default budgets allow, which the video path sets", () => {
    const limits = loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "18333" })
    expect(imageLaneTimeoutMs(limits)).toBe(59_999)
    expect(videoPathTimeoutMs(limits)).toBe(289_999)
    expect(() => loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "18334" })).toThrow(/slowest video path/)
  })

  it("refuses to start when the image timeout pushes the lane past the job budget", () => {
    expect(() => loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "100000" })).toThrow(
      /media-worker: .*MEDIA_IMAGE_TIMEOUT_MS=100000.* 305000ms .*MEDIA_JOB_TIMEOUT_MS=290000/,
    )
  })

  it("refuses to start when the lane budget equals the job budget", () => {
    expect(() =>
      loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "15000", MEDIA_JOB_TIMEOUT_MS: "50000" }),
    ).toThrow(/MEDIA_JOB_TIMEOUT_MS=50000/)
  })

  it("boots when the job budget is raised along with the image timeout", () => {
    const limits = loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "30000", MEDIA_JOB_TIMEOUT_MS: "400000" })
    expect(limits.imageTimeoutMs).toBe(30_000)
    expect(limits.jobTimeoutMs).toBe(400_000)
  })
})

// The thumbnail of a video's poster frame runs through the same lane, after the transcode and its waits.
describe("loadLimits keeps the slowest video inside the job budget", () => {
  it("boots with the defaults, whose video path sits below the job budget", () => {
    const limits = loadLimits({})
    expect(videoPathTimeoutMs(limits)).toBe(280_000)
    expect(videoPathTimeoutMs(limits)).toBeLessThan(limits.jobTimeoutMs)
  })

  it("refuses to start when a larger batch waits out more transcodes than the budget covers", () => {
    expect(() => loadLimits({ MEDIA_CHECKS_CONCURRENCY: "3" })).toThrow(
      /media-worker: the slowest video path takes up to 370000ms .*MEDIA_JOB_TIMEOUT_MS=290000/,
    )
  })

  it("refuses to start when the image timeout pushes the video path past the budget", () => {
    expect(() => loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "20000" })).toThrow(
      /slowest video path takes up to 295000ms/,
    )
  })

  it("boots when the job budget is raised along with the transcode timeout", () => {
    const limits = loadLimits({
      MEDIA_TRANSCODE_TIMEOUT_MS: "120000",
      MEDIA_JOB_TIMEOUT_MS: "400000",
    })
    expect(videoPathTimeoutMs(limits)).toBe(340_000)
  })
})
