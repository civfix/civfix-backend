import { existsSync } from "node:fs"
import { z } from "zod"
import { loadImageLaneEntry, type WorkerLimits } from "../config.js"
import { ImageProcessingError, processImage, type ProcessedImage } from "./image.js"
import { perceptualHash } from "./phash.js"
import { runTool, sandboxIdentity, SandboxSpawnError } from "./exec.js"
import { makeScratch, readScratchOutput } from "./tmp.js"
import { RUN_FLAG, STRIPPED_FILE, THUMB_FILE } from "./image-lane-main.js"

export interface ImageLaneResult extends ProcessedImage {
  phash: string | null
}

const SPAWN_OVERHEAD_MS = 5_000

// The child bounds metadata, strip + thumbnail, and the perceptual hash by imageTimeoutMs EACH and runs them
// in sequence, so killing it at a single imageTimeoutMs rejected (and deleted) slow but legitimate photos.
const CHILD_TIMED_PHASES = 3

export function imageLaneTimeoutMs(limits: WorkerLimits): number {
  return CHILD_TIMED_PHASES * limits.imageTimeoutMs + SPAWN_OVERHEAD_MS
}

export const ALLOWED_OUTPUT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const

const PHASH_RE = /^[0-9a-f]{16}$/

function envelopeSchema(limits: WorkerLimits) {
  const dimension = z.number().int().positive().max(limits.maxImagePixels)
  return z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        meta: z
          .object({
            width: dimension,
            height: dimension,
            format: z.enum(["jpeg", "png", "webp"]),
          })
          .strict()
          .refine((m) => m.width * m.height <= limits.maxImagePixels, "pixel budget exceeded"),
        strippedContentType: z.enum(ALLOWED_OUTPUT_CONTENT_TYPES),
        thumbnailContentType: z.enum(ALLOWED_OUTPUT_CONTENT_TYPES),
        exifGps: z
          .object({ lat: z.number().finite(), lng: z.number().finite() })
          .strict()
          .nullable(),
        phash: z.string().regex(PHASH_RE).nullable(),
      })
      .strict(),
    z.object({ ok: z.literal(false), error: z.string().max(500) }).strict(),
  ])
}

export function imageLaneEntry(): string {
  return loadImageLaneEntry()
}

export async function processImageLane(
  bytes: Uint8Array,
  limits: WorkerLimits,
): Promise<ImageLaneResult> {
  const identity = sandboxIdentity()
  if (identity === null) return processInProcess(bytes, limits)

  const scratch = await makeScratch(bytes, "bin")
  try {
    const request = JSON.stringify({
      inputPath: scratch.inputPath,
      outDir: scratch.dir,
      limits,
    })
    const entry = imageLaneEntry()
    if (!existsSync(entry)) {
      throw new SandboxSpawnError(
        "image-lane",
        new Error(`the image lane entry ${entry} does not exist (set MEDIA_IMAGE_LANE_ENTRY)`),
      )
    }
    const res = await runTool("image-lane", process.execPath, [entry, RUN_FLAG, request], {
      timeoutMs: imageLaneTimeoutMs(limits),
      maxStdoutBytes: limits.maxToolStdoutBytes,
      cwd: scratch.dir,
    })
    await scratch.seal()

    let raw: unknown
    try {
      raw = JSON.parse(res.stdout)
    } catch (err) {
      throw new ImageProcessingError("image lane produced no parseable result", err)
    }
    const parsed = envelopeSchema(limits).safeParse(raw)
    if (!parsed.success) {
      throw new ImageProcessingError(
        `image lane returned an invalid result: ${parsed.error.message}`,
      )
    }
    if (!parsed.data.ok) throw new ImageProcessingError(parsed.data.error)

    const [strippedBytes, thumbnailBytes] = await Promise.all([
      readScratchOutput(scratch.dir, STRIPPED_FILE, identity.uid, limits.maxChildOutputBytes),
      readScratchOutput(scratch.dir, THUMB_FILE, identity.uid, limits.maxChildOutputBytes),
    ])

    return {
      meta: parsed.data.meta,
      strippedBytes,
      strippedContentType: parsed.data.strippedContentType,
      thumbnailBytes,
      thumbnailContentType: parsed.data.thumbnailContentType,
      exifGps: parsed.data.exifGps,
      phash: parsed.data.phash,
    }
  } finally {
    await scratch.cleanup()
  }
}

async function processInProcess(bytes: Uint8Array, limits: WorkerLimits): Promise<ImageLaneResult> {
  const processed = await processImage(bytes, limits)
  let phash: string | null = null
  try {
    phash = await perceptualHash(bytes, limits)
  } catch {
    // The hash only feeds the non-blocking near-duplicate note; an image that decoded above still ships.
    phash = null
  }
  return { ...processed, phash }
}
