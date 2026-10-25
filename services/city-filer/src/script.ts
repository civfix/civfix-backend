import type { FilerRunner } from "./filer-process.js"

export interface ScriptRunResult {
  exitCode: number | null
  timedOut: boolean
  sentinel: boolean
  marker: boolean
}

export interface ScriptRunOptions {
  runDir: string
  host: string
  dryRun: boolean
  scriptSha256: string
  timeoutMs: number
}

export function runScript(runner: FilerRunner, opts: ScriptRunOptions): Promise<ScriptRunResult> {
  void [runner, opts]
  throw new Error("not implemented")
}
