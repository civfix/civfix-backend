import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { MS_PER_DAY } from "@civfix/api/time"
import type { FilerLog } from "./config.js"

const RUN_DIR_MAX_AGE_MS = 30 * MS_PER_DAY

export interface PruneOptions {
  now: Date
  log: FilerLog
}

/** Deletes run directories over 30 days old (D16): R2 evidence is the record. portals/ is never read. */
export async function pruneRunDirs(workspaceDir: string, opts: PruneOptions): Promise<void> {
  const runs = join(workspaceDir, "runs")
  for (const name of await readdir(runs)) {
    const path = join(runs, name)
    const st = await lstat(path)
    if (!st.isDirectory() || opts.now.getTime() - st.mtimeMs <= RUN_DIR_MAX_AGE_MS) continue
    try {
      await rm(path, { recursive: true })
    } catch (err) {
      // filer can make an entry inside out/ that node may not remove; the rest of the prune goes on.
      opts.log("filer: could not delete a run directory", {
        name,
        code: (err as NodeJS.ErrnoException).code,
      })
    }
  }
}
