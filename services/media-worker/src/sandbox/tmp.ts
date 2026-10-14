import {
  constants,
  open,
  chmod,
  chown,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sandboxIdentity } from "./exec.js"

const SCRATCH_PREFIX = "civfix-media-"
const SCRATCH_STALE_MS = 60 * 60 * 1000
const DEFAULT_INPUT_EXT = "bin"
const SAFE_EXT_PATTERN = /^[a-z0-9]{1,8}$/i
const UNSAFE_NAME_CHARS = /[^a-z0-9._-]/gi
// Group-writable (setgid, so outputs inherit the sandbox group) while the sandboxed child writes;
// owner-only once sealed for the read-back.
const SHARED_DIR_MODE = 0o2770
const SHARED_INPUT_MODE = 0o660
const SEALED_DIR_MODE = 0o700

export class ScratchOutputError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "ScratchOutputError"
    Object.setPrototypeOf(this, ScratchOutputError.prototype)
  }
}

// Raised when the worker itself cannot build or hand over the scratch dir (full tmpfs, EMFILE, a wrong
// sandbox gid). The upload never reached a decoder, so the job must retry instead of rejecting the bytes.
export class ScratchSetupError extends Error {
  constructor(message: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`${message}: ${detail}`, { cause })
    this.name = "ScratchSetupError"
    Object.setPrototypeOf(this, ScratchSetupError.prototype)
  }
}

export interface Scratch {
  dir: string
  inputPath: string
  outPath(name: string): string
  seal(): Promise<void>
  cleanup(): Promise<void>
}

export async function makeScratch(bytes?: Uint8Array, ext = DEFAULT_INPUT_EXT): Promise<Scratch> {
  let dir: string
  try {
    dir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX))
  } catch (err) {
    throw new ScratchSetupError("could not create the sandbox scratch dir", err)
  }
  const safeExt = SAFE_EXT_PATTERN.test(ext) ? ext : DEFAULT_INPUT_EXT
  const inputPath = join(dir, `input.${safeExt}`)
  try {
    const identity = sandboxIdentity()
    if (identity !== null) {
      await chown(dir, process.getuid?.() ?? -1, identity.gid)
      await chmod(dir, SHARED_DIR_MODE)
    }
    if (bytes !== undefined) {
      await writeFile(inputPath, bytes)
      if (identity !== null) await chmod(inputPath, SHARED_INPUT_MODE)
    }
  } catch (err) {
    await removeQuietly(dir)
    throw new ScratchSetupError("could not prepare the sandbox scratch dir", err)
  }
  let cleaned = false
  return {
    dir,
    inputPath,
    outPath(name: string): string {
      const safe = name.replace(UNSAFE_NAME_CHARS, "_")
      return join(dir, safe)
    },
    async seal(): Promise<void> {
      try {
        await chmod(dir, SEALED_DIR_MODE)
      } catch (err) {
        throw new ScratchSetupError("could not seal the sandbox scratch dir", err)
      }
    },
    async cleanup(): Promise<void> {
      if (cleaned) return
      cleaned = true
      // A dir left behind is reaped by sweepStaleScratchDirs; cleanup must never mask the job's own outcome.
      await removeQuietly(dir)
    },
  }
}

export async function readScratchOutput(
  dir: string,
  name: string,
  expectUid: number | null,
  maxBytes: number,
): Promise<Buffer> {
  const path = join(dir, name)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    throw new ScratchOutputError(`sandbox output ${name} could not be opened safely`, err)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new ScratchOutputError(`sandbox output ${name} is not a regular file`)
    }
    if (stats.nlink !== 1) {
      throw new ScratchOutputError(`sandbox output ${name} is hard-linked elsewhere`)
    }
    if (expectUid !== null && stats.uid !== expectUid) {
      throw new ScratchOutputError(`sandbox output ${name} is not owned by the sandbox uid`)
    }
    if (stats.size > maxBytes) {
      throw new ScratchOutputError(
        `sandbox output ${name} is ${stats.size} bytes, over the ${maxBytes} byte cap`,
      )
    }
    return await handle.readFile()
  } finally {
    await handle.close().catch(() => {})
  }
}

async function removeQuietly(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

export async function sweepStaleScratchDirs(maxAgeMs = SCRATCH_STALE_MS): Promise<number> {
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
    } catch (ignored) {
      // A running job's cleanup can remove the dir between readdir and stat; the next sweep retries the rest.
      void ignored
    }
  }
  return removed
}
