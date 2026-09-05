
import { describe, expect, it, vi } from "vitest"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import { loadLimits, type WorkerLimits } from "../../src/config.js"

type StubProbe = {
  durationSec: number
  codec: string
  width: number | null
  height: number | null
  fps: number | null
  bitrateBps: number | null
  isVideo: boolean
}

const stub = vi.hoisted(() => ({
  probe: {
    durationSec: 10,
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateBps: 4_000_000,
    isVideo: true,
  } as StubProbe,
  remuxCalls: 0,
  frameCalls: 0,
}))

vi.mock("../../src/sandbox/ffprobe.js", () => ({
  probeBytes: () => Promise.resolve(stub.probe),
}))

vi.mock("../../src/sandbox/ffmpeg-remux.js", () => ({
  remuxStripMetadata: () => {
    stub.remuxCalls++
    return Promise.resolve(Buffer.from([0]))
  },
  grabFrameJpeg: () => {
    stub.frameCalls++
    return Promise.reject(new Error("no frame in this test"))
  },
}))

const { processMedia } = await import("../../src/jobs/media-pipeline.js")

const limits: WorkerLimits = loadLimits({})
const deps = { abuseChecks: new FakeAbuseChecks(), limits }
const BYTES = new Uint8Array([1, 2, 3, 4])

function withProbe(over: Partial<StubProbe>) {
  stub.probe = { ...stub.probe, ...over }
  stub.remuxCalls = 0
  stub.frameCalls = 0
}

async function run() {
  return processMedia({ bytes: BYTES, kind: "video" }, deps)
}

describe("video size caps reject BEFORE any decode", () => {
  it("rejects a resolution over MEDIA_VIDEO_MAX_PIXELS without remuxing or grabbing a frame", async () => {
    withProbe({ width: 8192, height: 8192 })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toMatch(/8192x8192.*exceeds the cap/)
    expect(stub.remuxCalls).toBe(0)
    expect(stub.frameCalls).toBe(0)
  })

  it("rejects an absent or zero resolution (an un-evaluatable cap is not a cap)", async () => {
    withProbe({ width: null, height: null })
    expect((await run()).note).toMatch(/no usable resolution/)

    withProbe({ width: 0, height: 0 })
    expect((await run()).note).toMatch(/no usable resolution/)
    expect(stub.remuxCalls).toBe(0)
  })

  it("rejects a frame rate over MEDIA_VIDEO_MAX_FPS", async () => {
    withProbe({ width: 1280, height: 720, fps: limits.maxVideoFps + 1 })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toMatch(/frame rate/)
    expect(stub.remuxCalls).toBe(0)
  })

  it("rejects a bitrate over MEDIA_VIDEO_MAX_BITRATE", async () => {
    withProbe({ width: 1280, height: 720, fps: 30, bitrateBps: limits.maxVideoBitrateBps + 1 })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toMatch(/bitrate/)
    expect(stub.remuxCalls).toBe(0)
  })

  it("proceeds at exactly the pixel cap (4K), and with unknown fps/bitrate", async () => {
    withProbe({ width: 3840, height: 2160, fps: null, bitrateBps: null })

    const result = await run()

    expect(result.status).not.toBe("rejected")
    expect(stub.remuxCalls).toBe(1)
    expect(stub.frameCalls).toBe(1)
    expect(result.width).toBe(3840)
    expect(result.height).toBe(2160)
  })

  it("never throws on any of these paths (the pipeline invariant)", async () => {
    withProbe({ width: 99999, height: 99999 })
    await expect(run()).resolves.toMatchObject({ status: "rejected" })
  })
})
