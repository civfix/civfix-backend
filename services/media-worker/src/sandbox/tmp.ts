
import { constants, open, chmod, chown, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sandboxIdentity } from "./exec.js"

const SCRATCH_PREFIX = "civfix-media-"

export class ScratchOutputError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "ScratchOutputError"
    Object.setPrototypeOf(this, ScratchOutputError.prototype)
  }
}

export interface Scratch {
  dir: string
  inputPath: string
  outPath(name: string): string
  seal(): Promise<void>
  cleanup(): Promise<void>
}

export async function makeScratch(bytes?: Uint8Array, ext = "bin"): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX))
  const safeExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext : "bin"
  const inputPath = join(dir, `input.${safeExt}`)
  const identity = sandboxIdentity()
  if (identity !== null) {
    try {
      await chown(dir, process.getuid?.() ?? -1, identity.gid)
      await chmod(dir, 0o2770)
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }
  if (bytes !== undefined) {
    try {
      await writeFile(inputPath, bytes)
      if (identity !== null) await chmod(inputPath, 0o660)
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }
  let cleaned = false
  return {
    dir,
    inputPath,
    outPath(name: string): string {
      const safe = name.replace(/[^a-z0-9._-]/gi, "_")
      return join(dir, safe)
    },
    async seal(): Promise<void> {
      await chmod(dir, 0o700)
    },
    async cleanup(): Promise<void> {
      if (cleaned) return
      cleaned = true
      await rm(dir, { recursive: true, force: true }).catch(() => {})
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
    } catch (ignored) {
      void ignored
    }
  }
  return removed
}
