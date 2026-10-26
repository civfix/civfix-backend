import { z } from "zod"
import type { FilerProcessResult } from "./filer-process.js"

export type ClaudeOutcome =
  | { kind: "ok"; result: string }
  | { kind: "failed"; reason: "ai_unavailable" | "portal_error"; why: string }

/** `--output-format json`'s one object; only these two fields decide anything. */
const ClaudeJsonSchema = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
})

// What the CLI says when both accounts are out of usage or a login is gone (D9). Refined from prod logs.
const UNAVAILABLE =
  /\b(usage|rate)[ _-]?limit|\blimit reached|\bcredit|\blog ?in\b|\/login|authenticat|\boauth\b|api[ _-]?key|unauthori[sz]ed/i

const WHY_MAX_CHARS = 300

function parseOutput(stdout: string): z.infer<typeof ClaudeJsonSchema> | null {
  const lastLine = stdout.trim().split("\n").at(-1) ?? ""
  for (const candidate of [stdout, lastLine]) {
    try {
      const parsed = ClaudeJsonSchema.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      // Not JSON; the next candidate, or no output at all.
    }
  }
  return null
}

/**
 * The one place a Claude exit is judged (D9): a usage limit or a login problem is `ai_unavailable`, which
 * the API requeues without spending an attempt; anything else that went wrong is `portal_error`.
 */
export function claudeOutcome(exit: FilerProcessResult): ClaudeOutcome {
  if (exit.timedOut) return { kind: "failed", reason: "portal_error", why: "timed out" }
  const out = parseOutput(exit.stdout)
  if (out !== null && exit.exitCode === 0 && !out.is_error) {
    return { kind: "ok", result: out.result ?? "" }
  }
  const text = [out?.result ?? "", exit.stderrTail].join("\n").trim()
  const why = (text === "" ? `exited ${exit.exitCode}` : text).slice(0, WHY_MAX_CHARS)
  return { kind: "failed", reason: UNAVAILABLE.test(text) ? "ai_unavailable" : "portal_error", why }
}
