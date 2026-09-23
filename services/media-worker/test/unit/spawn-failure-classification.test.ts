import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileURLToPath } from "node:url"

const processImageLaneMock = vi.fn()

vi.mock("../../src/sandbox/image-lane.js", () => ({
  processImageLane: (...args: unknown[]) => processImageLaneMock(...args),
  imageLaneEntry: () => fileURLToPath(import.meta.url),
}))

const { FakeStorage, FakeAbuseChecks } = await import("@civfix/shared/fakes")
const { loadLimits } = await import("../../src/config.js")
const { SandboxSpawnError, SandboxToolError, resetSandboxIdentity } =
  await import("../../src/sandbox/exec.js")
const { processMedia } = await import("../../src/jobs/media-pipeline.js")
const { runMediaChecksJob, MediaInfraError } = await import("../../src/jobs/media-checks.js")
const { assertSandboxPreflight } = await import("../../src/sandbox/preflight.js")
const { InMemoryWorkerRepo } = await import("../helpers/in-memory-repo.js")
const { makeDownloader } = await import("../../src/download.js")
const fx = await import("../fixtures/make.js")

const limits = loadLimits({})

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  processImageLaneMock.mockReset()
  resetSandboxIdentity()
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  resetSandboxIdentity()
})

describe("processMedia classification", () => {
  it("lets a spawn-level failure escape (it is not a verdict on the bytes)", async () => {
    processImageLaneMock.mockRejectedValue(new SandboxSpawnError("image-lane", new Error("ENOENT")))

    await expect(
      processMedia(
        { bytes: await fx.makeValidPng(), kind: "image" },
        { abuseChecks: new FakeAbuseChecks(), limits },
      ),
    ).rejects.toBeInstanceOf(SandboxSpawnError)
  })

  it("maps a SIGNAL-killed lane to rejected (an input-driven crash must never retry)", async () => {
    processImageLaneMock.mockRejectedValue(
      new SandboxToolError("image-lane", {
        timedOut: false,
        exitCode: null,
        signal: "SIGSEGV",
        stderrTail: "",
      }),
    )

    const res = await processMedia(
      { bytes: await fx.makeValidPng(), kind: "image" },
      { abuseChecks: new FakeAbuseChecks(), limits },
    )

    expect(res.status).toBe("rejected")
    expect(res.note).toContain("SIGSEGV")
  })

  it("still maps a child-level failure to rejected", async () => {
    processImageLaneMock.mockRejectedValue(
      new SandboxToolError("image-lane", { timedOut: false, exitCode: 1, stderrTail: "bad" }),
    )

    const res = await processMedia(
      { bytes: await fx.makeValidPng(), kind: "image" },
      { abuseChecks: new FakeAbuseChecks(), limits },
    )

    expect(res.status).toBe("rejected")
  })
})

describe("media.checks classification", () => {
  it("REJECTS (does not retry) when the lane child was killed by a signal", async () => {
    processImageLaneMock.mockRejectedValue(
      new SandboxToolError("image-lane", {
        timedOut: false,
        exitCode: null,
        signal: "SIGSEGV",
        stderrTail: "",
      }),
    )
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const r2Key = "uploads/2026/09/segv"
    repo.seed({ id: "m2", uploadId: "u2", kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(await fx.makeValidPng()), { contentType: "image/png" })

    const status = await runMediaChecksJob(
      { mediaId: "m2", uploadId: "u2", r2Key, kind: "image" },
      {
        repo,
        storage,
        abuseChecks: new FakeAbuseChecks(),
        limits,
        download: makeDownloader(storage),
        report: () => {},
        log: () => {},
      },
    )

    expect(status).toBe("rejected")
    expect(repo.get("m2")!.status).toBe("rejected")
  })

  it("turns a spawn-level failure into MediaInfraError, leaving the asset validating and its bytes intact", async () => {
    processImageLaneMock.mockRejectedValue(new SandboxSpawnError("image-lane", new Error("EACCES")))
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const r2Key = "uploads/2026/09/spawn"
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

describe("preflight refuses a boot whose image lane does not work", () => {
  const prodEnv = {
    NODE_ENV: "production",
    FFMPEG_PATH: "/bin/sh",
    FFPROBE_PATH: "/bin/sh",
    MEDIA_SANDBOX_UID: String(process.getuid?.() ?? 1001),
    MEDIA_SANDBOX_GID: String(process.getgid?.() ?? 1001),
    MEDIA_IMAGE_LANE_ENTRY: fileURLToPath(import.meta.url),
  } as NodeJS.ProcessEnv

  it("throws when the lane cannot process the built-in 1x1 PNG", async () => {
    processImageLaneMock.mockRejectedValue(new SandboxSpawnError("image-lane", new Error("ENOENT")))

    await expect(assertSandboxPreflight(prodEnv, () => {})).rejects.toThrow(/image lane/)
  })

  it("throws when the lane returns empty output", async () => {
    processImageLaneMock.mockResolvedValue({
      meta: { width: 1, height: 1, format: "png" },
      strippedBytes: Buffer.alloc(0),
      strippedContentType: "image/png",
      thumbnailBytes: Buffer.alloc(0),
      thumbnailContentType: "image/jpeg",
      exifGps: null,
      phash: null,
    })

    await expect(assertSandboxPreflight(prodEnv, () => {})).rejects.toThrow(/empty output/)
  })
})
