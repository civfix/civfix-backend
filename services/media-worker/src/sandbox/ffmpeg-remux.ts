import { runTool, sandboxIdentity } from "./exec.js"
import { mediaToolPath } from "./binaries.js"
import { makeScratch, readScratchOutput } from "./tmp.js"
import type { WorkerLimits } from "../config.js"

const QUIET_ARGS = ["-hide_banner", "-loglevel", "error", "-nostdin"] as const
const SAFE_INPUT_ARGS = ["-protocol_whitelist", "file", "-f", "mov"] as const

const REMUX_OUTPUT = "out.mp4"
const FRAME_OUTPUT = "frame.jpg"
const SEEK_DECIMALS = 3

async function runFfmpegToScratchOutput(
  bytes: Uint8Array,
  outputName: string,
  limits: WorkerLimits,
  buildArgs: (inputPath: string, outPath: string) => string[],
): Promise<Buffer> {
  const scratch = await makeScratch(bytes, "bin")
  const out = scratch.outPath(outputName)
  try {
    await runTool("ffmpeg", await mediaToolPath("ffmpeg"), buildArgs(scratch.inputPath, out), {
      timeoutMs: limits.ffmpegTimeoutMs,
      maxStdoutBytes: limits.maxToolStdoutBytes,
      cwd: scratch.dir,
    })
    await scratch.seal()
    return await readScratchOutput(
      scratch.dir,
      outputName,
      sandboxIdentity()?.uid ?? null,
      limits.maxChildOutputBytes,
    )
  } finally {
    await scratch.cleanup()
  }
}

export async function remuxStripMetadata(bytes: Uint8Array, limits: WorkerLimits): Promise<Buffer> {
  return runFfmpegToScratchOutput(bytes, REMUX_OUTPUT, limits, (inputPath, out) => [
    ...QUIET_ARGS,
    ...SAFE_INPUT_ARGS,
    "-i",
    inputPath,
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c",
    "copy",
    "-metadata",
    "location=",
    "-metadata",
    "location-eng=",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-y",
    out,
  ])
}

export async function grabFrameJpeg(
  bytes: Uint8Array,
  atSec: number,
  limits: WorkerLimits,
): Promise<Buffer> {
  const seek = Number.isFinite(atSec) && atSec > 0 ? atSec.toFixed(SEEK_DECIMALS) : "0"
  return runFfmpegToScratchOutput(bytes, FRAME_OUTPUT, limits, (inputPath, out) => [
    ...QUIET_ARGS,
    ...SAFE_INPUT_ARGS,
    "-max_pixels",
    String(limits.maxVideoPixels),
    "-threads",
    "1",
    "-ss",
    seek,
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-an",
    "-map_metadata",
    "-1",
    "-f",
    "image2",
    "-y",
    out,
  ])
}
