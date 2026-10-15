import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadLimits } from "../../src/config.js"

const spawned = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  calls: [] as { args: readonly string[]; opts: { lowPriority?: boolean; timeoutMs: number } }[],
  failNext: false,
}))

vi.mock("../../src/sandbox/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/exec.js")>()
  return {
    ...actual,
    sandboxIdentity: () => null,
    runTool: async (
      name: string,
      _bin: string,
      args: readonly string[],
      opts: { lowPriority?: boolean; timeoutMs: number; cwd?: string },
    ) => {
      spawned.calls.push({ args, opts })
      spawned.active++
      spawned.maxActive = Math.max(spawned.maxActive, spawned.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 30))
        if (spawned.failNext) {
          spawned.failNext = false
          throw new actual.SandboxToolError(name, {
            timedOut: true,
            exitCode: null,
            stderrTail: "",
          })
        }
        await writeFile(join(opts.cwd ?? "", "out.mp4"), Buffer.from([1]))
        return { stdout: "", stderr: "", stdoutBuffer: Buffer.alloc(0), exitCode: 0 }
      } finally {
        spawned.active--
      }
    },
  }
})

vi.mock("../../src/sandbox/binaries.js", () => ({
  mediaToolPath: () => Promise.resolve("/opt/ffmpeg"),
}))

const { transcodeToServedMp4 } = await import("../../src/sandbox/ffmpeg-transcode.js")

const limits = { ...loadLimits({}), transcodeThreads: 1 }
const CLIP = new Uint8Array([0, 1, 2])

describe("transcode resource limits", () => {
  it("runs one transcode at a time; the rest wait their turn, even behind a failure", async () => {
    spawned.failNext = true

    const results = await Promise.allSettled([
      transcodeToServedMp4(CLIP, { capFps: false }, limits),
      transcodeToServedMp4(CLIP, { capFps: false }, limits),
      transcodeToServedMp4(CLIP, { capFps: true }, limits),
    ])

    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"])
    expect(spawned.maxActive).toBe(1)
  })

  it("encodes at low priority, with bounded threads and the transcode timeout", async () => {
    await transcodeToServedMp4(CLIP, { capFps: false }, limits)

    const { args, opts } = spawned.calls.at(-1)!

    expect(opts).toMatchObject({ lowPriority: true, timeoutMs: limits.transcodeTimeoutMs })
    const threadValues = args.flatMap((a, i) => (a === "-threads" ? [args[i + 1]] : []))
    expect(threadValues).toEqual(["1", "1"])
    expect(args).toContain("-filter_threads")
    expect(args.join(" ")).toMatch(/-c:a copy/)
  })
})
