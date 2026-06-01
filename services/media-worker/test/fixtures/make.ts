/**
 * Crafted media fixtures for the safe-failure tests.
 *
 * Everything is GENERATED at test time (no committed binaries) so the inputs are deterministic and the
 * generators document exactly what each fixture is:
 *   validJpeg          a tiny valid JPEG (sharp) with a hand-built EXIF GPS block (proves strip works).
 *   validPng           a small valid PNG (sharp).
 *   truncatedImage     a valid JPEG cut in half (decoder must error, not produce a partial image).
 *   garbageImage       random bytes (no image at all).
 *   textAsJpg          a UTF-8 text file (wrong magic; named .jpg by the client) -> must be rejected.
 *   oversizeImage      a buffer just over the download cap -> must be rejected before decode.
 *   nsfwJpeg           a valid JPEG whose bytes contain the FakeAbuseChecks "NSFW" marker -> held.
 *   pixelBombHeader    a tiny image header DECLARING enormous dimensions (decode-bomb guard).
 *   validMp4()         a 1s h264 testsrc MP4 (ffmpeg) -> the happy video path.
 *   audioOnlyMp4()     an audio-only MP4 (no video stream) -> rejected (not a video).
 *   nonVideoAsMp4      a text/garbage buffer labeled video -> ffprobe fails -> rejected.
 *
 * The EXIF GPS builder writes a minimal big-endian TIFF/EXIF APP1 segment with a GPS IFD; it is
 * verified to round-trip through exifr in the unit tests.
 */

import sharp from "sharp"
import ffmpegPath from "ffmpeg-static"
import { execa } from "execa"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Build a minimal big-endian EXIF APP1 segment carrying a GPS lat/lng. */
export function buildExifGpsApp1(lat: number, lng: number): Buffer {
  const toRat = (deg: number): [number, number][] => {
    const d = Math.floor(deg)
    const mf = (deg - d) * 60
    const m = Math.floor(mf)
    const s = Math.round((mf - m) * 60 * 100)
    return [
      [d, 1],
      [m, 1],
      [s, 100],
    ]
  }

  const tiff = Buffer.alloc(8)
  tiff.write("MM", 0, "ascii")
  tiff.writeUInt16BE(0x002a, 2)
  tiff.writeUInt32BE(8, 4) // IFD0 at offset 8

  const ifd0 = Buffer.alloc(18)
  ifd0.writeUInt16BE(1, 0) // 1 entry
  ifd0.writeUInt16BE(0x8825, 2) // GPS IFD pointer
  ifd0.writeUInt16BE(4, 4) // type LONG
  ifd0.writeUInt32BE(1, 6) // count
  ifd0.writeUInt32BE(26, 10) // GPS IFD offset
  ifd0.writeUInt32BE(0, 14) // next IFD = 0

  const gps = Buffer.alloc(54)
  gps.writeUInt16BE(4, 0) // 4 entries
  let o = 2
  gps.writeUInt16BE(0x0001, o)
  gps.writeUInt16BE(2, o + 2)
  gps.writeUInt32BE(2, o + 4)
  gps.write(lat >= 0 ? "N" : "S", o + 8, "ascii")
  o += 12
  gps.writeUInt16BE(0x0002, o)
  gps.writeUInt16BE(5, o + 2)
  gps.writeUInt32BE(3, o + 4)
  gps.writeUInt32BE(80, o + 8)
  o += 12
  gps.writeUInt16BE(0x0003, o)
  gps.writeUInt16BE(2, o + 2)
  gps.writeUInt32BE(2, o + 4)
  gps.write(lng >= 0 ? "E" : "W", o + 8, "ascii")
  o += 12
  gps.writeUInt16BE(0x0004, o)
  gps.writeUInt16BE(5, o + 2)
  gps.writeUInt32BE(3, o + 4)
  gps.writeUInt32BE(104, o + 8)
  o += 12
  gps.writeUInt32BE(0, o) // next IFD = 0

  const ratBuf = (rats: [number, number][]): Buffer => {
    const b = Buffer.alloc(24)
    rats.forEach((r, i) => {
      b.writeUInt32BE(r[0], i * 8)
      b.writeUInt32BE(r[1], i * 8 + 4)
    })
    return b
  }

  const tiffBlock = Buffer.concat([
    tiff,
    ifd0,
    gps,
    ratBuf(toRat(Math.abs(lat))),
    ratBuf(toRat(Math.abs(lng))),
  ])
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffBlock])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([app1, payload])
}

/** Insert an APP1 segment immediately after the JPEG SOI marker. */
function spliceApp1(jpeg: Buffer, app1: Buffer): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

/** A tiny valid JPEG with embedded EXIF GPS (San Francisco-ish). */
export async function makeValidJpegWithGps(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer()
  return spliceApp1(base, buildExifGpsApp1(37.7672, -122.4308))
}

/** A small valid PNG. */
export async function makeValidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer()
}

/** A valid JPEG truncated to half its length (decoder must error). */
export async function makeTruncatedImage(): Promise<Buffer> {
  const full = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .jpeg()
    .toBuffer()
  return full.subarray(0, Math.max(8, Math.floor(full.length / 2)))
}

/** Random bytes that are not an image. */
export function makeGarbageImage(size = 2048): Buffer {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 131 + 7) & 0xff
  return b
}

/** A UTF-8 text file (wrong magic) that the client mislabeled as .jpg. */
export function makeTextAsJpg(): Buffer {
  return Buffer.from(
    "this is definitely not a jpeg, it is plain text pretending to be one\n",
    "utf8",
  )
}

/** A buffer just over `cap` bytes (cheap; content is irrelevant since it is rejected pre-decode). */
export function makeOversize(cap: number): Buffer {
  return Buffer.alloc(cap + 1024, 0x41)
}

/** A valid JPEG whose trailing bytes contain the FakeAbuseChecks "NSFW" marker. */
export async function makeNsfwJpeg(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer()
  // Append the marker AFTER EOI so the JPEG still decodes; FakeAbuseChecks scans raw bytes for "NSFW".
  return Buffer.concat([base, Buffer.from("NSFW", "ascii")])
}

/**
 * A pixel-bomb PNG header: a real PNG IHDR declaring enormous dimensions but almost no pixel data. The
 * decode guard (limitInputPixels) must reject it at header parse. We craft only the signature + IHDR,
 * which is enough for a decoder to read the declared dimensions and refuse.
 */
export function makePixelBombPng(width = 100000, height = 100000): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25) // 4 len + 4 type + 13 data + 4 crc
  ihdr.writeUInt32BE(13, 0) // IHDR data length
  ihdr.write("IHDR", 4, "ascii")
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.writeUInt8(8, 16) // bit depth
  ihdr.writeUInt8(2, 17) // color type 2 (truecolor)
  ihdr.writeUInt8(0, 18) // compression
  ihdr.writeUInt8(0, 19) // filter
  ihdr.writeUInt8(0, 20) // interlace
  // CRC left zero: sharp/libvips reads dimensions before validating downstream chunks and rejects on
  // the pixel limit; an invalid CRC also yields a decode error. Either way -> rejected.
  return Buffer.concat([sig, ihdr])
}

/** Run ffmpeg to produce bytes from a lavfi/output spec, returning the output file bytes. */
async function ffmpegProduce(
  args: (outPath: string) => string[],
  outName: string,
): Promise<Buffer> {
  const bin = ffmpegPath as unknown as string
  const dir = await mkdtemp(join(tmpdir(), "civfix-fixt-"))
  const out = join(dir, outName)
  try {
    await execa(bin, args(out), { timeout: 30000, reject: true })
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A 1-second 320x240 h264 testsrc MP4 (yuv420p, faststart, no audio). */
export async function makeValidMp4(): Promise<Buffer> {
  return ffmpegProduce(
    (out) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=15:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      out,
    ],
    "valid.mp4",
  )
}

/** An audio-only MP4 (AAC, no video stream) -> must be rejected as "not a video". */
export async function makeAudioOnlyMp4(): Promise<Buffer> {
  return ffmpegProduce(
    (out) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      out,
    ],
    "audio.m4a",
  )
}

/** A non-video buffer labeled as video (ffprobe must fail to read it as media). */
export function makeNonVideoAsMp4(): Buffer {
  return Buffer.from("ftypnotreallyanmp4 this is garbage masquerading as video\n".repeat(8), "utf8")
}
