import { constants } from "node:fs"
import { open, readlink } from "node:fs/promises"
import { dirname } from "node:path"

export type SafeRead =
  { kind: "ok"; bytes: Buffer } | { kind: "missing" } | { kind: "rejected"; why: string }

/**
 * Reads a file `filer` could have planted or swapped, as `node`: never through a symlink (O_NOFOLLOW),
 * never blocking on a FIFO (O_NONBLOCK), a regular file only, within `maxBytes`, and only when the file
 * actually opened sits directly in `parentDir` (a real path), whatever a parent directory pointed at.
 */
export async function readContainedFile(
  path: string,
  opts: { maxBytes: number; parentDir: string },
): Promise<SafeRead> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === "ENOENT" ? { kind: "missing" } : { kind: "rejected", why: `open: ${code}` }
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return { kind: "rejected", why: "not a regular file" }
    if (st.size > opts.maxBytes)
      return { kind: "rejected", why: `larger than ${opts.maxBytes} bytes` }
    const opened = await readlink(`/proc/self/fd/${handle.fd}`)
    if (dirname(opened) !== opts.parentDir)
      return { kind: "rejected", why: "outside its directory" }
    const buffer = Buffer.alloc(opts.maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > opts.maxBytes)
      return { kind: "rejected", why: `larger than ${opts.maxBytes} bytes` }
    return { kind: "ok", bytes: buffer.subarray(0, bytesRead) }
  } finally {
    await handle.close()
  }
}
