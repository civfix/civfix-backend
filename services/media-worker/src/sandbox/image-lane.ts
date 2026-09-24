import { existsSync } from "node:fs"
import { z } from "zod"
import { imageLaneTimeoutMs, loadImageLaneEntry, type WorkerLimits } from "../config.js"
import {
  ALLOWED_IMAGE_FORMATS,
  ImageProcessingError,
  processImage,
  type ProcessedImage,
} from "./image.js"
import { bestEffortPerceptualHash } from "./phash.js"
import { runTool, sandboxIdentity, SandboxSpawnError } from "./exec.js"
import { makeScratch, readScratchOutput } from "./tmp.js"
import { RUN_FLAG, STRIPPED_FILE, THUMB_FILE } from "./image-lane-main.js"

export interface ImageLaneResult extends ProcessedImage {
  phash: string | null
}

export { imageLaneTimeoutMs }

const ALLOWED_OUTPUT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const

const PHASH_RE = /^[0-9a-f]{16}$/
const MAX_LANE_ERROR_CHARS = 500
const IMAGE_LANE_TOOL = "image-lane"

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
            format: z.enum(ALLOWED_IMAGE_FORMATS),
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
    z.object({ ok: z.literal(false), error: z.string().max(MAX_LANE_ERROR_CHARS) }).strict(),
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
        IMAGE_LANE_TOOL,
        new Error(`the image lane entry ${entry} does not exist (set MEDIA_IMAGE_LANE_ENTRY)`),
      )
    }
    const res = await runTool(IMAGE_LANE_TOOL, process.execPath, [entry, RUN_FLAG, request], {
      timeoutMs: imageLaneTimeoutMs(limits),
      maxStdoutBytes: limits.maxToolStdoutBytes,
      cwd: scratch.dir,
    })
    await scratch.seal()

    const envelope = parseLaneEnvelope(res.stdout, limits)

    const [strippedBytes, thumbnailBytes] = await Promise.all([
      readScratchOutput(scratch.dir, STRIPPED_FILE, identity.uid, limits.maxChildOutputBytes),
      readScratchOutput(scratch.dir, THUMB_FILE, identity.uid, limits.maxChildOutputBytes),
    ])

    return {
      meta: envelope.meta,
      strippedBytes,
      strippedContentType: envelope.strippedContentType,
      thumbnailBytes,
      thumbnailContentType: envelope.thumbnailContentType,
      exifGps: envelope.exifGps,
      phash: envelope.phash,
    }
  } finally {
    await scratch.cleanup()
  }
}

// The child's stdout is untrusted output of a process that decoded hostile bytes: anything that is not a
// schema-valid success envelope becomes an ImageProcessingError (a rejection, never an infra retry).
function parseLaneEnvelope(stdout: string, limits: WorkerLimits) {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch (err) {
    throw new ImageProcessingError("image lane produced no parseable result", err)
  }
  const parsed = envelopeSchema(limits).safeParse(raw)
  if (!parsed.success) {
    throw new ImageProcessingError(`image lane returned an invalid result: ${parsed.error.message}`)
  }
  if (!parsed.data.ok) throw new ImageProcessingError(parsed.data.error)
  return parsed.data
}

async function processInProcess(bytes: Uint8Array, limits: WorkerLimits): Promise<ImageLaneResult> {
  const processed = await processImage(bytes, limits)
  return { ...processed, phash: await bestEffortPerceptualHash(bytes, limits) }
}
