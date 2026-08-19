
import ffmpegPath from "ffmpeg-static"
import { readFile } from "node:fs/promises"
import { runTool, SandboxToolError } from "./exec.js"
import { makeScratch } from "./tmp.js"
import type { WorkerLimits } from "../config.js"

function ffmpegBinary(): string {
  const p = ffmpegPath as unknown as string | null
  if (!p) throw new SandboxToolError("ffmpeg", { timedOut: false, exitCode: null, stderrTail: "" })
  return p
}

const SAFE_INPUT_ARGS = ["-protocol_whitelist", "file", "-f", "mov"] as const

export async function remuxStripMetadata(bytes: Uint8Array, limits: WorkerLimits): Promise<Buffer> {
  const scratch = await makeScratch(bytes, "bin")
  const out = scratch.outPath("out.mp4")
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
    await runTool("ffmpeg", ffmpegBinary(), args, {
      timeoutMs: limits.ffmpegTimeoutMs,
      maxBuffer: limits.maxChildOutputBytes,
    })
    return await readFile(out)
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
  const out = scratch.outPath("frame.jpg")
  try {
    const seek = Number.isFinite(atSec) && atSec > 0 ? atSec.toFixed(3) : "0"
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...SAFE_INPUT_ARGS,
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
    await runTool("ffmpeg", ffmpegBinary(), args, {
      timeoutMs: limits.ffmpegTimeoutMs,
      maxBuffer: limits.maxChildOutputBytes,
    })
    return await readFile(out)
  } finally {
    await scratch.cleanup()
  }
}
