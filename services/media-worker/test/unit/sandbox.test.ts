import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import sharp from "sharp"
import { loadLimits, SERVED_IMAGE_JPEG_QUALITY } from "../../src/config.js"
import { runTool, SandboxToolError } from "../../src/sandbox/exec.js"
import { probeBytes } from "../../src/sandbox/ffprobe.js"
import { grabFrameJpeg, remuxStripMetadata } from "../../src/sandbox/ffmpeg-remux.js"
import { transcodeToServedMp4 } from "../../src/sandbox/ffmpeg-transcode.js"
import { servedVideoPlan } from "../../src/jobs/media-pipeline.js"
import {
  processImage,
  readExifGps,
  hasNoGps,
  sniffAllowedImageContainer,
} from "../../src/sandbox/image.js"
import { perceptualHash } from "../../src/sandbox/phash.js"
import { resetMediaToolPaths } from "../../src/sandbox/binaries.js"
import { assertVideoLaneRuns } from "../../src/sandbox/preflight.js"
import exifr from "exifr"
import * as fx from "../fixtures/make.js"
import { readContainerTags, readStreamTags, topLevelBoxes } from "../helpers/ffprobe-tags.js"

const limits = loadLimits({})

describe("sandbox/exec runTool", () => {
  it("enforces the timeout and SIGKILLs a long-running child", async () => {
    const start = Date.now()
    let caught: unknown
    try {
      await runTool("sleeper", process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        timeoutMs: 200,
        maxStdoutBytes: 1024,
      })
    } catch (err) {
      caught = err
    }
    const elapsed = Date.now() - start
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(true)
    expect(elapsed).toBeLessThan(3000)
  })

  it("maps a non-zero exit to a SandboxToolError (not a raw throw)", async () => {
    let caught: unknown
    try {
      await runTool("exiter", process.execPath, ["-e", "process.exit(3)"], {
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(false)
    expect((caught as SandboxToolError).exitCode).toBe(3)
  })

  it("kills a child whose stdout outgrows maxBuffer instead of buffering it", async () => {
    let caught: unknown
    try {
      await runTool(
        "chatty-stdout",
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(200000))"],
        { timeoutMs: 5_000, maxStdoutBytes: 16 },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(false)
  })

  it("also fails a child whose STDERR outgrows maxBuffer, even on a zero exit", async () => {
    let caught: unknown
    try {
      await runTool(
        "chatty-stderr",
        process.execPath,
        ["-e", "process.stderr.write('y'.repeat(200000)); process.exit(0)"],
        { timeoutMs: 5_000, maxStdoutBytes: 16 },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(false)
  })

  it("runs a lowPriority child at niceness 19", async () => {
    const res = await runTool("niceness", "/usr/bin/nice", [], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      lowPriority: true,
    })
    expect(res.stdout).toBe("19")
  })

  it("returns stdout/stderr/exitCode for a child that stays within its limits", async () => {
    const res = await runTool(
      "quiet",
      process.execPath,
      ["-e", "process.stdout.write('out-ok'); process.stderr.write('err-ok')"],
      { timeoutMs: 5_000, maxStdoutBytes: 1024 },
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("out-ok")
    expect(res.stderr).toBe("err-ok")
    expect(res.stdoutBuffer.toString("utf8")).toBe("out-ok")
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
    expect(out.exifGps).not.toBeNull()
    expect(await hasNoGps(out.strippedBytes)).toBe(true)
    expect(await hasNoGps(out.thumbnailBytes)).toBe(true)
  })

  it("produces a thumbnail whose longest edge is <= the configured max", async () => {
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

  it("re-encodes a transparent PNG as a JPEG on white, thumbnail included", async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()

    const out = await processImage(png, limits)

    expect(out.strippedContentType).toBe("image/jpeg")
    for (const bytes of [out.strippedBytes, out.thumbnailBytes]) {
      const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
      expect((await sharp(bytes).metadata()).format).toBe("jpeg")
      expect(info.channels).toBe(3)
      expect(Math.min(...data)).toBeGreaterThanOrEqual(250)
    }
  })

  it("re-encodes a WebP as a JPEG", async () => {
    const webp = await sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .webp()
      .toBuffer()

    const out = await processImage(webp, limits)

    expect(out.strippedContentType).toBe("image/jpeg")
    expect((await sharp(out.strippedBytes).metadata()).format).toBe("jpeg")
  })

  it.each([
    [3000, 2000, 1920, 1280],
    [1500, 2400, 1200, 1920],
    [800, 600, 800, 600],
  ])("serves a %ix%i image at %ix%i (long edge <= 1920, never enlarged)", async (w, h, ow, oh) => {
    const jpeg = await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .jpeg()
      .toBuffer()

    const out = await processImage(jpeg, limits)

    const served = await sharp(out.strippedBytes).metadata()
    expect([served.width, served.height]).toEqual([ow, oh])
    expect([out.meta.width, out.meta.height]).toEqual([ow, oh])
  })

  it("encodes at JPEG quality 80", async () => {
    const png = await fx.makeValidPng()

    const out = await processImage(png, limits)

    const expected = await sharp(png)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: SERVED_IMAGE_JPEG_QUALITY, mozjpeg: false })
      .toBuffer()
    expect(out.strippedBytes.equals(expected)).toBe(true)
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

  describe("dHash bit rule", () => {
    function ramp(reverse: boolean): Promise<Buffer> {
      const w = 64
      const h = 64
      const raw = Buffer.alloc(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = Math.round((x / (w - 1)) * 255)
          raw[y * w + x] = reverse ? 255 - v : v
        }
      }
      return sharp(raw, { raw: { width: w, height: h, channels: 1 } })
        .png()
        .toBuffer()
    }

    it("hashes an ascending ramp to all-zero bits and a descending ramp to all-one bits", async () => {
      const ascending = await perceptualHash(await ramp(false), limits)
      const descending = await perceptualHash(await ramp(true), limits)
      expect(ascending).toBe("0000000000000000")
      expect(descending).toBe("ffffffffffffffff")
      expect(ascending).not.toBe(descending)
    })

    function tent(invert: boolean): Promise<Buffer> {
      const w = 72
      const h = 64
      const raw = Buffer.alloc(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = (1 - Math.abs((x / (w - 1)) * 2 - 1)) * 255
          raw[y * w + x] = Math.round(invert ? 255 - v : v)
        }
      }
      return sharp(raw, { raw: { width: w, height: h, channels: 1 } })
        .png()
        .toBuffer()
    }

    it("is PERCEPTUAL: a downscaled, JPEG-re-encoded copy hashes identically", async () => {
      const original = await tent(false)
      const hash = await perceptualHash(original, limits)
      expect(hash).toBe("0f0f0f0f0f0f0f0f")

      const downscaled = await sharp(original).resize(32, 32).jpeg({ quality: 70 }).toBuffer()
      expect(await perceptualHash(downscaled, limits)).toBe(hash)
      const lossy = await sharp(original).resize(21, 19).jpeg({ quality: 40 }).toBuffer()
      expect(await perceptualHash(lossy, limits)).toBe(hash)
      const upscaled = await sharp(original).resize(600, 400).jpeg({ quality: 90 }).toBuffer()
      expect(await perceptualHash(upscaled, limits)).toBe(hash)

      const mirrored = await tent(true)
      expect(await perceptualHash(mirrored, limits)).toBe("f0f0f0f0f0f0f0f0")
    })

    it("refuses a non-allowlisted container (the L15 sniff applies to the hash path too)", async () => {
      const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
      )
      await expect(perceptualHash(svg, limits)).rejects.toThrow(/unsupported image container/i)
    })
  })
})

describe("sandbox/ffmpeg-remux", () => {
  it("remuxes a real MP4 into a still-decodable, metadata-stripped MP4", async () => {
    const input = await fx.makeValidMp4()
    const remuxed = await remuxStripMetadata(input, limits)
    expect(remuxed.byteLength).toBeGreaterThan(0)
    const probe = await probeBytes(remuxed, limits)
    expect(probe.isVideo).toBe(true)
    expect(probe.codec).toBe("h264")
  })

  it("DROPS container location / comment tags (privacy: the mp4 GPS strip)", async () => {
    const input = await fx.makeMp4WithLocationMetadata()

    const before = await readContainerTags(input)
    expect(before.location).toBe("+37.7000-122.4000/")
    expect(before["location-eng"]).toBe("+37.7000-122.4000/")
    expect(before.comment).toBe("civfix-fixture-device")

    const after = await readContainerTags(await remuxStripMetadata(input, limits))
    expect(after.location).toBeUndefined()
    expect(after["location-eng"]).toBeUndefined()
    expect(after.comment).toBeUndefined()
  })

  it("also drops metadata from the single-frame thumbnail grab", async () => {
    const frame = await grabFrameJpeg(await fx.makeMp4WithLocationMetadata(), 0, limits)
    expect(frame.byteLength).toBeGreaterThan(0)
    expect(await hasNoGps(frame)).toBe(true)
  })

  it("F077: drops per-stream tags and every non-video/audio track (device tag + GPS subtitle gone)", async () => {
    const input = await fx.makeMp4WithSubtitleAndStreamTags()

    const before = await readStreamTags(input)
    expect(before.some((s) => Object.values(s.tags).includes("MyPhoneCam"))).toBe(true)
    expect(before.some((s) => s.codecType === "subtitle")).toBe(true)
    expect(Buffer.from(input).includes(Buffer.from("HOME ADDRESS"))).toBe(true)

    const out = await remuxStripMetadata(input, limits)
    const after = await readStreamTags(out)

    expect(after.length).toBeGreaterThan(0)
    expect(after.every((s) => s.codecType === "video" || s.codecType === "audio")).toBe(true)
    expect(after.some((s) => s.codecType === "subtitle")).toBe(false)
    expect(after.some((s) => Object.values(s.tags).includes("MyPhoneCam"))).toBe(false)
    expect(out.includes(Buffer.from("HOME ADDRESS"))).toBe(false)
  })
})

describe("sandbox: HLS / ffconcat inputs cannot reach the network or the filesystem", () => {
  let server: Server
  let hits: string[] = []
  let segmentUrl = ""

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "")
      res.statusCode = 200
      res.end("segment-bytes")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address() as AddressInfo
    segmentUrl = `http://127.0.0.1:${addr.port}/secret-segment.ts`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("probeBytes refuses an HLS playlist WITHOUT fetching its segment URL", async () => {
    hits = []
    const playlist = fx.makeHlsPlaylist(segmentUrl)
    let caught: unknown
    try {
      await probeBytes(playlist, limits)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).stderrTail).toMatch(
      /not on whitelist|moov atom not found|invalid data/i,
    )
    expect(hits).toEqual([])
  })

  it("remux + frame-grab refuse an HLS playlist via the FORCED mov demuxer (no fetch)", async () => {
    hits = []
    const playlist = fx.makeHlsPlaylist(segmentUrl)
    for (const [label, run] of [
      ["remux", () => remuxStripMetadata(playlist, limits)],
      ["frame", () => grabFrameJpeg(playlist, 0, limits)],
    ] as const) {
      let caught: unknown
      try {
        await run()
      } catch (err) {
        caught = err
      }
      expect(caught, label).toBeInstanceOf(SandboxToolError)
      expect((caught as SandboxToolError).stderrTail, label).toMatch(/moov atom not found/i)
    }
    expect(hits).toEqual([])
  })

  it("an ffconcat script cannot read local files through probeBytes or the remux", async () => {
    const list = fx.makeFfconcatList(["/etc/passwd", "/etc/hosts"])

    let probeErr: unknown
    try {
      await probeBytes(list, limits)
    } catch (err) {
      probeErr = err
    }
    expect(probeErr).toBeInstanceOf(SandboxToolError)
    expect((probeErr as SandboxToolError).stderrTail).toMatch(
      /unsafe file name|moov atom not found|invalid data/i,
    )

    let remuxErr: unknown
    try {
      await remuxStripMetadata(list, limits)
    } catch (err) {
      remuxErr = err
    }
    expect(remuxErr).toBeInstanceOf(SandboxToolError)
    expect((remuxErr as SandboxToolError).stderrTail).toMatch(/moov atom not found/i)
  })
})

describe("sandbox/image magic-byte container gate (L15)", () => {
  it("recognizes exactly JPEG / PNG / WebP signatures", () => {
    expect(sniffAllowedImageContainer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg")
    expect(
      sniffAllowedImageContainer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png")
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
    expect(sniffAllowedImageContainer(webp)).toBe("webp")
  })

  it("rejects SVG, PDF, GIF and TIFF containers", () => {
    const cases: Record<string, Uint8Array> = {
      svg: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
      pdf: new TextEncoder().encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"),
      gif: new TextEncoder().encode("GIF89a"),
      tiffLE: new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]),
      tiffBE: new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0, 0, 0, 0, 0]),
      riffNotWebp: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20]),
      empty: new Uint8Array([]),
    }
    for (const [label, bytes] of Object.entries(cases)) {
      expect(sniffAllowedImageContainer(bytes), label).toBeNull()
    }
  })

  it("processImage refuses a non-allowlisted container so libvips never sees it", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    )
    await expect(processImage(svg, limits)).rejects.toThrow(/unsupported image container/i)
  })

  it("still accepts a real JPEG through the gate", async () => {
    const jpeg = await fx.makeValidJpegWithGps()
    await expect(processImage(jpeg, limits)).resolves.toBeDefined()
  })
})

describe("sandbox/ffmpeg-transcode", () => {
  function videoOf(streams: Awaited<ReturnType<typeof readStreamTags>>) {
    const video = streams.find((st) => st.codecType === "video")
    if (!video) throw new Error("no video stream")
    return video
  }

  it("turns 1080p60 HEVC into a faststart 720p30 H.264 MP4, audio kept, location gone", async () => {
    const input = await fx.makePhoneClip({
      codec: "hevc",
      width: 1920,
      height: 1080,
      fps: 60,
      location: "+34.0500-118.2400/",
    })
    expect((await readContainerTags(input)).location).toBe("+34.0500-118.2400/")

    const out = await transcodeToServedMp4(input, { capFps: true }, limits)

    const streams = await readStreamTags(out)
    expect(videoOf(streams)).toMatchObject({
      codecName: "h264",
      width: 1280,
      height: 720,
      avgFrameRate: "30/1",
    })
    expect(streams.find((st) => st.codecType === "audio")?.codecName).toBe("aac")
    expect((await readContainerTags(out)).location).toBeUndefined()
    const boxes = topLevelBoxes(out)
    expect(boxes.indexOf("moov")).toBeGreaterThanOrEqual(0)
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"))
  })

  it("bakes a phone's quarter-turn into upright 720x1280 pixels", async () => {
    const input = await fx.makePhoneClip({
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: 30,
      rotation: 90,
    })

    const out = await transcodeToServedMp4(input, { capFps: false }, limits)

    expect(videoOf(await readStreamTags(out))).toMatchObject({
      width: 720,
      height: 1280,
      rotation: null,
    })
  })

  // ffmpeg checks -max_pixels against a stride-padded buffer (1088x1920 here), so a guard equal to the
  // accepted 1920x1080 cap would fail every coded-portrait clip that validation lets through.
  it("decodes a coded 1080x1920 portrait clip at the default caps", async () => {
    const input = await fx.makePhoneClip({ codec: "h264", width: 1080, height: 1920, fps: 30 })

    const out = await transcodeToServedMp4(input, { capFps: false }, limits)
    const frame = await grabFrameJpeg(input, 0.5, limits)

    expect(videoOf(await readStreamTags(out))).toMatchObject({ width: 720, height: 1280 })
    expect(await sharp(frame).metadata()).toMatchObject({ width: 1080, height: 1920 })
  })

  it("never enlarges a clip already under the long-edge cap", async () => {
    const input = await fx.makePhoneClip({ codec: "hevc", width: 640, height: 360, fps: 30 })

    const out = await transcodeToServedMp4(input, { capFps: false }, limits)

    expect(videoOf(await readStreamTags(out))).toMatchObject({
      codecName: "h264",
      width: 640,
      height: 360,
      avgFrameRate: "30/1",
    })
  })

  it.each([
    ["yuv444p", "High 4:4:4 Predictive"],
    ["yuv420p10le", "High 10"],
  ])("transcodes a 720p30 %s (%s) H.264 clip to a playable one", async (pixFmt, profile) => {
    const input = await fx.makePhoneClip({
      codec: "h264",
      width: 1280,
      height: 720,
      fps: 30,
      pixFmt,
    })
    const probe = await probeBytes(input, limits)
    expect(probe).toMatchObject({ codec: "h264", pixFmt, profile })
    expect(servedVideoPlan(probe, limits)).toEqual({ transcode: true, capFps: false })

    const out = await transcodeToServedMp4(input, { capFps: false }, limits)

    const served = await probeBytes(out, limits)
    expect(served).toMatchObject({ codec: "h264", pixFmt: "yuv420p", width: 1280, height: 720 })
    expect(servedVideoPlan(served, limits)).toEqual({ transcode: false })
  })
})

describe("sandbox/preflight video lane", () => {
  it("pushes the built-in h264 and hevc clips through probe, remux, transcode and the frame grab", async () => {
    await expect(assertVideoLaneRuns()).resolves.toBeUndefined()
  })

  it("refuses a boot whose ffmpeg build cannot process them", async () => {
    vi.stubEnv("FFMPEG_PATH", "/usr/bin/false")
    vi.stubEnv("FFPROBE_PATH", "/usr/bin/false")
    resetMediaToolPaths()
    try {
      await expect(assertVideoLaneRuns()).rejects.toThrow(/cannot process the built-in h264 clip/)
    } finally {
      vi.unstubAllEnvs()
      resetMediaToolPaths()
    }
  })
})
