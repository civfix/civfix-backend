/**
 * Scratch-file helpers for the sandbox.
 *
 * ffprobe/ffmpeg work most reliably on a SEEKABLE file (container probing reads the moov atom, which
 * for mp4 can live at the end). We therefore stage untrusted bytes to a private temp file under a
 * per-call directory, run the tool, and ALWAYS clean up (even on throw). The directory name is random
 * (mkdtemp), so there is no predictable path an attacker could pre-create or race.
 *
 * No vendor SDKs here; just node:fs/os/path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface Scratch {
  /** The private temp directory (caller may place outputs here too). */
  dir: string
  /** Absolute path to the staged input file (present only when bytes were provided). */
  inputPath: string
  /** Build a path for an output file inside the scratch dir. */
  outPath(name: string): string
  /** Remove the whole scratch directory. Idempotent; never throws. */
  cleanup(): Promise<void>
}

/**
 * Create a scratch dir and (optionally) stage `bytes` into `input.<ext>`. The returned `cleanup` MUST
 * be awaited in a finally block by the caller.
 */
export async function makeScratch(bytes?: Uint8Array, ext = "bin"): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), "civfix-media-"))
  const safeExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext : "bin"
  const inputPath = join(dir, `input.${safeExt}`)
  if (bytes !== undefined) {
    await writeFile(inputPath, bytes)
  }
  let cleaned = false
  return {
    dir,
    inputPath,
    outPath(name: string): string {
      // name is a fixed worker-chosen literal (never user input), but sanitize defensively.
      const safe = name.replace(/[^a-z0-9._-]/gi, "_")
      return join(dir, safe)
    },
    async cleanup(): Promise<void> {
      if (cleaned) return
      cleaned = true
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
