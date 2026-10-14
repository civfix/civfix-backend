import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const runToolMock = vi.fn()

vi.mock("../../src/sandbox/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/exec.js")>()
  return {
    ...actual,
    runTool: (...args: unknown[]) => runToolMock(...args),
  }
})

const { loadLimits } = await import("../../src/config.js")
const { resetSandboxIdentity } = await import("../../src/sandbox/exec.js")
const { processImageLane } = await import("../../src/sandbox/image-lane.js")
const fx = await import("../fixtures/make.js")

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  runToolMock.mockReset()
  process.env.MEDIA_SANDBOX_UID = String(process.getuid?.() ?? 1001)
  process.env.MEDIA_SANDBOX_GID = String(process.getgid?.() ?? 1001)
  process.env.MEDIA_IMAGE_LANE_ENTRY = fileURLToPath(import.meta.url)
  resetSandboxIdentity()
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  resetSandboxIdentity()
})

describe("image lane child budget", () => {
  it("lets the child finish all three phases it bounds by imageTimeoutMs (metadata, strip + thumb, phash)", async () => {
    const limits = loadLimits({ MEDIA_IMAGE_TIMEOUT_MS: "15000" })
    runToolMock.mockImplementation(async (_name: string, _bin: string, args: string[]) => {
      const req = JSON.parse(args[2] as string) as { outDir: string }
      await writeFile(join(req.outDir, "stripped.bin"), Buffer.from([1]))
      await writeFile(join(req.outDir, "thumb.bin"), Buffer.from([2]))
      return {
        stdout: JSON.stringify({
          ok: true,
          meta: { width: 1, height: 1, format: "png" },
          strippedContentType: "image/png",
          thumbnailContentType: "image/jpeg",
          exifGps: null,
          phash: null,
        }),
        stderr: "",
        stdoutBuffer: Buffer.alloc(0),
        exitCode: 0,
      }
    })

    await processImageLane(await fx.makeValidPng(), limits)

    const opts = runToolMock.mock.calls[0]![3] as { timeoutMs: number }
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(3 * limits.imageTimeoutMs)
    expect(opts.timeoutMs).toBeLessThan(limits.jobTimeoutMs)
  })
})
