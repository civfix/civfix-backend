import type { FilerProcessResult } from "./filer-process.js"

export type ClaudeOutcome =
  | { kind: "ok"; result: string }
  | { kind: "failed"; reason: "ai_unavailable" | "portal_error"; why: string }

export function claudeOutcome(exit: FilerProcessResult): ClaudeOutcome {
  void exit
  throw new Error("not implemented")
}
