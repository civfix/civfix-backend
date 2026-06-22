/**
 * Sandboxed ffmpeg wrappers: metadata-stripping stream-copy remux + a single-frame thumbnail grab.
 *
 * Neither operation re-encodes video (we never run an untrusted decoder over a full transcode budget):
 *   - remux: `-map_metadata -1 -c copy` copies the elementary streams byte-for-byte into a fresh
 *     container with ALL global/stream/chapter metadata dropped. That removes GPS/location tags,
 *     creation-time, device make/model, etc. We additionally pass `-map_chapters -1` and (where the
 *     source carries a display-matrix rotation side-data) keep the stream's rotation by NOT stripping
 *     the matrix: with `-c copy` the rotation side-data travels with the copied packets, so playback
 *     orientation is preserved while textual/location metadata is gone. `+faststart` moves the moov
 *     atom to the front for streaming.
 *   - thumbnail: seek to a small offset and decode exactly ONE frame to a JPEG. This is a single-frame
 *     decode (bounded), not a transcode, and is sized down by sharp afterwards in the image path.
 *
 * ffmpeg is the VENDORED ffmpeg-static binary, invoked via the hardened runTool (args array, hard
 * timeout, SIGKILL, maxBuffer). No shell, no injection. Confined to sandbox/ per the seam rule.
 */

import ffmpegPath from "ffmpeg-static"
import { readFile } from "node:fs/promises"
import { runTool, SandboxToolError } from "./exec.js"
import { makeScratch } from "./tmp.js"
import type { WorkerLimits } from "../config.js"

/** Resolve the vendored ffmpeg binary path. ffmpeg-static's default export is the path string. */
function ffmpegBinary(): string {
  const p = ffmpegPath as unknown as string | null
  if (!p) throw new SandboxToolError("ffmpeg", { timedOut: false, exitCode: null, stderrTail: "" })
  return p
}

/**
 * SECURITY input hardening shared by remux + thumbnail (extracted so the guard can't drift between them):
 * restrict input protocols to "file" (no http/tcp/rtmp/concat:/data:, so a crafted body cannot make
 * ffmpeg fetch remote URLs — SSRF) and FORCE the input demuxer to the mov/mp4 family (the only containers
 * intake accepts and ffprobe has confirmed), so an attacker body that is really an HLS playlist / ffconcat
 * list cannot select a demuxer that reads arbitrary local files (file:) into the output. These MUST
 * precede -i to apply to the input. (The thumbnail's input-side -ss seek goes BETWEEN this prefix and -i.)
 */
const SAFE_INPUT_ARGS = ["-protocol_whitelist", "file", "-f", "mov"] as const

/**
 * Stream-copy remux `bytes` into a fresh MP4 with all metadata/location stripped and orientation
 * preserved. Returns the remuxed bytes. Throws SandboxToolError on failure/timeout.
 */
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
      // Drop ALL metadata (global + per-stream) and chapters: this is what removes GPS/location.
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      // Copy every stream byte-for-byte (no re-encode). Rotation display-matrix side-data rides along.
      "-map",
      "0",
      "-c",
      "copy",
      // Strip any leftover container-level location/handler tags explicitly (belt and suspenders).
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

/**
 * Grab a single frame from `bytes` as a JPEG (the raw, full-size frame). The image path then strips
 * EXIF and downsizes it to the thumbnail. Seeks to `atSec` (clamped within the clip). Throws on
 * failure/timeout.
 */
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
      // Input-side seek (fast) to the requested time. Stays AFTER the SSRF prefix, BEFORE -i.
      "-ss",
      seek,
      "-i",
      scratch.inputPath,
      // Exactly one frame, no audio, drop metadata on the output image too.
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
