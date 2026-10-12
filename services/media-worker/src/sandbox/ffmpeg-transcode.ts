import { runTool, sandboxIdentity } from "./exec.js"
import { mediaToolPath } from "./binaries.js"
import { makeScratch, readScratchOutput } from "./tmp.js"
import {
  SERVED_VIDEO_MAX_EDGE,
  SERVED_VIDEO_MAX_FPS,
  videoDecoderMaxPixels,
  type WorkerLimits,
} from "../config.js"

const SAFE_INPUT_ARGS = ["-protocol_whitelist", "file", "-f", "mov"] as const

const TRANSCODE_OUTPUT = "out.mp4"

interface TranscodeOptions {
  capFps: boolean
}

// One transcode at a time, the rest wait their turn. Process-local is enough because compose runs a
// single media-worker; a second replica would need a queue-level limit instead.
let transcodeTail: Promise<unknown> = Promise.resolve()

function inTranscodeSlot<T>(run: () => Promise<T>): Promise<T> {
  const result = transcodeTail.then(run)
  transcodeTail = result.catch(() => undefined)
  return result
}

// Long edge capped, never enlarged, both edges even (yuv420p needs it). It runs after the rotation the
// ffmpeg CLI applies on its own, so it measures the clip the way it is displayed.
function scaleFilter(): string {
  const capped = (edge: string) => `trunc(min(${SERVED_VIDEO_MAX_EDGE},${edge})/2)*2`
  return `scale=w='if(gte(iw,ih),${capped("iw")},-2)':h='if(gte(iw,ih),-2,${capped("ih")})'`
}

function transcodeFilterGraph(opts: TranscodeOptions): string {
  return [
    scaleFilter(),
    ...(opts.capFps ? [`fps=${SERVED_VIDEO_MAX_FPS}`] : []),
    "format=yuv420p",
  ].join(",")
}

export async function transcodeToServedMp4(
  bytes: Uint8Array,
  opts: TranscodeOptions,
  limits: WorkerLimits,
): Promise<Buffer> {
  return inTranscodeSlot(async () => {
    const scratch = await makeScratch(bytes, "bin")
    const out = scratch.outPath(TRANSCODE_OUTPUT)
    try {
      const threads = String(limits.transcodeThreads)
      const maxrate = String(limits.servedVideoMaxBitrateBps)
      const bufsize = String(limits.servedVideoMaxBitrateBps * 2)
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-filter_threads",
        "1",
        ...SAFE_INPUT_ARGS,
        "-max_pixels",
        String(videoDecoderMaxPixels(limits)),
        "-threads",
        threads,
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
        "-vf",
        transcodeFilterGraph(opts),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-threads",
        threads,
        "-c:a",
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
        timeoutMs: limits.transcodeTimeoutMs,
        maxStdoutBytes: limits.maxToolStdoutBytes,
        cwd: scratch.dir,
        lowPriority: true,
      })
      await scratch.seal()
      return await readScratchOutput(
        scratch.dir,
        TRANSCODE_OUTPUT,
        sandboxIdentity()?.uid ?? null,
        limits.maxChildOutputBytes,
      )
    } finally {
      await scratch.cleanup()
    }
  })
}
