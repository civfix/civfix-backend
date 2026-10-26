import { MS_PER_MINUTE } from "@civfix/api/time"
import { cleanClaudeHome } from "./claude-home.js"
import { claudeOutcome, type ClaudeOutcome } from "./claude-limits.js"
import type { FilerLog } from "./config.js"
import { runAsFiler, type FilerRunner } from "./filer-process.js"

export const CLAUDE_RUN_TIMEOUT_MS = 15 * MS_PER_MINUTE
const PLAYBOOK_DIR = "/app/playbook"
const OUTPUT_MAX_BYTES = 1024 * 1024

/** The one MCP server a filing run gets: @playwright/mcp's bin, on the image's one Chromium (D9). */
export const PLAYWRIGHT_MCP_SERVER = {
  command: "playwright-mcp",
  args: ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated"],
}

/** One Claude process at a time across filing runs and classify jobs (D7). */
export interface ClaudeGate {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function makeClaudeGate(): ClaudeGate {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run(task) {
      const turn = tail.then(task)
      tail = turn.catch(() => undefined)
      return turn
    },
  }
}

export interface ClaudeDeps {
  runner: FilerRunner
  gate: ClaudeGate
  log: FilerLog
}

/**
 * `--tools` and `--mcp-config` take several values each, so a prompt after them would be read as one:
 * every prompt goes on stdin, and the argv holds flags and their values only.
 */
export function filingRunArgs(model: string, mcpConfig: string): string[] {
  return [
    ...["claude", "-p", "--output-format", "json", "--model", model],
    ...["--append-system-prompt-file", `${PLAYBOOK_DIR}/filing.md`],
    ...["--tools", "Bash,Read,Write,Edit,Glob,Grep", "--dangerously-skip-permissions"],
    ...["--strict-mcp-config", "--mcp-config", mcpConfig],
  ]
}

/** No tools at all, no MCP server and no permission bypass: classify only reads the text it is given. */
export function classifyArgs(model: string): string[] {
  return [
    ...["claude", "-p", "--output-format", "json", "--model", model],
    ...["--append-system-prompt-file", `${PLAYBOOK_DIR}/classify.md`],
    ...["--tools", "", "--strict-mcp-config"],
  ]
}

export interface ClaudeCall {
  args: string[]
  stdin: string
  cwd: string
  run?: { dir: string; host: string }
  timeoutMs: number
}

/** A Claude process as filer, in its turn at the gate, on a filer home emptied of the last run's state. */
export function runClaude(deps: ClaudeDeps, call: ClaudeCall): Promise<ClaudeOutcome> {
  return deps.gate.run(async () => {
    await cleanClaudeHome(deps.runner, deps.log)
    const exit = await runAsFiler(deps.runner, {
      args: call.args,
      stdin: call.stdin,
      cwd: call.cwd,
      timeoutMs: call.timeoutMs,
      stdoutMaxBytes: OUTPUT_MAX_BYTES,
      ...(call.run !== undefined ? { run: call.run } : {}),
    })
    return claudeOutcome(exit)
  })
}
