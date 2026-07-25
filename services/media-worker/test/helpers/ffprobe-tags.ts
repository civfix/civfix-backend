/**
 * Read the CONTAINER-LEVEL metadata tags of a media buffer (ffprobe -show_format).
 *
 * src/sandbox/ffprobe.ts deliberately returns only the typed descriptor the pipeline needs
 * (codec/size/duration/isVideo) and drops tags, so the production probe cannot answer the one question
 * the metadata-strip claim needs answered: "does `location` still exist in these bytes?". This helper is
 * the test-side probe for exactly that. It reuses the hardened runner + scratch staging from src so the
 * only extra machinery here is the JSON shape.
 */

import ffprobeStatic from "ffprobe-static"
import { runTool } from "../../src/sandbox/exec.js"
import { makeScratch } from "../../src/sandbox/tmp.js"

/** Container (format-level) tags, lowercased keys as ffprobe reports them. Empty when there are none. */
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
      { timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
    )
    const parsed = JSON.parse(res.stdout) as { format?: { tags?: Record<string, string> } }
    return parsed.format?.tags ?? {}
  } finally {
    await scratch.cleanup()
  }
}
