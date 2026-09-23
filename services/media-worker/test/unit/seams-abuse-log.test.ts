import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSeams } from "../../src/seams.js"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("media-worker abuse-checks seam logging", () => {
  it("routes the real abuse checks' log lines to the worker's injected logger, not console", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const lines: { line: string; extra?: Record<string, unknown> }[] = []
    const seams = await buildSeams(
      { NODE_ENV: "test", USE_FAKE_ABUSE_NSFW: "0" },
      { log: (line, extra) => lines.push({ line, ...(extra ? { extra } : {}) }) },
    )
    try {
      await expect(seams.abuseChecks.nsfwScore(new Uint8Array([1, 2, 3]))).resolves.toBe(0)
    } finally {
      await seams.close()
    }

    expect(lines.map((l) => l.line)).toEqual([expect.stringMatching(/NSFW model not configured/)])
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})
