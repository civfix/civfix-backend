/**
 * Sandbox wrapper unit tests (LOCAL: real binaries).
 *
 *   - ffprobe rejects a non-video and accepts a real h264 MP4.
 *   - the hardened runner's TIMEOUT actually kills a long-running child (real spawn + SIGKILL), proving
 *     a wedged decoder cannot hang the worker.
 *   - the image wrapper strips EXIF GPS while preserving dimensions, and produces a bounded thumbnail.
 *   - perceptual hashing is deterministic and implements the documented dHash bit rule.
 *   - the ffmpeg remux strips container/stream metadata (location) while keeping the video decodable.
 *   - the SSRF / demuxer boundaries: an HLS or ffconcat body cannot make a tool fetch a URL or read a
 *     local file, and a chatty child cannot outgrow maxBuffer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import sharp from "sharp"
import { loadLimits } from "../../src/config.js"
import { runTool, SandboxToolError } from "../../src/sandbox/exec.js"
import { probeBytes } from "../../src/sandbox/ffprobe.js"
import { grabFrameJpeg, remuxStripMetadata } from "../../src/sandbox/ffmpeg-remux.js"
import {
  processImage,
  readExifGps,
  hasNoGps,
  sniffAllowedImageContainer,
} from "../../src/sandbox/image.js"
import { perceptualHash } from "../../src/sandbox/phash.js"
import exifr from "exifr"
import * as fx from "../fixtures/make.js"
import { readContainerTags } from "../helpers/ffprobe-tags.js"

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

  /**
   * maxBuffer is the memory bound on a tool that streams to a pipe (ffmpeg writing to stdout, or a
   * decoder spewing warnings per frame). Untested, a regression that dropped or widened it would only
   * show up as the worker's RSS climbing in production.
   */
  it("kills a child whose stdout outgrows maxBuffer instead of buffering it", async () => {
    let caught: unknown
    try {
      await runTool(
        "chatty-stdout",
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(200000))"],
        { timeoutMs: 5_000, maxBuffer: 16 },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    // Not a timeout: the cap fired, not the clock.
    expect((caught as SandboxToolError).timedOut).toBe(false)
  })

  it("also fails a child whose STDERR outgrows maxBuffer, even on a zero exit", async () => {
    let caught: unknown
    try {
      await runTool(
        "chatty-stderr",
        process.execPath,
        ["-e", "process.stderr.write('y'.repeat(200000)); process.exit(0)"],
        { timeoutMs: 5_000, maxBuffer: 16 },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxToolError)
    expect((caught as SandboxToolError).timedOut).toBe(false)
  })

  it("returns stdout/stderr/exitCode for a child that stays within its limits", async () => {
    const res = await runTool(
      "quiet",
      process.execPath,
      ["-e", "process.stdout.write('out-ok'); process.stderr.write('err-ok')"],
      { timeoutMs: 5_000, maxBuffer: 1024 },
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

  /**
   * Pins the documented dHash bit rule (bit = left > right) with inputs whose every bit is predictable,
   * which the previous `distance >= 0` assertion could not do (that is true of any two hashes, including
   * two identical ones - and a solid-colour pair hashes to all-zero in BOTH directions, so "different
   * images differ" needs structure, not just different colours).
   */
  describe("dHash bit rule", () => {
    /** A 64x64 greyscale horizontal ramp: `reverse` flips it so left>right instead of left<right. */
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
      return sharp(raw, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer()
    }

    it("hashes an ascending ramp to all-zero bits and a descending ramp to all-one bits", async () => {
      const ascending = await perceptualHash(await ramp(false), limits)
      const descending = await perceptualHash(await ramp(true), limits)
      expect(ascending).toBe("0000000000000000")
      expect(descending).toBe("ffffffffffffffff")
      expect(ascending).not.toBe(descending)
    })

    /**
     * A 72x64 greyscale TENT: brightness climbs to the middle column and falls again (`invert` mirrors it
     * into a valley). 72 = 8 x (8 + 1), so each of the dHash's 9 sample columns averages an exact 8px band
     * and every adjacent pair differs by ~57 grey levels — far more than resize interpolation or JPEG
     * quantization can move. That is what makes the hash both NON-DEGENERATE and re-encode-stable:
     *   tent   -> 0f0f... (4 rising comparisons then 4 falling, per row)
     *   valley -> f0f0... (the exact bitwise mirror)
     */
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
      return sharp(raw, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer()
    }

    /**
     * Re-encode stability is the whole dedup mechanism: seams.ts matches on an EXACT `phash = $hash`, so a
     * hash that shifts when a phone re-compresses the same photo silently disables near-duplicate
     * detection. It must therefore be asserted on a STRUCTURED fixture — a monotone ramp hashes to
     * all-zeros and so does every rescale of it, which makes the comparison all-zeros === all-zeros and
     * unable to fail.
     */
    it("is PERCEPTUAL: a downscaled, JPEG-re-encoded copy hashes identically", async () => {
      const original = await tent(false)
      const hash = await perceptualHash(original, limits)
      // Non-degenerate: the assertions below compare real structure, not 64 zero bits with 64 zero bits.
      expect(hash).toBe("0f0f0f0f0f0f0f0f")

      const downscaled = await sharp(original).resize(32, 32).jpeg({ quality: 70 }).toBuffer()
      expect(await perceptualHash(downscaled, limits)).toBe(hash)
      // Aggressively lossy AND off-grid (21x19 is not a multiple of the 9x8 sample grid).
      const lossy = await sharp(original).resize(21, 19).jpeg({ quality: 40 }).toBuffer()
      expect(await perceptualHash(lossy, limits)).toBe(hash)
      // ...and upscaled, since a client may re-upload a blown-up copy.
      const upscaled = await sharp(original).resize(600, 400).jpeg({ quality: 90 }).toBuffer()
      expect(await perceptualHash(upscaled, limits)).toBe(hash)

      // The mirror image is NOT that hash: the stability above is a property of this structure, not of a
      // hash function that happens to return the same string for everything.
      const mirrored = await tent(true)
      expect(await perceptualHash(mirrored, limits)).toBe("f0f0f0f0f0f0f0f0")
    })

    it("refuses a non-allowlisted container (the L15 sniff applies to the hash path too)", async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
      await expect(perceptualHash(svg, limits)).rejects.toThrow(/unsupported image container/i)
    })
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

  /**
   * The "strips location" claim, actually verified. No fixture used to carry container metadata at all, so
   * the old assertion (the output still decodes) would have passed with -map_metadata dropped entirely.
   * The BEFORE half matters as much as the AFTER half: without it, a fixture that silently stopped
   * carrying tags would make this test vacuous again.
   */
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
})

/**
 * SSRF + demuxer boundary (the guard in SAFE_INPUT_ARGS: `-protocol_whitelist file -f mov`).
 *
 * A body that is really an HLS playlist or an ffconcat script is a request for the tool to open something
 * ELSE - a URL (SSRF from inside the worker, e.g. cloud metadata) or an arbitrary local file (copied into
 * the "remuxed" object we then serve publicly). Nothing tested this, so removing either flag would have
 * stayed green.
 */
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
    // The protocol whitelist is the thing that stopped it (ffprobe cannot force -f, so this is its guard).
    expect((caught as SandboxToolError).stderrTail).toMatch(/not on whitelist/i)
    // The real proof: the worker made no outbound request at all.
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
      // "moov atom not found" proves the mov demuxer was FORCED: had ffmpeg been allowed to auto-detect,
      // it would have selected hls and complained about the protocol instead.
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
    // ffmpeg's concat demuxer refuses absolute/unsafe paths unless -safe 0 is passed (we never pass it).
    expect((probeErr as SandboxToolError).stderrTail).toMatch(/unsafe file name/i)

    let remuxErr: unknown
    try {
      await remuxStripMetadata(list, limits)
    } catch (err) {
      remuxErr = err
    }
    expect(remuxErr).toBeInstanceOf(SandboxToolError)
    // Forced -f mov: the concat demuxer is never even selected on the remux path.
    expect((remuxErr as SandboxToolError).stderrTail).toMatch(/moov atom not found/i)
  })
})

/**
 * L15 — the ALLOWED_DECODED_FORMATS check ran on `meta.format`, i.e. AFTER `metadata()` dispatched the
 * untrusted bytes to a libvips loader. So an SVG/PDF/TIFF header reached librsvg/poppler/libtiff before
 * we ever rejected it. The container is now sniffed in pure JS BEFORE any sharp instance is built.
 */
describe("sandbox/image magic-byte container gate (L15)", () => {
  it("recognizes exactly JPEG / PNG / WebP signatures", () => {
    expect(sniffAllowedImageContainer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg")
    expect(
      sniffAllowedImageContainer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png")
    // "RIFF" + 4 size bytes + "WEBP"
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50,
    ])
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
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
    await expect(processImage(svg, limits)).rejects.toThrow(/unsupported image container/i)
  })

  it("still accepts a real JPEG through the gate", async () => {
    const jpeg = await fx.makeValidJpegWithGps()
    await expect(processImage(jpeg, limits)).resolves.toBeDefined()
  })
})
