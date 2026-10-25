import type { FilerLog } from "./config.js"
import type { ScriptRunResult } from "./script.js"

export interface RunEnding {
  outcome: string
  reason?: string
  evidenceNames: string[]
}

export interface OutputInput {
  outDir: string
  host: string
  dryRun: boolean
  run: ScriptRunResult
  log: FilerLog
}

export interface EvidenceFile {
  name: string
  bytes: Buffer
  ext: "png" | "jpg"
  contentType: string
}

export function runEnding(input: OutputInput): Promise<RunEnding> {
  void input
  throw new Error("not implemented")
}

export function collectEvidence(
  outDir: string,
  names: readonly string[],
  log: FilerLog,
): Promise<EvidenceFile[]> {
  void [outDir, names, log]
  throw new Error("not implemented")
}
