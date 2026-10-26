import { randomUUID } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { FilerLog } from "./config.js"

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

export async function forgetProved(
  workspaceDir: string,
  host: string,
  log: FilerLog,
  why: string,
): Promise<void> {
  await rm(recordPath(workspaceDir, host), { force: true })
  log("filer: proved record deleted", { host, why })
}

export async function forgetAllProved(workspaceDir: string, log: FilerLog, why: string) {
  for (const host of await readdir(join(workspaceDir, PROVED_DIR))) {
    await forgetProved(workspaceDir, host, log, why)
  }
}
