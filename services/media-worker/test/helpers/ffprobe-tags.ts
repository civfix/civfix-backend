
import ffprobeStatic from "ffprobe-static"
import { runTool } from "../../src/sandbox/exec.js"
import { makeScratch } from "../../src/sandbox/tmp.js"

export async function readContainerTags(bytes: Uint8Array): Promise<Record<string, string>> {
  const scratch = await makeScratch(bytes, "bin")
  try {
    const res = await runTool(
      "ffprobe",
      (ffprobeStatic as unknown as { path: string }).path,
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
  tags: Record<string, string>
}

export async function readStreamTags(bytes: Uint8Array): Promise<StreamInfo[]> {
  const scratch = await makeScratch(bytes, "bin")
  try {
    const res = await runTool(
      "ffprobe",
      (ffprobeStatic as unknown as { path: string }).path,
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
      streams?: { codec_type?: string; tags?: Record<string, string> }[]
    }
    return (parsed.streams ?? []).map((s) => ({
      codecType: s.codec_type ?? "unknown",
      tags: s.tags ?? {},
    }))
  } finally {
    await scratch.cleanup()
  }
}
