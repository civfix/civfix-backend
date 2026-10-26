import type { FilerLog } from "./config.js"

export interface PruneOptions {
  now: Date
  log: FilerLog
}

export function pruneRunDirs(_workspaceDir: string, _opts: PruneOptions): Promise<void> {
  throw new Error("not implemented")
}
