import type { FilerRunner } from "./filer-process.js"

export const FILER_ENV_KEYS = ["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"] as const

export function filerStatusFailure(_status: string): string | null {
  throw new Error("not implemented")
}

export function envOutputFailure(_output: string, _expected: readonly string[]): string | null {
  throw new Error("not implemented")
}

export interface PreflightDeps {
  runner: FilerRunner
  workspaceDir: string
  ownStatus: () => Promise<string>
  nodeUid: number
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}

export function runPreflight(_deps: PreflightDeps): Promise<number> {
  throw new Error("not implemented")
}
