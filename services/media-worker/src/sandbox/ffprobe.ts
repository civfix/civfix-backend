/**
 * Sandboxed ffprobe wrapper.
 *
 * Probes untrusted media bytes and returns a small, typed descriptor. ffprobe is a VENDORED binary
 * (ffprobe-static) invoked via the hardened runTool (args array, hard timeout, SIGKILL, maxBuffer):
 * no shell, no injection. We never trust the declared kind/content-type; the ONLY source of truth for
 * "is this really a video, and which codec" is what ffprobe reports about the actual bytes.
 *
 * The seam rule: ffprobe-static (the binary path) and execa (via exec.ts) are confined to sandbox/.
 */

import ffprobeStatic from "ffprobe-static"
import { runTool, SandboxToolError } from "./exec.js"
import { makeScratch } from "./tmp.js"
import type { WorkerLimits } from "../config.js"

export interface ProbeResult {
  /** Duration in seconds (0 when ffprobe could not determine it). */
  durationSec: number
  /** Primary video codec_name (e.g. "h264", "hevc"), or null when there is no video stream. */
  codec: string | null
  /** Video width in pixels, or null. */
  width: number | null
  /** Video height in pixels, or null. */
  height: number | null
  /** True when at least one video stream is present. */
  isVideo: boolean
  /** Container/format short name as ffprobe reports it (e.g. "mov,mp4,m4a,3gp,3g2,mj2"). */
  container: string | null
}

/** Resolve the vendored ffprobe binary path. ffprobe-static exports { path }. */
function ffprobeBinary(): string {
  const p = (ffprobeStatic as { path: string }).path
  if (!p) throw new SandboxToolError("ffprobe", { timedOut: false, exitCode: null, stderrTail: "" })
  return p
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
}

interface FfprobeFormat {
  duration?: string
  format_name?: string
}

interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

function num(v: string | undefined): number {
  if (v === undefined) return 0
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Probe `bytes`. Stages them to a private temp file (seekable input, needed for accurate mp4 moov
 * parsing), runs `ffprobe -show_format -show_streams -print_format json`, and parses the result.
 * Throws SandboxToolError on timeout / non-zero exit / spawn failure or when output is not parseable.
 */
export async function probeBytes(bytes: Uint8Array, limits: WorkerLimits): Promise<ProbeResult> {
  const scratch = await makeScratch(bytes, "bin")
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      // Limit probing work so a pathological file cannot make ffprobe scan forever within the timeout.
      "-analyzeduration",
      "10000000", // 10s of stream time
      "-probesize",
      "10000000", // 10 MB
      scratch.inputPath,
    ]
    const res = await runTool("ffprobe", ffprobeBinary(), args, {
      timeoutMs: limits.ffprobeTimeoutMs,
      maxBuffer: limits.maxChildOutputBytes,
    })

    let parsed: FfprobeJson
    try {
      parsed = JSON.parse(res.stdout) as FfprobeJson
    } catch (err) {
      throw new SandboxToolError("ffprobe", {
        timedOut: false,
        exitCode: 0,
        stderrTail: "unparseable ffprobe json",
        cause: err,
      })
    }

    const streams = parsed.streams ?? []
    const video = streams.find((s) => s.codec_type === "video")
    const isVideo = video !== undefined

    const durationSec = num(parsed.format?.duration) || num(video?.duration)

    return {
      durationSec,
      codec: video?.codec_name ?? null,
      width: typeof video?.width === "number" ? video.width : null,
      height: typeof video?.height === "number" ? video.height : null,
      isVideo,
      container: parsed.format?.format_name ?? null,
    }
  } finally {
    await scratch.cleanup()
  }
}
