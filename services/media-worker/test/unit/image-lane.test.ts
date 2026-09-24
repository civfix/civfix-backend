import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
const { processImageLane, imageLaneEntry } = await import("../../src/sandbox/image-lane.js")
const laneMain = await import("../../src/sandbox/image-lane-main.js")
const { SandboxToolError, SandboxSpawnError } = await import("../../src/sandbox/exec.js")
const fx = await import("../fixtures/make.js")

const limits = loadLimits({})

function envelope(over: Record<string, unknown>) {
  return {
    stdout: JSON.stringify({
      ok: true,
      meta: { width: 10, height: 20, format: "png" },
      strippedContentType: "image/png",
      thumbnailContentType: "image/jpeg",
      exifGps: null,
      phash: "abcdef0123456789",
      ...over,
    }),
    stderr: "",
    stdoutBuffer: Buffer.alloc(0),
    exitCode: 0,
  }
}

function childReturning(over: Record<string, unknown>) {
  return async (_name: string, _bin: string, args: string[]) => {
    const req = JSON.parse(args[2] as string) as { outDir: string }
    await writeFile(join(req.outDir, "stripped.bin"), Buffer.from([1, 2]))
    await writeFile(join(req.outDir, "thumb.bin"), Buffer.from([3]))
    return envelope(over)
  }
}

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  runToolMock.mockReset()
  resetSandboxIdentity()
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  resetSandboxIdentity()
})

function withSandboxIdentity(): void {
  process.env.MEDIA_SANDBOX_UID = String(process.getuid?.() ?? 1001)
  process.env.MEDIA_SANDBOX_GID = String(process.getgid?.() ?? 1001)
  process.env.MEDIA_IMAGE_LANE_ENTRY = fileURLToPath(import.meta.url)
  resetSandboxIdentity()
}

describe("image-lane child protocol", () => {
  it("round-trips a real image: writes both outputs and returns meta + phash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "civfix-lane-test-"))
    try {
      const inputPath = join(dir, "input.bin")
      await writeFile(inputPath, await fx.makeValidJpegWithGps())

      const res = await laneMain.runImageLane({ inputPath, outDir: dir, limits })

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.meta.width).toBe(64)
      expect(res.meta.height).toBe(48)
      expect(typeof res.phash).toBe("string")
      expect(res.exifGps?.lat).toBeCloseTo(37.7672, 3)
      expect((await readFile(join(dir, laneMain.STRIPPED_FILE))).byteLength).toBeGreaterThan(0)
      expect((await readFile(join(dir, laneMain.THUMB_FILE))).byteLength).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns a failure envelope (not a throw) for undecodable bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "civfix-lane-test-"))
    try {
      const inputPath = join(dir, "input.bin")
      await writeFile(inputPath, fx.makeGarbageImage())

      const res = await laneMain.runImageLane({ inputPath, outDir: dir, limits })

      expect(res.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects a malformed request", () => {
    expect(() => laneMain.parseRequest(undefined)).toThrow(/missing request/)
    expect(() => laneMain.parseRequest("{}")).toThrow(/inputPath/)
    expect(() => laneMain.parseRequest(JSON.stringify({ inputPath: "a", outDir: "b" }))).toThrow(
      /limits/,
    )
  })

  it("main() exits non-zero on a bad request and 0 on a good one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "civfix-lane-test-"))
    try {
      const inputPath = join(dir, "input.bin")
      await writeFile(inputPath, await fx.makeValidPng())
      const written: string[] = []
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
        written.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

      const okCode = await laneMain.main([
        "node",
        "image-lane.js",
        laneMain.RUN_FLAG,
        JSON.stringify({ inputPath, outDir: dir, limits }),
      ])
      const badCode = await laneMain.main(["node", "image-lane.js", laneMain.RUN_FLAG])

      spy.mockRestore()
      errSpy.mockRestore()
      expect(okCode).toBe(0)
      expect(badCode).toBe(1)
      expect(JSON.parse(written.join(""))).toMatchObject({ ok: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("image-lane parent", () => {
  it("runs in-process when no sandbox identity is configured (dev/darwin)", async () => {
    delete process.env.MEDIA_SANDBOX_UID
    delete process.env.MEDIA_SANDBOX_GID
    resetSandboxIdentity()

    const out = await processImageLane(await fx.makeValidPng(), limits)

    expect(runToolMock).not.toHaveBeenCalled()
    expect(out.meta.width).toBeGreaterThan(0)
    expect(out.strippedBytes.byteLength).toBeGreaterThan(0)
  })

  it("spawns node with the image-lane entry when a sandbox identity IS configured", async () => {
    withSandboxIdentity()
    runToolMock.mockImplementation(childReturning({}))

    const out = await processImageLane(await fx.makeValidPng(), limits)

    expect(runToolMock).toHaveBeenCalledTimes(1)
    const [name, binary, args] = runToolMock.mock.calls[0] as [string, string, string[]]
    expect(name).toBe("image-lane")
    expect(binary).toBe(process.execPath)
    expect(args[0]).toBe(imageLaneEntry())
    expect(args[1]).toBe(laneMain.RUN_FLAG)
    expect(out.meta).toEqual({ width: 10, height: 20, format: "png" })
    expect(out.phash).toBe("abcdef0123456789")
    expect(out.strippedBytes.byteLength).toBe(2)
  })

  it("maps a child failure envelope to a decode error (-> rejected asset)", async () => {
    withSandboxIdentity()
    runToolMock.mockResolvedValue({
      stdout: JSON.stringify({ ok: false, error: "unsupported image container" }),
      stderr: "",
      stdoutBuffer: Buffer.alloc(0),
      exitCode: 0,
    })

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /unsupported image container/,
    )
  })

  it("maps unparseable child output to a decode error", async () => {
    withSandboxIdentity()
    runToolMock.mockResolvedValue({
      stdout: "not json",
      stderr: "",
      stdoutBuffer: Buffer.alloc(0),
      exitCode: 0,
    })

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /no parseable result/,
    )
  })

  it("maps a non-zero child exit to a decode error (-> rejected, not a retry)", async () => {
    withSandboxIdentity()
    runToolMock.mockRejectedValue(
      new SandboxToolError("image-lane", { timedOut: false, exitCode: 1, stderrTail: "boom" }),
    )

    const err = await processImageLane(await fx.makeValidPng(), limits).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
  })

  it("B3'': lets a SPAWN-level failure propagate (infra, retried; never a rejected upload)", async () => {
    withSandboxIdentity()
    runToolMock.mockRejectedValue(new SandboxSpawnError("image-lane", new Error("ENOENT")))

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toBeInstanceOf(
      SandboxSpawnError,
    )
  })
})

describe("B3': the parent trusts nothing the child says", () => {
  it("refuses an envelope that tries to name its own output paths", async () => {
    withSandboxIdentity()
    runToolMock.mockImplementation(
      childReturning({
        strippedFile: "../../../proc/self/environ",
        thumbFile: "../../etc/hostname",
      }),
    )

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /invalid result/,
    )
  })

  it("reads the two FIXED names inside the scratch dir it created", async () => {
    withSandboxIdentity()
    runToolMock.mockImplementation(childReturning({}))

    const out = await processImageLane(await fx.makeValidPng(), limits)

    expect(out.strippedBytes.byteLength).toBe(2)
    expect(out.thumbnailBytes.byteLength).toBe(1)
  })

  it("refuses a content type outside the image output allowlist", async () => {
    withSandboxIdentity()
    runToolMock.mockImplementation(childReturning({ strippedContentType: "text/html" }))

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /invalid result/,
    )
  })

  it("refuses NaN / non-positive / over-budget dimensions", async () => {
    withSandboxIdentity()
    for (const meta of [
      { width: Number.NaN, height: 20, format: "png" },
      { width: 0, height: 20, format: "png" },
      { width: 10, height: -1, format: "png" },
      { width: limits.maxImagePixels + 1, height: 1, format: "png" },
      { width: 10, height: 20, format: "svg" },
    ]) {
      runToolMock.mockImplementation(childReturning({ meta }))
      await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
        /invalid result/,
      )
    }
  })

  it("refuses a malformed phash or a non-finite exifGps", async () => {
    withSandboxIdentity()
    runToolMock.mockImplementation(childReturning({ phash: "not-a-hash" }))
    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /invalid result/,
    )

    runToolMock.mockImplementation(childReturning({ exifGps: { lat: "37", lng: 1 } }))
    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /invalid result/,
    )
  })

  it("refuses a SYMLINK at the fixed name (it never resolves the path twice)", async () => {
    withSandboxIdentity()
    runToolMock.mockImplementation(async (_name, _bin, args: string[]) => {
      const req = JSON.parse(args[2] as string) as { outDir: string }
      await symlink("/etc/hostname", join(req.outDir, "stripped.bin"))
      await writeFile(join(req.outDir, "thumb.bin"), Buffer.from([3]))
      return envelope({})
    })

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /could not be opened safely/,
    )
  })

  it("refuses a HARDLINK to a file outside the scratch dir", async () => {
    withSandboxIdentity()
    const outside = join(tmpdir(), `civfix-lane-outside-${Date.now()}`)
    await writeFile(outside, Buffer.from("secret"))
    runToolMock.mockImplementation(async (_name, _bin, args: string[]) => {
      const req = JSON.parse(args[2] as string) as { outDir: string }
      await link(outside, join(req.outDir, "stripped.bin"))
      await writeFile(join(req.outDir, "thumb.bin"), Buffer.from([3]))
      return envelope({})
    })

    try {
      await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(/hard-linked/)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it("refuses when the child wrote no output at all", async () => {
    withSandboxIdentity()
    runToolMock.mockResolvedValue(envelope({}))

    await expect(processImageLane(await fx.makeValidPng(), limits)).rejects.toThrow(
      /could not be opened safely/,
    )
  })
})
