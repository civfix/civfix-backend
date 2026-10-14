import { runTool, SandboxToolError } from "./exec.js"
import { mediaToolPath } from "./binaries.js"
import { makeScratch } from "./tmp.js"
import type { WorkerLimits } from "../config.js"

export interface ProbeResult {
  durationSec: number
  codec: string | null
  width: number | null
  height: number | null
  fps: number | null
  bitrateBps: number | null
  isVideo: boolean
}

const ALLOWED_DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2"

const ANALYZE_DURATION_US = "2000000"
const PROBE_SIZE_BYTES = "5000000"

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  bit_rate?: string
}

interface FfprobeFormat {
  duration?: string
  bit_rate?: string
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

function frameRate(...candidates: (string | undefined)[]): number | null {
  for (const raw of candidates) {
    if (raw === undefined) continue
    const [numerator, denominator] = raw.split("/")
    const n = Number.parseFloat(numerator ?? "")
    const d = denominator === undefined ? 1 : Number.parseFloat(denominator)
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) continue
    return n / d
  }
  return null
}

function bitrate(...candidates: (string | undefined)[]): number | null {
  for (const raw of candidates) {
    const n = num(raw)
    if (n > 0) return n
  }
  return null
}

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
      "-analyzeduration",
      ANALYZE_DURATION_US,
      "-probesize",
      PROBE_SIZE_BYTES,
      "-f",
      ALLOWED_DEMUXERS,
      "-protocol_whitelist",
      "file",
      scratch.inputPath,
    ]
    const res = await runTool("ffprobe", await mediaToolPath("ffprobe"), args, {
      timeoutMs: limits.ffprobeTimeoutMs,
      maxStdoutBytes: limits.maxToolStdoutBytes,
      cwd: scratch.dir,
    })

    return toProbeResult(parseProbeJson(res.stdout))
  } finally {
    await scratch.cleanup()
  }
}

function parseProbeJson(stdout: string): FfprobeJson {
  try {
    return JSON.parse(stdout) as FfprobeJson
  } catch (err) {
    throw new SandboxToolError("ffprobe", {
      timedOut: false,
      exitCode: 0,
      stderrTail: "unparseable ffprobe json",
      cause: err,
    })
  }
}

function toProbeResult(parsed: FfprobeJson): ProbeResult {
  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === "video")
  return {
    durationSec: num(parsed.format?.duration) || num(video?.duration),
    codec: video?.codec_name ?? null,
    width: typeof video?.width === "number" ? video.width : null,
    height: typeof video?.height === "number" ? video.height : null,
    fps: frameRate(video?.avg_frame_rate, video?.r_frame_rate),
    bitrateBps: bitrate(video?.bit_rate, parsed.format?.bit_rate),
    isVideo: video !== undefined,
  }
}
