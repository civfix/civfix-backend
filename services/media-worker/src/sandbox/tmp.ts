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

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Prefix for every per-call scratch directory (must stay in sync with the mkdtemp prefix below). */
const SCRATCH_PREFIX = "civfix-media-"

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
  const dir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX))
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

/**
 * Boot-time backstop: per-call cleanup() runs in a finally, but a SIGKILL mid-pipeline (e.g. an OOM kill)
 * skips it, leaking scratch dirs that accumulate in a long-running worker. On startup, remove any
 * civfix-media-* dir older than `maxAgeMs` (default 1h, comfortably above the per-job budget so an
 * in-flight job's dir is never reaped). Never throws.
 */
export async function sweepStaleScratchDirs(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  const root = tmpdir()
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue
    const full = join(root, name)
    try {
      const s = await stat(full)
      if (s.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true })
        removed++
      }
    } catch {
      // A racing concurrent worker removed it, or a permission issue: skip.
    }
  }
  return removed
}
