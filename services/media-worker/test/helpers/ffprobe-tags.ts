import { mediaToolPath } from "../../src/sandbox/binaries.js"
import { runTool } from "../../src/sandbox/exec.js"
import { makeScratch } from "../../src/sandbox/tmp.js"

export async function readContainerTags(bytes: Uint8Array): Promise<Record<string, string>> {
  const scratch = await makeScratch(bytes, "bin")
  try {
    const res = await runTool(
      "ffprobe",
      await mediaToolPath("ffprobe"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-protocol_whitelist",
        "file",
        scratch.inputPath,
      ],
      { timeoutMs: 10_000, maxStdoutBytes: 1024 * 1024 },
    )
    const parsed = JSON.parse(res.stdout) as { format?: { tags?: Record<string, string> } }
    return parsed.format?.tags ?? {}
  } finally {
    await scratch.cleanup()
  }
}

export interface StreamInfo {
  codecType: string
  codecName: string | null
  width: number | null
  height: number | null
  avgFrameRate: string | null
  rotation: number | null
  tags: Record<string, string>
}

export async function readStreamTags(bytes: Uint8Array): Promise<StreamInfo[]> {
  const scratch = await makeScratch(bytes, "bin")
  try {
    const res = await runTool(
      "ffprobe",
      await mediaToolPath("ffprobe"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-protocol_whitelist",
        "file",
        scratch.inputPath,
      ],
      { timeoutMs: 10_000, maxStdoutBytes: 1024 * 1024 },
    )
    const parsed = JSON.parse(res.stdout) as {
      streams?: {
        codec_type?: string
        codec_name?: string
        width?: number
        height?: number
        avg_frame_rate?: string
        side_data_list?: { rotation?: number }[]
        tags?: Record<string, string>
      }[]
    }
    return (parsed.streams ?? []).map((s) => ({
      codecType: s.codec_type ?? "unknown",
      codecName: s.codec_name ?? null,
      width: s.width ?? null,
      height: s.height ?? null,
      avgFrameRate: s.avg_frame_rate ?? null,
      rotation: s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? null,
      tags: s.tags ?? {},
    }))
  } finally {
    await scratch.cleanup()
  }
}

/** Top-level ISO-BMFF box types in file order (faststart puts moov before mdat). */
export function topLevelBoxes(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes)
  const types: string[] = []
  let at = 0
  while (at + 8 <= buf.length) {
    const size32 = buf.readUInt32BE(at)
    const type = buf.toString("latin1", at + 4, at + 8)
    const size =
      size32 === 1 ? Number(buf.readBigUInt64BE(at + 8)) : size32 === 0 ? buf.length - at : size32
    if (size < 8) break
    types.push(type)
    at += size
  }
  return types
}
