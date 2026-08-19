
import sharp from "sharp"
import ffmpegPath from "ffmpeg-static"
import { execa } from "execa"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  tiff.writeUInt32BE(8, 4)

  const ifd0 = Buffer.alloc(18)
  ifd0.writeUInt16BE(1, 0)
  ifd0.writeUInt16BE(0x8825, 2)
  ifd0.writeUInt16BE(4, 4)
  ifd0.writeUInt32BE(1, 6)
  ifd0.writeUInt32BE(26, 10)
  ifd0.writeUInt32BE(0, 14)

  const gps = Buffer.alloc(54)
  gps.writeUInt16BE(4, 0)
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
  gps.writeUInt32BE(0, o)

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

function spliceApp1(jpeg: Buffer, app1: Buffer): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

export async function makeValidJpegWithGps(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer()
  return spliceApp1(base, buildExifGpsApp1(37.7672, -122.4308))
}

export async function makeValidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer()
}

export async function makeTruncatedImage(): Promise<Buffer> {
  const full = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .jpeg()
    .toBuffer()
  return full.subarray(0, Math.max(8, Math.floor(full.length / 2)))
}

export function makeGarbageImage(size = 2048): Buffer {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 131 + 7) & 0xff
  return b
}

export function makeTextAsJpg(): Buffer {
  return Buffer.from(
    "this is definitely not a jpeg, it is plain text pretending to be one\n",
    "utf8",
  )
}

export function makeOversize(cap: number): Buffer {
  return Buffer.alloc(cap + 1024, 0x41)
}

export async function makeNsfwJpeg(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer()
  return Buffer.concat([base, Buffer.from("NSFW", "ascii")])
}

export function makePixelBombPng(width = 100000, height = 100000): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write("IHDR", 4, "ascii")
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.writeUInt8(8, 16)
  ihdr.writeUInt8(2, 17)
  ihdr.writeUInt8(0, 18)
  ihdr.writeUInt8(0, 19)
  ihdr.writeUInt8(0, 20)
  return Buffer.concat([sig, ihdr])
}

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

export function makeNonVideoAsMp4(): Buffer {
  return Buffer.from("ftypnotreallyanmp4 this is garbage masquerading as video\n".repeat(8), "utf8")
}

export async function makeMp4WithLocationMetadata(): Promise<Buffer> {
  return ffmpegProduce(
    (out) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=10:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-metadata",
      "location=+37.7-122.4/",
      "-metadata",
      "location-eng=+37.7-122.4/",
      "-metadata",
      "comment=civfix-fixture-device",
      "-movflags",
      "+faststart",
      "-y",
      out,
    ],
    "located.mp4",
  )
}

export async function makeMpeg4Mp4(): Promise<Buffer> {
  return ffmpegProduce(
    (out) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=10:duration=1",
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      out,
    ],
    "mpeg4.mp4",
  )
}

export async function makeH264Mp4OfSeconds(durationSec: number): Promise<Buffer> {
  return ffmpegProduce(
    (out) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=160x120:rate=10:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      out,
    ],
    `dur-${durationSec}.mp4`,
  )
}

export function makeHlsPlaylist(segmentUrl: string): Buffer {
  return Buffer.from(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,",
      segmentUrl,
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"),
    "utf8",
  )
}

export function makeFfconcatList(paths: string[]): Buffer {
  const lines = ["ffconcat version 1.0"]
  for (const p of paths) {
    lines.push(`file '${p}'`, "duration 1")
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8")
}

export async function makeMp4WithSubtitleAndStreamTags(): Promise<Buffer> {
  const bin = ffmpegPath as unknown as string
  const dir = await mkdtemp(join(tmpdir(), "civfix-fixt-"))
  const srt = join(dir, "sub.srt")
  const out = join(dir, "tracks.mp4")
  try {
    await writeFile(
      srt,
      "1\n00:00:00,000 --> 00:00:01,000\nLAT 37.77 LNG -122.41 HOME ADDRESS\n\n",
      "utf8",
    )
    await execa(
      bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x120:rate=10:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=1",
        "-i",
        srt,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:s:0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-c:s",
        "mov_text",
        "-metadata:s:v:0",
        "title=DeviceCam",
        "-metadata:s:v:0",
        "handler_name=MyPhoneCam",
        "-movflags",
        "+faststart",
        "-y",
        out,
      ],
      { timeout: 30000, reject: true },
    )
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
