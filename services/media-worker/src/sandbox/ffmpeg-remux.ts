import { runTool, sandboxIdentity } from "./exec.js"
import { mediaToolPath } from "./binaries.js"
import { makeScratch, readScratchOutput } from "./tmp.js"
import type { WorkerLimits } from "../config.js"

const SAFE_INPUT_ARGS = ["-protocol_whitelist", "file", "-f", "mov"] as const

const REMUX_OUTPUT = "out.mp4"
const FRAME_OUTPUT = "frame.jpg"

export async function remuxStripMetadata(bytes: Uint8Array, limits: WorkerLimits): Promise<Buffer> {
  const scratch = await makeScratch(bytes, "bin")
  const out = scratch.outPath(REMUX_OUTPUT)
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...SAFE_INPUT_ARGS,
      "-i",
      scratch.inputPath,
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
    ]
    await runTool("ffmpeg", await mediaToolPath("ffmpeg"), args, {
      timeoutMs: limits.ffmpegTimeoutMs,
      maxStdoutBytes: limits.maxToolStdoutBytes,
      cwd: scratch.dir,
    })
    await scratch.seal()
    return await readScratchOutput(
      scratch.dir,
      REMUX_OUTPUT,
      sandboxIdentity()?.uid ?? null,
      limits.maxChildOutputBytes,
    )
  } finally {
    await scratch.cleanup()
  }
}

export async function grabFrameJpeg(
  bytes: Uint8Array,
  atSec: number,
  limits: WorkerLimits,
): Promise<Buffer> {
  const scratch = await makeScratch(bytes, "bin")
  const out = scratch.outPath(FRAME_OUTPUT)
  try {
    const seek = Number.isFinite(atSec) && atSec > 0 ? atSec.toFixed(3) : "0"
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...SAFE_INPUT_ARGS,
      "-max_pixels",
      String(limits.maxVideoPixels),
      "-threads",
      "1",
      "-ss",
      seek,
      "-i",
      scratch.inputPath,
      "-frames:v",
      "1",
      "-an",
      "-map_metadata",
      "-1",
      "-f",
      "image2",
      "-y",
      out,
    ]
    await runTool("ffmpeg", await mediaToolPath("ffmpeg"), args, {
      timeoutMs: limits.ffmpegTimeoutMs,
      maxStdoutBytes: limits.maxToolStdoutBytes,
      cwd: scratch.dir,
    })
    await scratch.seal()
    return await readScratchOutput(
      scratch.dir,
      FRAME_OUTPUT,
      sandboxIdentity()?.uid ?? null,
      limits.maxChildOutputBytes,
    )
  } finally {
    await scratch.cleanup()
  }
}
