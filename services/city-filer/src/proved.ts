import { randomUUID } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { FilerLog } from "./config.js"
import { isPortalHost } from "./script.js"

/**
 * Per host, the sha256 of the script bytes that last passed the wrapper's own proof (D7 step 3: only a
 * proved script runs live without Claude). `proved/` is node's (0755): filer can read it but never write a
 * record, so nothing Claude does can make an unproved script run live.
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
 * The host's proved sha256; null when there is none, it can't be read or it is not a well-formed record,
 * which all mean the same: the script goes through Claude and the proof before it runs live.
 */
export async function readProved(workspaceDir: string, host: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(recordPath(workspaceDir, host), "utf8")
  } catch {
    return null
  }
  const sha256 = text.trim()
  return SHA256_HEX.test(sha256) ? sha256 : null
}

export async function recordProved(
  workspaceDir: string,
  host: string,
  sha256: string,
): Promise<void> {
  const tmp = join(workspaceDir, PROVED_DIR, `.${host}.${randomUUID()}.tmp`)
  await writeFile(tmp, `${sha256}\n`, { flag: "wx", mode: 0o644 })
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
