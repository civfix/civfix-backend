import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const lane = vi.hoisted(() => ({ impl: null as null | ((...args: unknown[]) => unknown) }))
const video = vi.hoisted(() => ({
  probe: null as null | ((...args: unknown[]) => unknown),
  remux: null as null | ((...args: unknown[]) => unknown),
  grab: null as null | ((...args: unknown[]) => unknown),
}))

vi.mock("../../src/sandbox/image-lane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/image-lane.js")>()
  return {
    ...actual,
    processImageLane: (...args: Parameters<typeof actual.processImageLane>) =>
      lane.impl ? lane.impl(...args) : actual.processImageLane(...args),
  }
})

vi.mock("../../src/sandbox/ffprobe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/ffprobe.js")>()
  return {
    ...actual,
    probeBytes: (...args: Parameters<typeof actual.probeBytes>) =>
      video.probe ? video.probe(...args) : actual.probeBytes(...args),
  }
})

vi.mock("../../src/sandbox/ffmpeg-remux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/ffmpeg-remux.js")>()
  return {
    ...actual,
    remuxStripMetadata: (...args: Parameters<typeof actual.remuxStripMetadata>) =>
      video.remux ? video.remux(...args) : actual.remuxStripMetadata(...args),
    grabFrameJpeg: (...args: Parameters<typeof actual.grabFrameJpeg>) =>
      video.grab ? video.grab(...args) : actual.grabFrameJpeg(...args),
  }
})

const { FakeStorage, FakeAbuseChecks } = await import("@civfix/shared/fakes")
const { loadLimits } = await import("../../src/config.js")
const { resetSandboxIdentity, SandboxSpawnError } = await import("../../src/sandbox/exec.js")
const { makeScratch, ScratchSetupError } = await import("../../src/sandbox/tmp.js")
const { mediaToolPath, resetMediaToolPaths } = await import("../../src/sandbox/binaries.js")
const { processMedia } = await import("../../src/jobs/media-pipeline.js")
const { runMediaChecksJob, MediaInfraError } = await import("../../src/jobs/media-checks.js")
const { InMemoryMediaWorkerRepository } =
  await import("../helpers/in-memory-media-worker-repository.js")
const { makeDownloader } = await import("../../src/download.js")
const fx = await import("../fixtures/make.js")

const limits = loadLimits({})

const VALID_PROBE = {
  durationSec: 2,
  codec: "h264",
  width: 640,
  height: 360,
  fps: 30,
  bitrateBps: 1_000_000,
  isVideo: true,
}

let saved: NodeJS.ProcessEnv
let root: string

beforeEach(async () => {
  saved = { ...process.env }
  root = await mkdtemp(join(tmpdir(), "civfix-scratch-infra-"))
  lane.impl = null
  video.probe = null
  video.remux = null
  video.grab = null
  resetSandboxIdentity()
  resetMediaToolPaths()
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  resetSandboxIdentity()
  resetMediaToolPaths()
  await rm(root, { recursive: true, force: true })
})

function breakScratchRoot(): void {
  process.env.TMPDIR = join(root, "does-not-exist")
}

function withSandboxIdentity(): void {
  process.env.MEDIA_SANDBOX_UID = String(process.getuid?.() ?? 1001)
  process.env.MEDIA_SANDBOX_GID = String(process.getgid?.() ?? 1001)
  process.env.MEDIA_IMAGE_LANE_ENTRY = fileURLToPath(import.meta.url)
  resetSandboxIdentity()
}

function scratchInfraError(): Error {
  return new ScratchSetupError(
    "could not prepare the sandbox scratch dir",
    Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
      syscall: "write",
    }),
  )
}

const deps = () => ({ abuseChecks: new FakeAbuseChecks(), limits })

describe("scratch setup failures are infrastructure, not a verdict on the bytes", () => {
  it("makeScratch reports an unusable scratch root as ScratchSetupError", async () => {
    breakScratchRoot()

    const err = await makeScratch(new Uint8Array([1]), "bin").catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ScratchSetupError)
    expect(String(err)).toMatch(/ENOENT/)
  })

  it("an image whose sandbox scratch cannot be created escapes processMedia instead of being rejected", async () => {
    withSandboxIdentity()
    breakScratchRoot()

    await expect(
      processMedia({ bytes: await fx.makeValidPng(), kind: "image" }, deps()),
    ).rejects.toBeInstanceOf(ScratchSetupError)
  })

  it("a video whose probe scratch cannot be created escapes processMedia instead of being rejected", async () => {
    breakScratchRoot()

    await expect(
      processMedia({ bytes: Buffer.from("not inspected"), kind: "video" }, deps()),
    ).rejects.toBeInstanceOf(ScratchSetupError)
  })

  it("a scratch failure in the remux step escapes instead of rejecting the video", async () => {
    video.probe = () => Promise.resolve(VALID_PROBE)
    video.remux = () => Promise.reject(scratchInfraError())

    await expect(
      processMedia({ bytes: Buffer.from("video"), kind: "video" }, deps()),
    ).rejects.toBeInstanceOf(ScratchSetupError)
  })

  it("a scratch failure in the frame grab escapes instead of holding the video as unscorable", async () => {
    video.probe = () => Promise.resolve(VALID_PROBE)
    video.remux = () => Promise.resolve(Buffer.from("remuxed"))
    video.grab = () => Promise.reject(scratchInfraError())

    await expect(
      processMedia({ bytes: Buffer.from("video"), kind: "video" }, deps()),
    ).rejects.toBeInstanceOf(ScratchSetupError)
  })

  it("a scratch failure in the video thumbnail lane escapes instead of dropping the thumbnail", async () => {
    video.probe = () => Promise.resolve(VALID_PROBE)
    video.remux = () => Promise.resolve(Buffer.from("remuxed"))
    video.grab = () => Promise.resolve(Buffer.from("frame"))
    lane.impl = () => Promise.reject(scratchInfraError())

    await expect(
      processMedia({ bytes: Buffer.from("video"), kind: "video" }, deps()),
    ).rejects.toBeInstanceOf(ScratchSetupError)
  })

  it("a media tool that cannot be resolved is a spawn failure, not a rejection", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.FFPROBE_PATH
    delete process.env.FFMPEG_PATH

    await expect(mediaToolPath("ffprobe")).rejects.toBeInstanceOf(SandboxSpawnError)
  })

  it("media.checks retries a scratch failure and keeps the asset validating with its upload intact", async () => {
    lane.impl = () => Promise.reject(scratchInfraError())
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    const r2Key = "uploads/2026/09/scratch"
    repo.seed({ id: "m1", uploadId: "u1", kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(await fx.makeValidPng()), { contentType: "image/png" })

    await expect(
      runMediaChecksJob(
        { mediaId: "m1", uploadId: "u1", r2Key, kind: "image" },
        {
          repo,
          storage,
          abuseChecks: new FakeAbuseChecks(),
          limits,
          download: makeDownloader(storage),
          report: () => {},
          log: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(MediaInfraError)

    expect(repo.get("m1")!.status).toBe("validating")
    expect(storage.get(r2Key)).not.toBeNull()
  })
})
