import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import type { FilerLog } from "./config.js"
import { readContainedFile } from "./safe-file.js"
import { isPortalHost } from "./script.js"

/**
 * Per host, the fingerprint of the host's folder as it was when its script last passed the wrapper's own
 * proof (D7 step 3: only a proved script runs live without Claude). `proved/` is node's (0755): filer can
 * read it but never write a record, so nothing Claude does can make an unproved script run live.
 */
const PROVED_DIR = "proved"
const SHA256_HEX = /^[0-9a-f]{64}$/

const recordPath = (workspaceDir: string, host: string) => join(workspaceDir, PROVED_DIR, host)

/** At start: a volume made by an older image has no proved/ yet. */
export async function ensureProvedDir(workspaceDir: string): Promise<void> {
  const dir = join(workspaceDir, PROVED_DIR)
  try {
    await mkdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return
    throw err
  }
  // mkdir's mode is cut by the process umask (0007); filer reads records, so the mode is set outright.
  await chmod(dir, 0o755)
}

/**
 * The host's proved fingerprint; null when there is none, it can't be read or it is not a well-formed
 * record, which all mean the same: the script goes through Claude and the proof before it runs live.
 */
export async function readProved(workspaceDir: string, host: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(recordPath(workspaceDir, host), "utf8")
  } catch {
    return null
  }
  const fingerprint = text.trim()
  return SHA256_HEX.test(fingerprint) ? fingerprint : null
}

export type PortalFingerprint =
  { kind: "ok"; fingerprint: string } | { kind: "rejected"; why: string }

const FOLDER_MAX_ENTRIES = 500
const FOLDER_MAX_BYTES = 20 * 1024 * 1024

interface FolderEntry {
  path: Buffer
  size: number | null
}

const lengthPrefix = (n: number): Buffer => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(n))
  return out
}

/**
 * Every entry under portals/<host>/, read as node without trusting it, sorted by path bytes: what a script
 * there can import is all of it, not only script.mjs. A name that isn't UTF-8 (it wouldn't name one file),
 * anything but a regular file or a directory, and a folder past the entry or byte cap are rejected.
 */
async function folderEntries(hostDir: string): Promise<FolderEntry[] | string> {
  const entries: FolderEntry[] = []
  let bytes = 0
  const dirs = [""]
  for (let rel = dirs.pop(); rel !== undefined; rel = dirs.pop()) {
    for (const raw of await readdir(join(hostDir, rel), { encoding: "buffer" })) {
      const name = raw.toString("utf8")
      if (!Buffer.from(name, "utf8").equals(raw)) return "a name that is not UTF-8"
      const path = rel === "" ? name : `${rel}/${name}`
      if (entries.length === FOLDER_MAX_ENTRIES) return `more than ${FOLDER_MAX_ENTRIES} entries`
      const st = await lstat(join(hostDir, path))
      if (st.isDirectory()) {
        entries.push({ path: Buffer.from(path, "utf8"), size: null })
        dirs.push(path)
      } else if (st.isFile()) {
        bytes += st.size
        if (bytes > FOLDER_MAX_BYTES) return `more than ${FOLDER_MAX_BYTES} bytes`
        entries.push({ path: Buffer.from(path, "utf8"), size: st.size })
      } else {
        return `${path} is not a regular file or a directory`
      }
    }
  }
  return entries.sort((a, b) => Buffer.compare(a.path, b.path))
}

/**
 * The sha256 fingerprint of portals/<host>/ that a proved record holds: each entry in path-byte order as
 * "d", or "f", with its length-prefixed path and, for a file, its length-prefixed bytes, so no two trees
 * share one. A file is read only where it really sits (`readContainedFile`) and no larger than it was
 * listed. Any failure is "rejected", which a caller treats as unproved.
 */
export async function fingerprintPortal(
  workspaceDir: string,
  host: string,
): Promise<PortalFingerprint> {
  try {
    const hostDir = join(await realpath(join(workspaceDir, "portals")), host)
    if (!(await lstat(hostDir)).isDirectory()) {
      return { kind: "rejected", why: "the host entry is not a directory" }
    }
    const entries = await folderEntries(hostDir)
    if (typeof entries === "string") return { kind: "rejected", why: entries }
    const hash = createHash("sha256")
    for (const { path, size } of entries) {
      hash
        .update(size === null ? "d" : "f")
        .update(lengthPrefix(path.length))
        .update(path)
      if (size === null) continue
      const file = join(hostDir, path.toString("utf8"))
      const read = await readContainedFile(file, { maxBytes: size, parentDir: dirname(file) })
      if (read.kind !== "ok") {
        return {
          kind: "rejected",
          why: `${path.toString("utf8")}: ${read.kind === "rejected" ? read.why : "gone"}`,
        }
      }
      hash.update(lengthPrefix(read.bytes.length)).update(read.bytes)
    }
    return { kind: "ok", fingerprint: hash.digest("hex") }
  } catch (err) {
    return { kind: "rejected", why: err instanceof Error ? err.message : String(err) }
  }
}

export async function recordProved(
  workspaceDir: string,
  host: string,
  fingerprint: string,
): Promise<void> {
  const tmp = join(workspaceDir, PROVED_DIR, `.${host}.${randomUUID()}.tmp`)
  await writeFile(tmp, `${fingerprint}\n`, { flag: "wx", mode: 0o644 })
  await rename(tmp, recordPath(workspaceDir, host))
}

/**
 * Deletes the records of `hosts`, or every record, trying each before it throws, so a record that can't be
 * deleted never keeps the others in place. A name that isn't a portal host is refused, never joined into
 * a path (an empty one would name proved/ itself).
 */
export async function forgetProved(
  workspaceDir: string,
  hosts: readonly string[] | "all",
  log: FilerLog,
  why: string,
): Promise<void> {
  const dir = join(workspaceDir, PROVED_DIR)
  const names = hosts === "all" ? await readdir(dir) : hosts
  const failures: unknown[] = []
  for (const name of new Set(names)) {
    try {
      if (hosts !== "all" && !isPortalHost(name)) {
        throw new Error(`not a portal host: ${JSON.stringify(name)}`)
      }
      await rm(join(dir, name), { force: true })
      log("filer: proved record deleted", { host: name, why })
    } catch (err) {
      failures.push(err)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "a proved record was not deleted")
}
