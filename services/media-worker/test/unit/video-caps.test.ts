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
  pixFmt: string | null
  profile: string | null
  isVideo: boolean
}

const stub = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the assertion is the field's declared type: vi.hoisted infers the record from this literal
  probe: {
    durationSec: 10,
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateBps: 4_000_000,
    pixFmt: "yuv420p",
    profile: "High",
    isVideo: true,
  } as StubProbe,
  servedProbe: {
    durationSec: 10,
    codec: "h264",
    width: 1280,
    height: 720,
    fps: 30,
    bitrateBps: 2_000_000,
    pixFmt: "yuv420p",
    profile: "High",
    isVideo: true,
  },
  remuxCalls: 0,
  frameCalls: 0,
  transcodes: [] as { capFps: boolean }[],
  transcodeError: null as Error | null,
}))

const TRANSCODED = Buffer.from([9, 9])

vi.mock("../../src/sandbox/ffprobe.js", () => ({
  probeBytes: (bytes: Uint8Array) =>
    Promise.resolve(Buffer.from(bytes).equals(TRANSCODED) ? stub.servedProbe : stub.probe),
}))

vi.mock("../../src/sandbox/ffmpeg-transcode.js", () => ({
  transcodeToServedMp4: (_bytes: Uint8Array, opts: { capFps: boolean }) => {
    stub.transcodes.push(opts)
    return stub.transcodeError ? Promise.reject(stub.transcodeError) : Promise.resolve(TRANSCODED)
  },
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

const { processMedia, servedVideoPlan } = await import("../../src/jobs/media-pipeline.js")
const { SandboxSpawnError, SandboxToolError } = await import("../../src/sandbox/exec.js")

const limits: WorkerLimits = loadLimits({})
const deps = { abuseChecks: new FakeAbuseChecks(), limits }
const BYTES = new Uint8Array([1, 2, 3, 4])

const BASE_PROBE: StubProbe = { ...stub.probe }

function withProbe(over: Partial<StubProbe>) {
  stub.probe = { ...BASE_PROBE, ...over }
  stub.remuxCalls = 0
  stub.frameCalls = 0
  stub.transcodes = []
  stub.transcodeError = null
}

async function run() {
  return processMedia({ bytes: BYTES, kind: "video" }, deps)
}

describe("video size caps reject BEFORE any decode", () => {
  it("defaults to what the mobile app records: 10s, 1080p either way, 60fps, 20Mbps", () => {
    expect(limits).toMatchObject({
      maxVideoDurationSec: 10,
      maxVideoEdge: 1920,
      maxVideoPixels: 1920 * 1080,
      maxVideoFps: 60,
      maxVideoBitrateBps: 20_000_000,
    })
  })

  it("rejects a resolution over MEDIA_VIDEO_MAX_EDGE without remuxing or grabbing a frame", async () => {
    withProbe({ width: 8192, height: 8192 })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toMatch(/8192x8192 exceeds the long-edge cap of 1920px/)
    expect(stub.remuxCalls).toBe(0)
    expect(stub.frameCalls).toBe(0)
    expect(stub.transcodes).toEqual([])
  })

  it.each([
    [3840, 2160],
    [2160, 3840],
    [2560, 720],
  ])("rejects %ix%i on its long edge", async (width, height) => {
    withProbe({ width, height })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toBe(`resolution ${width}x${height} exceeds the long-edge cap of 1920px`)
    expect(stub.transcodes).toEqual([])
  })

  it("rejects 1920x1440: within the long edge, over the 1080p pixel cap", async () => {
    withProbe({ width: 1920, height: 1440 })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toBe("resolution 1920x1440 (2764800px) exceeds the cap of 2073600px")
  })

  it.each([
    [10.04, "ready"],
    [10.6, "rejected"],
  ])("compares a %ss clip to the 10s cap by its nominal length", async (durationSec, status) => {
    withProbe({ width: 1280, height: 720, fps: 30, durationSec })

    const result = await run()

    expect(result.status === "rejected" ? "rejected" : "ready").toBe(status)
    if (status === "rejected") {
      expect(result.note).toBe(`duration ${durationSec}s exceeds the cap of 10s`)
    }
  })

  it("rejects a non-positive duration", async () => {
    withProbe({ width: 1280, height: 720, fps: 30, durationSec: 0 })

    expect((await run()).note).toBe("duration 0s is not positive")
  })

  it("rejects an absent or zero resolution (an un-evaluatable cap is not a cap)", async () => {
    withProbe({ width: null, height: null })
    expect((await run()).note).toMatch(/no usable resolution/)

    withProbe({ width: 0, height: 0 })
    expect((await run()).note).toMatch(/no usable resolution/)
    expect(stub.remuxCalls).toBe(0)
  })

  it.each([61, 120])("rejects %ifps, over MEDIA_VIDEO_MAX_FPS", async (fps) => {
    withProbe({ width: 1280, height: 720, fps })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toBe(`frame rate ${fps.toFixed(2)}fps exceeds the cap of 60fps`)
    expect(stub.remuxCalls).toBe(0)
  })

  it("accepts a 60fps clip whose average runs a hair over 60", async () => {
    withProbe({ width: 1280, height: 720, fps: 60.04 })

    expect((await run()).status).not.toBe("rejected")
  })

  it("rejects a bitrate over MEDIA_VIDEO_MAX_BITRATE", async () => {
    withProbe({ width: 1280, height: 720, fps: 30, bitrateBps: limits.maxVideoBitrateBps + 1 })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toMatch(/bitrate/)
    expect(stub.remuxCalls).toBe(0)
  })

  it.each([
    [1920, 1080],
    [1080, 1920],
  ])("proceeds at exactly %ix%i, and with unknown fps/bitrate", async (width, height) => {
    withProbe({ width, height, fps: null, bitrateBps: null })

    const result = await run()

    expect(result.status).not.toBe("rejected")
    expect(stub.transcodes).toEqual([{ capFps: true }])
    expect(stub.frameCalls).toBe(1)
  })

  it("proceeds at every cap at once: 10s 1080p60 at 20Mbps", async () => {
    withProbe({ width: 1920, height: 1080, fps: 60, durationSec: 10, bitrateBps: 20_000_000 })

    expect((await run()).status).not.toBe("rejected")
  })

  it("never throws on any of these paths (the pipeline invariant)", async () => {
    withProbe({ width: 99999, height: 99999 })
    await expect(run()).resolves.toMatchObject({ status: "rejected" })
  })
})

describe("served video: remux what is already within spec, transcode the rest", () => {
  const compliant = {
    codec: "h264",
    width: 1280,
    height: 720,
    fps: 30,
    bitrateBps: 3_000_000,
    pixFmt: "yuv420p",
    profile: "High",
  }

  it.each<[string, Partial<StubProbe>, ReturnType<typeof servedVideoPlan>]>([
    ["720p30 H.264 under the bitrate ceiling", {}, { transcode: false }],
    ["portrait 720x1280", { width: 720, height: 1280 }, { transcode: false }],
    [
      "exactly at the bitrate ceiling",
      { bitrateBps: limits.servedVideoMaxBitrateBps },
      { transcode: false },
    ],
    ["HEVC", { codec: "hevc" }, { transcode: true, capFps: false }],
    ["1080p", { width: 1920, height: 1080 }, { transcode: true, capFps: false }],
    ["60 fps", { fps: 60 }, { transcode: true, capFps: true }],
    [
      "over the bitrate ceiling",
      { bitrateBps: limits.servedVideoMaxBitrateBps + 1 },
      { transcode: true, capFps: false },
    ],
    ["an unknown bitrate", { bitrateBps: null }, { transcode: true, capFps: false }],
    ["an unknown frame rate", { fps: null }, { transcode: true, capFps: true }],
    ["full-range 4:2:0", { pixFmt: "yuvj420p" }, { transcode: false }],
    ["Main profile", { profile: "Main" }, { transcode: false }],
    ["Baseline profile", { profile: "Baseline" }, { transcode: false }],
    ["Constrained Baseline profile", { profile: "Constrained Baseline" }, { transcode: false }],
    [
      "High 4:4:4",
      { profile: "High 4:4:4 Predictive", pixFmt: "yuv444p" },
      { transcode: true, capFps: false },
    ],
    ["High 10", { profile: "High 10", pixFmt: "yuv420p10le" }, { transcode: true, capFps: false }],
    [
      "4:2:2 chroma",
      { profile: "High 4:2:2", pixFmt: "yuv422p" },
      { transcode: true, capFps: false },
    ],
    ["10-bit under a High label", { pixFmt: "yuv420p10le" }, { transcode: true, capFps: false }],
    ["the Extended profile", { profile: "Extended" }, { transcode: true, capFps: false }],
    ["an unknown pixel format", { pixFmt: null }, { transcode: true, capFps: false }],
    ["an unknown profile", { profile: null }, { transcode: true, capFps: false }],
  ])("%s", (_label, over, plan) => {
    expect(servedVideoPlan({ ...stub.probe, ...compliant, ...over }, limits)).toEqual(plan)
  })

  it("only remuxes a clip within spec", async () => {
    withProbe(compliant)

    const result = await run()

    expect(stub.remuxCalls).toBe(1)
    expect(stub.transcodes).toEqual([])
    expect(result).toMatchObject({
      codec: "h264",
      width: 1280,
      height: 720,
      processedContentType: "video/mp4",
    })
  })

  it("serves the transcode and records its dimensions and codec, not the upload's", async () => {
    withProbe({ codec: "hevc", width: 1920, height: 1080, fps: 60 })

    const result = await run()

    expect(stub.remuxCalls).toBe(0)
    expect(stub.transcodes).toEqual([{ capFps: true }])
    expect(result.processedBytes).toEqual(TRANSCODED)
    expect(result).toMatchObject({
      codec: "h264",
      width: 1280,
      height: 720,
      processedContentType: "video/mp4",
    })
  })

  it("rejects the asset when the transcode fails on its bytes", async () => {
    withProbe({ codec: "hevc" })
    stub.transcodeError = new SandboxToolError("ffmpeg", {
      timedOut: false,
      exitCode: 1,
      stderrTail: "",
    })

    const result = await run()

    expect(result.status).toBe("rejected")
    expect(result.note).toMatch(/^transcode failed/)
  })

  it("lets a transcode that could not even start escape as infra (retried, not rejected)", async () => {
    withProbe({ codec: "hevc" })
    stub.transcodeError = new SandboxSpawnError("ffmpeg", new Error("spawn ENOENT"))

    await expect(run()).rejects.toBeInstanceOf(SandboxSpawnError)
  })
})
