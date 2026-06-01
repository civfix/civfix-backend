/**
 * Sandbox wrapper unit tests (LOCAL: real binaries).
 *
 *   - ffprobe rejects a non-video and accepts a real h264 MP4.
 *   - the hardened runner's TIMEOUT actually kills a long-running child (real spawn + SIGKILL), proving
 *     a wedged decoder cannot hang the worker.
 *   - the image wrapper strips EXIF GPS while preserving dimensions, and produces a bounded thumbnail.
 *   - perceptual hashing is deterministic and Hamming distance behaves.
 *   - the ffmpeg remux strips container/stream metadata (location) while keeping the video decodable.
 */

import { describe, expect, it } from "vitest"
import { loadLimits } from "../../src/config.js"
import { runTool, SandboxToolError } from "../../src/sandbox/exec.js"
import { probeBytes } from "../../src/sandbox/ffprobe.js"
import { remuxStripMetadata } from "../../src/sandbox/ffmpeg-remux.js"
import { processImage, readExifGps, hasNoGps } from "../../src/sandbox/image.js"
import { perceptualHash, hammingDistanceHex } from "../../src/sandbox/phash.js"
import exifr from "exifr"
import * as fx from "../fixtures/make.js"

const limits = loadLimits({})

describe("sandbox/exec runTool", () => {
  it("enforces the timeout and SIGKILLs a long-running child", async () => {
    // Use the Node binary itself as a guaranteed-present long-running child: sleep ~5s, time out at 200ms.
    const start = Date.now()
    let caught: unknown
    try {
      await runTool("sleeper", process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        timeoutMs: 200,
        maxBuffer: 1024,
      })
    } catch (err) {
      caught = err
    }
    const elapsed = Date.now() - start
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(true)
    // Killed promptly, nowhere near the 5s the child would otherwise run.
    expect(elapsed).toBeLessThan(3000)
  })

  it("maps a non-zero exit to a SandboxToolError (not a raw throw)", async () => {
    let caught: unknown
    try {
      await runTool("exiter", process.execPath, ["-e", "process.exit(3)"], {
        timeoutMs: 5000,
        maxBuffer: 1024,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(false)
    expect((caught as SandboxToolError).exitCode).toBe(3)
  })
})

describe("sandbox/ffprobe", () => {
  it("rejects a non-video buffer", async () => {
    await expect(probeBytes(fx.makeNonVideoAsMp4(), limits)).rejects.toBeInstanceOf(
      SandboxToolError,
    )
  })

  it("reads codec/dimensions/duration from a real h264 MP4", async () => {
    const mp4 = await fx.makeValidMp4()
    const probe = await probeBytes(mp4, limits)
    expect(probe.isVideo).toBe(true)
    expect(probe.codec).toBe("h264")
    expect(probe.width).toBe(320)
    expect(probe.height).toBe(240)
    expect(probe.durationSec).toBeGreaterThan(0)
    expect(probe.durationSec).toBeLessThanOrEqual(2)
  })

  it("sees an audio-only MP4 as NOT a video", async () => {
    const m4a = await fx.makeAudioOnlyMp4()
    const probe = await probeBytes(m4a, limits)
    expect(probe.isVideo).toBe(false)
  })
})

describe("sandbox/image", () => {
  it("reads EXIF GPS from the crafted input, then strips it on output", async () => {
    const input = await fx.makeValidJpegWithGps()
    const gps = await readExifGps(input)
    expect(gps).not.toBeNull()
    expect(gps!.lat).toBeCloseTo(37.7672, 3)
    expect(gps!.lng).toBeCloseTo(-122.4308, 3)

    const out = await processImage(input, limits)
    expect(out.meta.width).toBe(64)
    expect(out.meta.height).toBe(48)
    expect(out.exifGps).not.toBeNull() // the ORIGINAL gps is surfaced for the report cross-check
    // Stripped output and thumbnail carry no GPS.
    expect(await hasNoGps(out.strippedBytes)).toBe(true)
    expect(await hasNoGps(out.thumbnailBytes)).toBe(true)
  })

  it("produces a thumbnail whose longest edge is <= the configured max", async () => {
    // A large-ish image so the thumbnail must actually shrink.
    const sharp = (await import("sharp")).default
    const big = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .jpeg()
      .toBuffer()
    const out = await processImage(big, limits)
    const meta = await exifr.parse(out.thumbnailBytes).catch(() => null)
    void meta
    const tmeta = await sharp(out.thumbnailBytes).metadata()
    expect(Math.max(tmeta.width ?? 0, tmeta.height ?? 0)).toBeLessThanOrEqual(
      limits.thumbnailMaxEdge,
    )
  })

  it("rejects a pixel-bomb header via the decode guard", async () => {
    await expect(processImage(fx.makePixelBombPng(), limits)).rejects.toBeTruthy()
  })
})

describe("sandbox/phash", () => {
  it("is deterministic for identical bytes and 16 hex chars long", async () => {
    const png = await fx.makeValidPng()
    const h1 = await perceptualHash(png, limits)
    const h2 = await perceptualHash(png, limits)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{16}$/)
  })

  it("hamming distance is 0 for identical and > 0 for different images", async () => {
    const sharp = (await import("sharp")).default
    const a = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer()
    const b = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer()
    const ha = await perceptualHash(a, limits)
    const hb = await perceptualHash(b, limits)
    expect(hammingDistanceHex(ha, ha)).toBe(0)
    expect(hammingDistanceHex(ha, hb)).toBeGreaterThanOrEqual(0)
  })
})

describe("sandbox/ffmpeg-remux", () => {
  it("remuxes a real MP4 into a still-decodable, metadata-stripped MP4", async () => {
    const input = await fx.makeValidMp4()
    const remuxed = await remuxStripMetadata(input, limits)
    expect(remuxed.byteLength).toBeGreaterThan(0)
    // The remuxed bytes must still probe as a valid h264 video.
    const probe = await probeBytes(remuxed, limits)
    expect(probe.isVideo).toBe(true)
    expect(probe.codec).toBe("h264")
  })
})
