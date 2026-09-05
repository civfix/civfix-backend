
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { WorkerLimits } from "../config.js"
import { processImage } from "./image.js"
import { perceptualHash } from "./phash.js"

export const RUN_FLAG = "--civfix-image-lane"

export const STRIPPED_FILE = "stripped.bin"
export const THUMB_FILE = "thumb.bin"

export interface ImageLaneRequest {
  inputPath: string
  outDir: string
  limits: WorkerLimits
}

export interface ImageLaneSuccess {
  ok: true
  meta: { width: number; height: number; format: string }
  strippedContentType: string
  thumbnailContentType: string
  exifGps: { lat: number; lng: number } | null
  phash: string | null
}

export interface ImageLaneFailure {
  ok: false
  error: string
}

export type ImageLaneResponse = ImageLaneSuccess | ImageLaneFailure

export function requestArg(argv: string[]): string | undefined {
  const at = argv.indexOf(RUN_FLAG)
  return at === -1 ? argv[2] : argv[at + 1]
}

export function parseRequest(raw: string | undefined): ImageLaneRequest {
  if (raw === undefined) throw new Error("image-lane: missing request argument")
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null) throw new Error("image-lane: request is not an object")
  const req = parsed as Record<string, unknown>
  if (typeof req.inputPath !== "string" || typeof req.outDir !== "string") {
    throw new Error("image-lane: request is missing inputPath/outDir")
  }
  if (typeof req.limits !== "object" || req.limits === null) {
    throw new Error("image-lane: request is missing limits")
  }
  return {
    inputPath: req.inputPath,
    outDir: req.outDir,
    limits: req.limits as WorkerLimits,
  }
}

export async function runImageLane(req: ImageLaneRequest): Promise<ImageLaneResponse> {
  const bytes = new Uint8Array(await readFile(req.inputPath))
  let processed: Awaited<ReturnType<typeof processImage>>
  try {
    processed = await processImage(bytes, req.limits)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  let phash: string | null = null
  try {
    phash = await perceptualHash(bytes, req.limits)
  } catch {
    phash = null
  }

  await writeFile(join(req.outDir, STRIPPED_FILE), processed.strippedBytes)
  await writeFile(join(req.outDir, THUMB_FILE), processed.thumbnailBytes)

  return {
    ok: true,
    meta: processed.meta,
    strippedContentType: processed.strippedContentType,
    thumbnailContentType: processed.thumbnailContentType,
    exifGps: processed.exifGps,
    phash,
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const response = await runImageLane(parseRequest(requestArg(argv)))
    process.stdout.write(JSON.stringify(response))
    return 0
  } catch (err) {
    process.stderr.write(`image-lane: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

if (process.argv.includes(RUN_FLAG)) {
  main(process.argv).then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
